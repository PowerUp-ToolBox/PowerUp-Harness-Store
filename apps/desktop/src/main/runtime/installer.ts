import { randomUUID } from 'node:crypto';
import { constants, createWriteStream, type Dirent } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  diffForReconsent,
  PackageReadError,
  validatePackage,
  type Manifest,
  type Platform,
} from '@harness-store/manifest';
import { DirectorySource, openArchiveFile } from '@harness-store/manifest/node';
import semver from 'semver';
import type {
  DownloadProgress,
  FolderInspection,
  InstalledHarness,
  InstalledVersion,
  InstallSource,
  IpcResult,
  ManifestSummary,
  StoreInstallRequest,
  StoreUpdateRequest,
} from '../../shared/ipc.js';
import { entryFor, harnessPaths, isInside, type HarnessPaths } from './harness-paths.js';
import type { InstallRow, InstallStore } from './install-store.js';
import { fail, ok } from './ipc-result.js';
import type { PackageTicket, StoreDownloader } from './store-download.js';

/**
 * The `downloads/` entries of an install: its copy of the Harness files, the folder it replaces,
 * and the Harness Package a Store install downloaded (`download-<jobId>.zip`).
 */
const STAGING_PREFIX = 'install-';
const ASIDE_PREFIX = 'replaced-';
const DOWNLOAD_PREFIX = 'download-';

/**
 * How long the launch logs of an uninstalled Harness are kept: 30 days from the uninstall, and
 * from when each was written.
 */
export const UNINSTALLED_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The file an uninstall writes in the Harness's logs folder, holding when it was uninstalled (an
 * ISO 8601 time), so its logs are kept 30 days from then. Not a `.log`, so no launch log counts it.
 */
export const UNINSTALLED_AT_FILE = 'uninstalled-at';

/** The installer as the IPC handlers use it. */
export interface InstallsService {
  /** The OS folder picker; the chosen folder, or null when cancelled. */
  chooseFolder(): Promise<string | null>;
  /** Validates a Harness folder without writing anything. */
  inspectFolder(path: string): Promise<IpcResult<FolderInspection>>;
  /** Validates a Harness folder again, copies it into the install layout and records it. */
  installFromFolder(path: string): Promise<IpcResult<InstalledVersion>>;
  /**
   * Downloads the Harness's latest version from the Store and verifies it, up to the consent
   * dialog: what it shows, once the package waits for consent.
   */
  install(request: StoreInstallRequest): Promise<IpcResult<ManifestSummary>>;
  /** Installs the package of a job waiting for consent: the User consented. */
  confirm(jobId: string): Promise<IpcResult<InstalledVersion>>;
  /**
   * Updates a Store install to the version the update prompt showed: downloads and verifies it,
   * refuses it without `reconsented` when it needs the User's consent again, then puts it in
   * place of the installed version.
   */
  update(request: StoreUpdateRequest): Promise<IpcResult<InstalledVersion>>;
  /** Cancels a job that downloads or waits for consent; nothing for any other. */
  cancel(jobId: string): Promise<void>;
  /**
   * Cancels every job that downloads or waits for consent: the main window's page, which alone
   * knows their job IDs, is gone or loads again, so nothing would ever confirm or cancel them.
   */
  cancelAll(): Promise<void>;
  /**
   * Uninstalls a Harness (docs/ux/flows.md F9): deletes its install folder, then its Data
   * Directory, then its row with its Model Overrides. Its launch logs and Usage Records are kept.
   */
  uninstall(harnessId: string): Promise<IpcResult<null>>;
  /** The size in bytes of the files in the Harness's Data Directory; 0 when it is missing. */
  dataSize(harnessId: string): Promise<IpcResult<number>>;
  /** Every installed Harness, the most recently launched first, then by name. */
  list(): Promise<readonly InstalledHarness[]>;
  /**
   * Records that the User confirmed "Launch anyway" for an installed Harness the update check
   * found taken down, so the confirmation is not shown again for this Takedown; nothing changes
   * for one that is not taken down.
   */
  acknowledgeTakedown(harnessId: string): Promise<IpcResult<null>>;
  /**
   * Whether an install of the Harness is copying or putting its files in place now, or an
   * uninstall is deleting them: the Supervisor launches nothing from a folder that is about to be
   * replaced or deleted.
   */
  isInstalling(harnessId: string): boolean;
}

export interface InstallerOptions {
  readonly store: InstallStore;
  /** The app data root: `harnesses/`, `data/` and `downloads/` are made under it. */
  readonly root: string;
  /** This machine's platform as the Manifest names it; null when no Manifest can declare it. */
  readonly platform: Platform | null;
  /** The OS folder picker (Electron's `dialog`); resolves null when the User cancels. */
  readonly pickFolder: () => Promise<string | null>;
  /**
   * Whether the Harness has a launch that has not ended; it is never installed over then. Checked
   * in the same step that marks the install in progress ({@link InstallsService.isInstalling}),
   * so no launch can start in between.
   */
  readonly isRunning?: (harnessId: string) => boolean;
  /** Told after an install replaced what `list` returns. */
  readonly onChanged?: (harnessId: string) => void;
  /**
   * Clears what a web Harness's page kept in its browser session (cookies, localStorage, caches;
   * Electron keeps it outside the Data Directory), called once its uninstall is done.
   */
  readonly clearHarnessSession?: (harnessId: string) => Promise<void>;
  /** The Store's `download` function and the transfer; without it Store installs are refused. */
  readonly downloader?: StoreDownloader;
  /** Told how far a Store install's download is (`progress:<jobId>`). */
  readonly onProgress?: (jobId: string, progress: DownloadProgress) => void;
  /** Told when the Store did not answer, so connectivity is checked again. */
  readonly onStoreUnreachable?: () => void;
  /** The clock of `installed_at`. Default: the system clock. */
  readonly now?: () => Date;
  /** Reports a cleanup that failed after an install was recorded. Default: `console.error`. */
  readonly logError?: (message: string, error: unknown) => void;
}

/**
 * The Runtime's installer. One install code path with two entry points, which differ only in
 * where the files come from:
 *
 * - **A local folder** ("Install this folder locally", docs/ux/flows.md F5): the Publisher's way
 *   to run their own Harness exactly as Users will, before publishing. The renderer inspects the
 *   folder first (`inspectFolder`), shows its problems or the consent dialog, and only after the
 *   User consented calls `installFromFolder`. That validates the folder again, as it may have
 *   changed in between: a folder that no longer validates, or whose Manifest is not the one last
 *   inspected, is refused with `package_invalid` and nothing is written. The files of the
 *   validated listing are then copied, each opened without following a link that replaced it
 *   since it was listed.
 * - **The Store** (flows F2): `install` calls the Store's `download` function for the latest
 *   version on this platform, writes the Harness's `installs` row in a transient state
 *   (`downloading`, `verifying`, `awaiting_consent`, then `unpacking`), and streams the Harness
 *   Package to `downloads/download-<jobId>.zip`. The package must have the size and SHA-256 the
 *   Store reported (`checksum_mismatch`), validate with `validatePackage` (archive safety
 *   included: no links, special files, `..` or absolute names) and hold the Manifest the Store
 *   answered with, as JSON values (`integrity_error`). Only then does it answer the consent
 *   dialog's facts. `confirm` (the User consented) unpacks the files of the validated listing,
 *   each read whole so its CRC-32 is checked; `cancel` discards the download. A failed or
 *   cancelled Store install deletes its row and its download, so nothing is left behind.
 *
 * A Store install is updated (flows F4) by `update`, with the same download and checks for the
 * version the update prompt showed. Its row stays `installed` throughout, so the installed version
 * stays launchable until the new one is in place: a failed or cancelled update deletes its
 * download and changes nothing else. Before unpacking, the new Manifest is compared with the
 * installed one (`diffForReconsent`, the one definition of "widened"): an update that widens the
 * Declared Permissions or changes the Entry or the runtime kind needs `reconsented`, else it is
 * refused with `reconsent_required`. The installed Manifest is the one the User consented to, as
 * every install records its permissions as consented.
 *
 * Then, alike for all three:
 *
 * 1. Binary Entries of every declared platform are made executable (macOS and Linux).
 * 2. The files are renamed from their folder under `downloads/` to
 *    `harnesses/<publisher>/<slug>/<version>/`. The same version already installed is replaced;
 *    the row is switched to the new version; another version's folder is deleted after the row
 *    no longer names it. One version per Harness is installed.
 * 3. The `installs` row is written, `installed`, with its `source` (`local` also over a Store
 *    install of the same Harness ID) and the Declared Permissions as consented.
 * 4. The Data Directory is created if it is missing; a reinstall never touches its content.
 *
 * Installs run one at a time from step 1, and never while the Harness runs: from the check that it
 * does not run until the install is done, {@link InstallsService.isInstalling} answers true and the
 * Supervisor launches nothing of it. Downloads run side by side, one per Harness: a Harness with a
 * Store install under way is refused another (`harness_installing`), and so is a folder install of
 * it. A Store install is never made over an installed Harness (`invalid_input`). A failure at any
 * step up to writing the row removes what that install created and leaves the previous install as
 * it was. Once the row is written the install has succeeded: deleting the replaced folders, the
 * download and creating the Data Directory are best effort (a failure is logged; a launch creates
 * a missing Data Directory again).
 *
 * A file of the listing the User's account cannot open (left by another user, or with no read
 * permission) is refused with `file_unreadable`, naming it: it is still there when inspected
 * again, so it is never reported as a folder that changed.
 *
 * `uninstall` (flows F9) is refused while the Harness runs (`harness_running`) and while an install
 * or update of it is under way (`harness_installing`); from that check until it is done the
 * Harness counts as installing, so nothing launches it. It deletes the install folder, then the
 * Data Directory (neither ever followed through a link), then the row and the Harness's Model
 * Overrides in one transaction: a failure partway leaves the row, and uninstalling again finishes
 * the job, as a folder already gone counts as deleted. A web Harness's browser session is then
 * cleared (best effort). The launch logs and Usage Records stay, and the time of the uninstall is
 * written beside the logs ({@link UNINSTALLED_AT_FILE}).
 *
 * An install the app quit or crashed in leaves its row in a transient state and its files in
 * `downloads/`. Before the first install or listing, the installer deletes those rows, puts back
 * a folder moved aside whose install is missing, then deletes what the interrupted installs left
 * there (see {@link recoverInterruptedInstalls}). It then deletes the launch logs of Harnesses
 * uninstalled over 30 days ago that are older than 30 days ({@link pruneUninstalledLogs}).
 */
export function createInstaller(options: InstallerOptions): InstallsService {
  const { store, platform } = options;
  const paths = harnessPaths(options.root);
  const now = options.now ?? (() => new Date());
  const logError =
    options.logError ??
    ((message: string, error: unknown) => {
      console.error(message, error);
    });
  /** The Manifest each folder showed when last inspected, as JSON, by path. */
  const inspected = new Map<string, string>();
  /** The icons read so far, by install path: an installed version's files never change. */
  const icons = new Map<string, string | null>();
  /** The Harnesses whose install is past its checks and not done yet. */
  const installing = new Set<string>();
  /** The Store installs and updates under way, by job ID. */
  const jobs = new Map<string, StoreJob>();
  const recovered = recoverInterruptedInstalls(paths, store, logError).then(() =>
    pruneUninstalledLogs(paths.logs, (harnessId) => store.get(harnessId) !== undefined, now()),
  );
  let queue: Promise<unknown> = recovered;
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const validateFolder = async (path: string) => {
    // A folder, or a file validation reads (manifest.json, the icon), that cannot be read or is
    // gone by the time it is read: `validatePackage` throws the I/O error. It answers
    // `package_invalid`, as a folder that cannot be listed does.
    try {
      const source = await DirectorySource.open(path);
      // Local installs are the Publisher's own tests: no publisher or published-version check, so
      // "Install this folder locally" works signed out and offline.
      return { source, result: await validatePackage(source) };
    } catch {
      return null;
    }
  };

  /**
   * Whether a Store install or update of the Harness is under way: a job, or a transient row.
   */
  const storeInstallUnderWay = (harnessId: string) =>
    [...jobs.values()].some((job) => job.harnessId === harnessId) ||
    (store.stateOf(harnessId) ?? 'installed') !== 'installed';

  /**
   * Why a Store install of the Harness cannot begin now, or null: one is under way, or an install
   * is putting files in place (`harness_installing`); it is installed (`invalid_input`).
   */
  const storeInstallRefusal = (harnessId: string) => {
    if (storeInstallUnderWay(harnessId) || installing.has(harnessId)) {
      return fail('harness_installing');
    }
    if (store.stateOf(harnessId) === 'installed') {
      return fail('invalid_input', { method: 'installs.install' });
    }
    return null;
  };

  /**
   * Steps 1 to 4 of an install that passed its checks (see {@link createInstaller}): `fill` puts
   * the Harness's files into the new staging folder, or answers why it could not.
   */
  const placeAndRecord = async (
    harnessId: string,
    manifest: Manifest,
    source: InstallSource,
    fill: (staging: string) => Promise<IpcResult<null>>,
  ): Promise<IpcResult<InstalledVersion>> => {
    const target = paths.installPath(harnessId, manifest.version);
    const staging = join(paths.downloads, `${STAGING_PREFIX}${randomUUID()}`);
    try {
      const filled = await fill(staging);
      if (!filled.ok) return filled;
      await makeEntriesExecutable(manifest, staging);
      const replaced = await putInPlace(paths, {
        staging,
        target,
        previous: store.get(harnessId),
        record: () => {
          store.put({
            harnessId,
            version: manifest.version,
            manifest,
            installPath: target,
            dataDir: paths.dataDir(harnessId),
            installedAt: now().toISOString(),
            consentedPermissions: manifest.permissions,
            source,
          });
        },
      });
      // The row is written: from here on nothing undoes or fails the install.
      for (const folder of replaced) {
        await rm(folder, { recursive: true, force: true }).catch((error: unknown) => {
          logError(`Could not delete the replaced install folder ${folder}`, error);
        });
      }
      await mkdir(paths.dataDir(harnessId), { recursive: true }).catch((error: unknown) => {
        logError(`Could not create the Data Directory of ${harnessId}`, error);
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    icons.delete(target);
    options.onChanged?.(harnessId);
    return ok({ harnessId, version: manifest.version });
  };

  /**
   * Ends a Store install that did not succeed (or whose download is done with): forgets the job,
   * deletes its transient row, if any, then its download. The row goes first, in the same step as
   * the job, so a new install of the Harness can begin at once.
   */
  const discard = async (jobId: string, job: StoreJob) => {
    if (jobs.get(jobId) === job) jobs.delete(jobId);
    try {
      store.deleteTransient(job.harnessId);
    } catch (error) {
      // The database closed (the app quits): the next start deletes the row.
      logError(`Could not delete the install row of ${job.harnessId}`, error);
    }
    await rm(job.file, { force: true }).catch((error: unknown) => {
      logError(`Could not delete the download ${job.file}`, error);
    });
  };

  /** A Store answer that did not come: connectivity is checked again. */
  const reported = <T>(result: IpcResult<T>): IpcResult<T> => {
    if (!result.ok && result.error.code === 'store_unreachable') options.onStoreUnreachable?.();
    return result;
  };

  /**
   * Streams the ticket's package into the job's download, reporting progress, and checks its size
   * and SHA-256 against the ticket's.
   */
  const transfer = async (
    downloader: StoreDownloader,
    jobId: string,
    job: StoreJob,
    ticket: PackageTicket,
  ): Promise<IpcResult<null>> => {
    await mkdir(paths.downloads, { recursive: true });
    return reported(
      await downloader.fetchPackage(ticket, job.file, {
        signal: job.controller.signal,
        onProgress: (received) => options.onProgress?.(jobId, { received, total: ticket.size }),
      }),
    );
  };

  /** The download and checks of a Store install, up to `awaiting_consent`. */
  const download = async (
    downloader: StoreDownloader,
    machine: Platform,
    jobId: string,
    job: StoreJob,
  ): Promise<IpcResult<ManifestSummary>> => {
    const { harnessId, controller } = job;
    const cancelled = () => controller.signal.aborted;
    const ticket = reported(
      await downloader.ticket({ harnessId, version: null, platform: machine }, controller.signal),
    );
    if (!ticket.ok) return ticket;
    if (cancelled()) return fail('download_cancelled');
    const { manifest } = ticket.data;
    // A folder install of the Harness may have begun meanwhile.
    if (installing.has(harnessId) || store.stateOf(harnessId) !== undefined) {
      return fail(
        store.stateOf(harnessId) === 'installed' ? 'invalid_input' : 'harness_installing',
      );
    }
    store.begin({
      harnessId,
      version: manifest.version,
      manifest,
      installPath: paths.installPath(harnessId, manifest.version),
      dataDir: paths.dataDir(harnessId),
      installedAt: now().toISOString(),
      consentedPermissions: manifest.permissions,
      source: 'store',
    });
    const fetched = await transfer(downloader, jobId, job, ticket.data);
    if (!fetched.ok) return fetched;
    store.setState(harnessId, 'verifying');
    if (!(await holdsManifest(job.file, manifest))) return fail('integrity_error');
    // Verifying is not interrupted: a Cancel meanwhile is honoured here.
    if (cancelled()) return fail('download_cancelled');
    store.setState(harnessId, 'awaiting_consent');
    job.phase = 'awaiting_consent';
    job.manifest = manifest;
    return ok(summarize(manifest, platform));
  };

  /**
   * The download, checks and swap of an update (see {@link createInstaller}): `installed` is the
   * row when the update began, and is still the installed version when the swap begins.
   */
  const updateTo = async (
    downloader: StoreDownloader,
    machine: Platform,
    request: StoreUpdateRequest,
    installed: InstallRow,
    job: StoreJob,
  ): Promise<IpcResult<InstalledVersion>> => {
    const { harnessId, version, jobId } = request;
    const cancelled = () => job.controller.signal.aborted;
    const ticket = reported(
      await downloader.ticket({ harnessId, version, platform: machine }, job.controller.signal),
    );
    if (!ticket.ok) return ticket;
    if (cancelled()) return fail('download_cancelled');
    const fetched = await transfer(downloader, jobId, job, ticket.data);
    if (!fetched.ok) return fetched;
    const { manifest } = ticket.data;
    if (!(await holdsManifest(job.file, manifest))) return fail('integrity_error');
    if (cancelled()) return fail('download_cancelled');
    if (diffForReconsent(installed.manifest, manifest).required && !request.reconsented) {
      return fail('reconsent_required');
    }
    job.phase = 'unpacking';
    return oneAtATime(async () => {
      // No await between these checks and marking the install in progress (see installFromFolder).
      const current = store.get(harnessId);
      if (current === undefined) return fail('not_installed');
      if (current.version !== installed.version || current.source !== 'store') {
        // Another install of it came first: what was compared is no longer what is installed.
        return fail('invalid_input', { method: 'installs.update' });
      }
      if (options.isRunning?.(harnessId) === true) return fail('harness_running');
      installing.add(harnessId);
      try {
        return await placeAndRecord(harnessId, manifest, 'store', (staging) =>
          unpackArchive(job.file, staging),
        );
      } finally {
        installing.delete(harnessId);
      }
    });
  };

  /** `cancel`: a job being unpacked is past consent and finishes on its own. */
  const cancel = async (jobId: string) => {
    const job = jobs.get(jobId);
    if (job === undefined) return;
    if (job.phase === 'downloading') {
      // `install` sees it, answers `download_cancelled` and discards the job.
      job.controller.abort();
    } else if (job.phase === 'awaiting_consent') {
      job.controller.abort();
      await discard(jobId, job);
    }
  };

  return {
    chooseFolder: () => options.pickFolder(),

    async inspectFolder(path) {
      const validated = await validateFolder(path);
      if (validated === null) return fail('package_invalid');
      const { result } = validated;
      if (!result.ok) {
        inspected.delete(path);
        return ok({
          valid: false,
          manifestSummary: null,
          problems: result.problems,
          warnings: result.warnings,
        });
      }
      inspected.set(path, JSON.stringify(result.manifest));
      return ok({
        valid: true,
        manifestSummary: summarize(result.manifest, platform),
        problems: [],
        warnings: result.warnings,
      });
    },

    installFromFolder: (path) =>
      oneAtATime(async () => {
        const validated = await validateFolder(path);
        if (validated?.result.ok !== true) return fail('package_invalid');
        const { source } = validated;
        const { manifest } = validated.result;
        const shown = inspected.get(path);
        if (shown !== undefined && shown !== JSON.stringify(manifest)) {
          return fail('package_invalid');
        }
        const harnessId = manifest.id;
        // No await between these checks and marking the install in progress: a launch, or a
        // Store install, starting from then on is refused until it is done.
        if (storeInstallUnderWay(harnessId)) return fail('harness_installing');
        if (options.isRunning?.(harnessId) === true) return fail('harness_running');
        installing.add(harnessId);
        try {
          return await placeAndRecord(harnessId, manifest, 'local', async (staging) => {
            try {
              await copyListedFiles(source, staging);
            } catch (error) {
              if (error instanceof FileUnreadableError) {
                return fail('file_unreadable', { path: error.file });
              }
              if (error instanceof FolderChangedError) return fail('package_invalid');
              throw error;
            }
            return ok(null);
          });
        } finally {
          installing.delete(harnessId);
        }
      }),

    async install({ harnessId, jobId }) {
      await recovered;
      if (jobs.has(jobId)) return fail('invalid_input', { method: 'installs.install' });
      const refusal = storeInstallRefusal(harnessId);
      if (refusal !== null) return refusal;
      const { downloader } = options;
      if (downloader === undefined) {
        return fail('not_implemented', { method: 'installs.install' });
      }
      // The Store makes a package for the platforms a Manifest can declare only.
      if (platform === null) return fail('platform_not_supported');
      const job: StoreJob = {
        harnessId,
        controller: new AbortController(),
        file: join(paths.downloads, `${DOWNLOAD_PREFIX}${jobId}.zip`),
        phase: 'downloading',
        manifest: null,
      };
      jobs.set(jobId, job);
      let result: IpcResult<ManifestSummary> | undefined;
      try {
        result = await download(downloader, platform, jobId, job);
        return result;
      } finally {
        // A job cancelled while it was being verified waits for nothing.
        if (result?.ok !== true || job.controller.signal.aborted) await discard(jobId, job);
      }
    },

    async confirm(jobId) {
      const job = jobs.get(jobId);
      const manifest = job?.manifest ?? null;
      if (job?.phase !== 'awaiting_consent' || manifest === null) {
        return fail('invalid_input', { method: 'installs.confirm' });
      }
      const { harnessId } = job;
      job.phase = 'unpacking';
      store.setState(harnessId, 'unpacking');
      try {
        return await oneAtATime(async () => {
          // No await between the check and marking the install in progress (see installFromFolder).
          if (options.isRunning?.(harnessId) === true) return fail('harness_running');
          installing.add(harnessId);
          try {
            return await placeAndRecord(harnessId, manifest, 'store', (staging) =>
              unpackArchive(job.file, staging),
            );
          } finally {
            installing.delete(harnessId);
          }
        });
      } finally {
        // Installed (the row is no longer transient, so it is kept) or failed: either way the
        // download is done with.
        await discard(jobId, job);
      }
    },

    async update(request) {
      await recovered;
      const { harnessId, version, jobId } = request;
      if (jobs.has(jobId)) return fail('invalid_input', { method: 'installs.update' });
      const installed = store.get(harnessId);
      if (storeInstallUnderWay(harnessId) || installing.has(harnessId)) {
        return fail('harness_installing');
      }
      if (installed === undefined) return fail('not_installed');
      // Only a newer version of a Store install: a local install never gets Store updates.
      if (
        installed.source !== 'store' ||
        semver.valid(version) === null ||
        !semver.gt(version, installed.version)
      ) {
        return fail('invalid_input', { method: 'installs.update' });
      }
      // Refused at once while it runs; a launch may start during the download, so the swap checks
      // again.
      if (options.isRunning?.(harnessId) === true) return fail('harness_running');
      const { downloader } = options;
      if (downloader === undefined) {
        return fail('not_implemented', { method: 'installs.update' });
      }
      if (platform === null) return fail('platform_not_supported');
      const job: StoreJob = {
        harnessId,
        controller: new AbortController(),
        file: join(paths.downloads, `${DOWNLOAD_PREFIX}${jobId}.zip`),
        phase: 'downloading',
        manifest: null,
      };
      jobs.set(jobId, job);
      try {
        return await updateTo(downloader, platform, request, installed, job);
      } finally {
        // Updated, failed or cancelled: the download is done with, and the row was never
        // transient, so it is kept.
        await discard(jobId, job);
      }
    },

    cancel,

    async cancelAll() {
      await Promise.all([...jobs.keys()].map((jobId) => cancel(jobId)));
    },

    uninstall: (harnessId) =>
      oneAtATime(async () => {
        // No await between these checks and marking the Harness installing (see
        // installFromFolder): a launch, an install or an update asked for from then on is refused.
        const row = store.get(harnessId);
        if (storeInstallUnderWay(harnessId) || installing.has(harnessId)) {
          return fail('harness_installing');
        }
        if (row === undefined) return fail('not_installed');
        if (options.isRunning?.(harnessId) === true) return fail('harness_running');
        installing.add(harnessId);
        try {
          // Only folders of the install layout are ever deleted, whatever the row says.
          if (isInside(paths.harnesses, row.installPath)) {
            await rm(row.installPath, { recursive: true, force: true });
            await removeEmptyFolders(dirname(row.installPath), paths.harnesses);
          }
          if (isInside(paths.data, row.dataDir)) {
            await rm(row.dataDir, { recursive: true, force: true });
            await removeEmptyFolders(dirname(row.dataDir), paths.data);
          }
          store.remove(harnessId);
        } finally {
          installing.delete(harnessId);
        }
        icons.delete(row.installPath);
        try {
          await options.clearHarnessSession?.(harnessId);
        } catch (error) {
          logError(`Could not clear the browser session of ${harnessId}`, error);
        }
        await markLogsUninstalled(paths.logsDir(harnessId), now(), logError);
        options.onChanged?.(harnessId);
        return ok(null);
      }),

    async dataSize(harnessId) {
      await recovered;
      const row = store.get(harnessId);
      if (row === undefined) return fail('not_installed');
      return ok(await directorySize(row.dataDir));
    },

    async list() {
      await recovered;
      const rows = store.all().sort(byRecentUseThenName);
      return Promise.all(
        rows.map(async (row): Promise<InstalledHarness> => {
          let icon = icons.get(row.installPath);
          if (icon === undefined) {
            icon = await readIcon(row.installPath);
            icons.set(row.installPath, icon);
          }
          return {
            harnessId: row.harnessId,
            version: row.version,
            name: row.manifest.name,
            publisher: row.harnessId.split('/')[0] ?? row.harnessId,
            source: row.source,
            manifest: row.manifest,
            installPath: row.installPath,
            installedAt: row.installedAt,
            lastLaunchedAt: row.lastLaunchedAt,
            iconDataUrl: icon,
            platformSupported: entryFor(row.manifest, platform) !== null,
            storeStatus: row.storeStatus,
            takedownAcknowledged: row.takedownAcknowledged,
            availableUpdate:
              row.availableVersion === null || row.availableManifest === null
                ? null
                : { version: row.availableVersion, manifest: row.availableManifest },
          };
        }),
      );
    },

    async acknowledgeTakedown(harnessId) {
      await recovered;
      if (store.get(harnessId) === undefined) return fail('not_installed');
      if (store.acknowledgeTakedown(harnessId)) options.onChanged?.(harnessId);
      return ok(null);
    },

    isInstalling: (harnessId) => installing.has(harnessId),
  };
}

/** A Store install or update under way; an update is never `awaiting_consent`. */
interface StoreJob {
  readonly harnessId: string;
  /** Aborted by `cancel`. */
  readonly controller: AbortController;
  /** Its download, `downloads/download-<jobId>.zip`. */
  readonly file: string;
  phase: 'downloading' | 'awaiting_consent' | 'unpacking';
  /** The Store's Manifest, verified against the package; set once it waits for consent. */
  manifest: Manifest | null;
}

/**
 * Installs without a database, when the Runtime could not open it: the window shows only its
 * startup error screen, so nothing is installed and installing answers `not_implemented`.
 */
export function createInstallsStub(): InstallsService {
  return {
    chooseFolder: () => Promise.resolve(null),
    inspectFolder: () =>
      Promise.resolve(fail('not_implemented', { method: 'installs.inspectFolder' })),
    installFromFolder: () =>
      Promise.resolve(fail('not_implemented', { method: 'installs.installFromFolder' })),
    install: () => Promise.resolve(fail('not_implemented', { method: 'installs.install' })),
    confirm: () => Promise.resolve(fail('not_implemented', { method: 'installs.confirm' })),
    update: () => Promise.resolve(fail('not_implemented', { method: 'installs.update' })),
    cancel: () => Promise.resolve(),
    cancelAll: () => Promise.resolve(),
    uninstall: () => Promise.resolve(fail('not_implemented', { method: 'installs.uninstall' })),
    dataSize: () => Promise.resolve(fail('not_implemented', { method: 'installs.dataSize' })),
    list: () => Promise.resolve([]),
    acknowledgeTakedown: () =>
      Promise.resolve(fail('not_implemented', { method: 'installs.acknowledgeTakedown' })),
    isInstalling: () => false,
  };
}

/** The consent dialog's facts of a valid Manifest. */
export function summarize(manifest: Manifest, platform: Platform | null): ManifestSummary {
  const declared = platform !== null && manifest.platforms.includes(platform);
  return {
    harnessId: manifest.id,
    version: manifest.version,
    name: manifest.name,
    runtimeKind: manifest.runtime.kind,
    uiKind: manifest.ui.kind,
    workspace: manifest.workspace ?? 'none',
    platforms: manifest.platforms,
    entry:
      typeof manifest.entry === 'string'
        ? manifest.entry
        : declared
          ? (manifest.entry[platform] ?? null)
          : null,
    permissions: manifest.permissions,
    platformSupported: entryFor(manifest, platform) !== null,
  };
}

/** Last launched first (never launched last), then by name, then by ID for a stable order. */
function byRecentUseThenName(a: InstallRow, b: InstallRow): number {
  if (a.lastLaunchedAt !== b.lastLaunchedAt) {
    if (a.lastLaunchedAt === null) return 1;
    if (b.lastLaunchedAt === null) return -1;
    return a.lastLaunchedAt < b.lastLaunchedAt ? 1 : -1;
  }
  return (
    a.manifest.name.localeCompare(b.manifest.name, 'en', { sensitivity: 'base' }) ||
    (a.harnessId < b.harnessId ? -1 : a.harnessId > b.harnessId ? 1 : 0)
  );
}

/** A file of the Harness folder is gone, or is no longer a regular file, since validation. */
class FolderChangedError extends Error {
  override name = 'FolderChangedError';
}

/** A file of the Harness folder that the User's account is not allowed to open. */
class FileUnreadableError extends Error {
  override name = 'FileUnreadableError';
  constructor(
    /** The file, relative to the Harness folder, with `/` separators. */
    readonly file: string,
    options: ErrorOptions,
  ) {
    super(`${file} cannot be opened`, options);
  }
}

/**
 * Copies every file of the validated listing (and nothing else: no ignore list) into `target`.
 * Each file is opened without following a symbolic link, as `DirectorySource.readFile` does, and
 * must still be a regular file: a file removed, or replaced by a link, since validation throws
 * {@link FolderChangedError}. A file the OS refuses to open (no permission) throws
 * {@link FileUnreadableError}: validation reads only some files, so it can list one it never opens.
 */
async function copyListedFiles(source: DirectorySource, target: string): Promise<void> {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  for (const file of source.listFiles()) {
    const destination = join(target, ...file.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    let handle: FileHandle;
    try {
      handle = await open(join(source.root, ...file.split('/')), constants.O_RDONLY | noFollow);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM')
        throw new FileUnreadableError(file, { cause: error });
      throw new FolderChangedError(`${file} can no longer be opened`, { cause: error });
    }
    try {
      if (!(await handle.stat()).isFile()) {
        throw new FolderChangedError(`${file} is no longer a file`);
      }
      await pipeline(
        handle.createReadStream({ autoClose: false }),
        createWriteStream(destination, { flags: 'wx' }),
      );
    } finally {
      await handle.close();
    }
  }
}

/**
 * Sets the executable bit (0755) on the Entry of every platform a binary Harness declares, so a
 * Harness Package made on Windows still launches on macOS and Linux. Windows has no such bit.
 */
async function makeEntriesExecutable(manifest: Manifest, folder: string): Promise<void> {
  if (process.platform === 'win32' || typeof manifest.entry === 'string') return;
  const { entry } = manifest;
  for (const platform of manifest.platforms) {
    const path = entry[platform];
    if (path !== undefined) await chmod(join(folder, ...path.split('/')), 0o755);
  }
}

/**
 * Whether the downloaded Harness Package `file` validates (`validatePackage`, with the archive
 * safety rules, and nothing that depends on who publishes) and its Manifest is `manifest`, the
 * Store's, compared as JSON values: the Store keeps it as `jsonb`, so its key order and
 * whitespace are not the file's. The package's SHA-256 is already checked, so the files unpacked
 * later are the ones validated here.
 */
async function holdsManifest(file: string, manifest: Manifest): Promise<boolean> {
  try {
    const result = await validatePackage(await openArchiveFile(file));
    return result.ok && isDeepStrictEqual(result.manifest, manifest);
  } catch {
    return false; // validatePackage throws only what reading the file throws.
  }
}

/**
 * Writes every file of the validated Harness Package `file` into `target`, each created new and
 * streamed a part at a time (so a large or highly compressible file is never held in memory),
 * with its CRC-32 and size checked once it is written: the archive lists only regular files with
 * safe, distinct paths, which validation checked. An entry that cannot be read from the zip
 * answers `integrity_error`, and the caller deletes `target` with whatever was written; anything
 * else (an I/O error) throws.
 */
async function unpackArchive(file: string, target: string): Promise<IpcResult<null>> {
  const archive = await openArchiveFile(file);
  for (const path of archive.listFiles()) {
    const destination = join(target, ...path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    try {
      await pipeline(
        Readable.from(archive.streamFile(path)),
        createWriteStream(destination, { flags: 'wx' }),
      );
    } catch (error) {
      if (error instanceof PackageReadError) return fail('integrity_error');
      throw error;
    }
  }
  return ok(null);
}

/**
 * Moves the copied files from `staging` to `target` and records the install with `record`. The
 * same version already in `target` is moved aside first, and moved back if anything fails. Returns
 * the folders the caller deletes once the row is written: the one moved aside, and the previous
 * install's folder when it is another version.
 *
 * "Another version" is decided by the folder's identity, not by its path: on a case-insensitive
 * file system (macOS, Windows) `1.0.0-beta` and `1.0.0-Beta` are two versions but one folder, so
 * the previous path names the folder just installed.
 */
async function putInPlace(
  paths: HarnessPaths,
  move: {
    readonly staging: string;
    readonly target: string;
    readonly previous: InstallRow | undefined;
    readonly record: () => void;
  },
): Promise<string[]> {
  const { staging, target, previous } = move;
  await mkdir(dirname(target), { recursive: true });
  let aside: string | null = null;
  if (await exists(target)) {
    aside = join(paths.downloads, `${ASIDE_PREFIX}${randomUUID()}`);
    await rename(target, aside);
  }
  try {
    await rename(staging, target);
    try {
      move.record();
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if (aside !== null) await rename(aside, target);
    throw error;
  }
  const replaced = aside === null ? [] : [aside];
  // Only a folder of the install layout is ever deleted, whatever the row says.
  if (
    previous !== undefined &&
    isInside(paths.harnesses, previous.installPath) &&
    !(await sameFolder(previous.installPath, target))
  ) {
    replaced.push(previous.installPath);
  }
  return replaced;
}

/** Whether both paths name one folder (same device and inode); false when either is missing. */
async function sameFolder(a: string, b: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([
      stat(a, { bigint: true }),
      stat(b, { bigint: true }),
    ]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

/**
 * Cleans up after installs the app quit or crashed in, which leave their rows in a transient state
 * and their files in `downloads/`:
 *
 * 0. Every transient `installs` row is deleted: none of those installs is running any more.
 * 1. A folder moved aside (`replaced-*`) holds the files of an installed version while the same
 *    version is reinstalled. When its row's install folder is missing (the app stopped between
 *    moving the old folder aside and moving the new one in, or before moving it back), it is moved
 *    back, so the row names the files it was installed with.
 * 2. Every other `replaced-*` folder, every partial copy (`install-*`) and every Store download
 *    (`download-*`) is deleted. A folder that could not be moved back is kept for the next start.
 *
 * Nothing else in `downloads/` is touched. It never throws: a failure is logged, and an install
 * or listing goes ahead.
 */
async function recoverInterruptedInstalls(
  paths: HarnessPaths,
  store: InstallStore,
  logError: (message: string, error: unknown) => void,
): Promise<void> {
  try {
    store.deleteAllTransient();
  } catch (error) {
    logError('Could not delete the rows of interrupted installs', error);
  }
  let names: string[];
  try {
    names = await readdir(paths.downloads);
  } catch {
    return; // No downloads folder: nothing was ever installed.
  }
  for (const name of names) {
    const folder = join(paths.downloads, name);
    if (name.startsWith(ASIDE_PREFIX)) {
      try {
        const row = await rowOfAside(folder, store);
        if (
          row !== undefined &&
          isInside(paths.harnesses, row.installPath) &&
          !(await exists(row.installPath))
        ) {
          await mkdir(dirname(row.installPath), { recursive: true });
          await rename(folder, row.installPath);
          continue;
        }
      } catch (error) {
        logError(`Could not restore the install folder moved aside to ${folder}`, error);
        continue;
      }
    } else if (!name.startsWith(STAGING_PREFIX) && !name.startsWith(DOWNLOAD_PREFIX)) {
      continue;
    }
    await rm(folder, { recursive: true, force: true }).catch((error: unknown) => {
      logError(`Could not delete the interrupted install folder ${folder}`, error);
    });
  }
}

/** The row whose installed version a folder moved aside holds, by its Manifest's ID and version. */
async function rowOfAside(aside: string, store: InstallStore): Promise<InstallRow | undefined> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(aside, 'manifest.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof manifest !== 'object' || manifest === null) return undefined;
  const { id, version } = manifest as { id?: unknown; version?: unknown };
  if (typeof id !== 'string') return undefined;
  const row = store.get(id);
  return row !== undefined && row.version === version ? row : undefined;
}

/**
 * Writes when the Harness was uninstalled into its logs folder ({@link UNINSTALLED_AT_FILE}),
 * replacing an earlier uninstall's, so {@link pruneUninstalledLogs} keeps its logs 30 days from
 * now. A Harness never launched has no logs folder and gets none. A failure is only logged: the
 * uninstall is done, and its logs are then kept 30 days from when each was written.
 */
async function markLogsUninstalled(
  folder: string,
  at: Date,
  logError: (message: string, error: unknown) => void,
): Promise<void> {
  try {
    if (!(await lstat(folder)).isDirectory()) return;
  } catch {
    return;
  }
  await writeFile(join(folder, UNINSTALLED_AT_FILE), at.toISOString()).catch((error: unknown) => {
    logError(`Could not record the uninstall beside the launch logs in ${folder}`, error);
  });
}

/** When the Harness whose logs are in `folder` was uninstalled; undefined when not recorded. */
async function uninstalledAt(folder: string): Promise<number | undefined> {
  const path = join(folder, UNINSTALLED_AT_FILE);
  try {
    if (!(await lstat(path)).isFile()) return undefined;
    const at = Date.parse((await readFile(path, 'utf8')).trim());
    return Number.isNaN(at) ? undefined : at;
  } catch {
    return undefined;
  }
}

/**
 * Deletes, in the logs folder of every Harness that `isInstalled` says is not installed
 * (`logs/<publisher>/<slug>/`), the launch logs (`*.log`) older than
 * {@link UNINSTALLED_LOG_RETENTION_MS} by when each was last written, once that long has passed
 * since the uninstall ({@link UNINSTALLED_AT_FILE}; a folder without one, e.g. from before it was
 * written, counts from the logs alone). A folder whose logs are all gone loses its uninstall time
 * too, then those folders, and the publishers' folders, left empty are deleted. The logs of
 * installed Harnesses are never touched. Only folders and regular files are looked at, never
 * through a link. It never throws: what cannot be read or deleted is left for the next start.
 */
export async function pruneUninstalledLogs(
  logs: string,
  isInstalled: (harnessId: string) => boolean,
  now: Date,
): Promise<void> {
  const cutoff = now.getTime() - UNINSTALLED_LOG_RETENTION_MS;
  for (const publisher of await entriesOf(logs)) {
    if (!publisher.isDirectory()) continue;
    const publisherFolder = join(logs, publisher.name);
    for (const slug of await entriesOf(publisherFolder)) {
      if (!slug.isDirectory() || isInstalled(`${publisher.name}/${slug.name}`)) continue;
      const folder = join(publisherFolder, slug.name);
      const uninstalled = await uninstalledAt(folder);
      if (uninstalled !== undefined && uninstalled >= cutoff) continue; // Kept 30 days from it.
      let logsLeft = false;
      for (const log of await entriesOf(folder)) {
        if (!log.isFile() || !log.name.endsWith('.log')) continue;
        const path = join(folder, log.name);
        try {
          if ((await lstat(path)).mtimeMs < cutoff) await rm(path, { force: true });
          else logsLeft = true;
        } catch {
          logsLeft = true; // Left for the next start.
        }
      }
      if (!logsLeft)
        await rm(join(folder, UNINSTALLED_AT_FILE), { force: true }).catch(() => undefined);
      await rmdir(folder).catch(() => undefined); // Only when it is empty.
    }
    await rmdir(publisherFolder).catch(() => undefined);
  }
}

/** The entries of `folder`, typed without following links; none when it cannot be read. */
async function entriesOf(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * The size in bytes of the regular files under `folder`, walked without following a link (a
 * link counts for nothing, as deleting it deletes no file it points to); 0 when it is missing or
 * not a folder. A sub-folder that cannot be read counts for nothing.
 */
async function directorySize(folder: string): Promise<number> {
  try {
    if (!(await lstat(folder)).isDirectory()) return 0;
  } catch {
    return 0;
  }
  let total = 0;
  const pending = [folder];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const entry of await entriesOf(current)) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try {
          total += (await lstat(path)).size;
        } catch {
          // Gone since it was listed.
        }
      }
    }
  }
  return total;
}

/**
 * Deletes `folder` and then each parent folder while it is empty, stopping at `base`, which is
 * kept: `harnesses/<publisher>/<slug>/` after its last version is gone, then `<publisher>/`.
 */
async function removeEmptyFolders(folder: string, base: string): Promise<void> {
  for (let current = folder; isInside(base, current); current = dirname(current)) {
    try {
      await rmdir(current);
    } catch {
      return; // Not empty, or already gone.
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The installed `assets/icon.png` as a `data:` URL; null when it cannot be read. */
export async function readIcon(installPath: string): Promise<string | null> {
  try {
    const bytes = await readFile(join(installPath, 'assets', 'icon.png'));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}
