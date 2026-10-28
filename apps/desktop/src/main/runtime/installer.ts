import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  PackageReadError,
  validatePackage,
  type Manifest,
  type Platform,
} from '@harness-store/manifest';
import { DirectorySource, openArchiveFile } from '@harness-store/manifest/node';
import type {
  DownloadProgress,
  FolderInspection,
  InstalledHarness,
  InstalledVersion,
  InstallSource,
  IpcResult,
  ManifestSummary,
  StoreInstallRequest,
} from '../../shared/ipc.js';
import { entryFor, harnessPaths, isInside, type HarnessPaths } from './harness-paths.js';
import type { InstallRow, InstallStore } from './install-store.js';
import { fail, ok } from './ipc-result.js';
import type { StoreDownloader } from './store-download.js';

/**
 * The `downloads/` entries of an install: its copy of the Harness files, the folder it replaces,
 * and the Harness Package a Store install downloaded (`download-<jobId>.zip`).
 */
const STAGING_PREFIX = 'install-';
const ASIDE_PREFIX = 'replaced-';
const DOWNLOAD_PREFIX = 'download-';

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
  /** Cancels a job that downloads or waits for consent; nothing for any other. */
  cancel(jobId: string): Promise<void>;
  /**
   * Cancels every job that downloads or waits for consent: the main window's page, which alone
   * knows their job IDs, is gone or loads again, so nothing would ever confirm or cancel them.
   */
  cancelAll(): Promise<void>;
  /** Every installed Harness, the most recently launched first, then by name. */
  list(): Promise<readonly InstalledHarness[]>;
  /**
   * Whether an install of the Harness is copying or putting its files in place now: the Supervisor
   * launches nothing from a folder that is about to be replaced.
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
 * Then, alike for both:
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
 * An install the app quit or crashed in leaves its row in a transient state and its files in
 * `downloads/`. Before the first install or listing, the installer deletes those rows, puts back
 * a folder moved aside whose install is missing, then deletes what the interrupted installs left
 * there (see {@link recoverInterruptedInstalls}).
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
  /** The Store installs under way, by job ID. */
  const jobs = new Map<string, StoreJob>();
  const recovered = recoverInterruptedInstalls(paths, store, logError);
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

  /** Whether a Store install of the Harness is under way: a job, or a transient row. */
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
    const { manifest, size } = ticket.data;
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
    await mkdir(paths.downloads, { recursive: true });
    const fetched = reported(
      await downloader.fetchPackage(ticket.data, job.file, {
        signal: controller.signal,
        onProgress: (received) => options.onProgress?.(jobId, { received, total: size }),
      }),
    );
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

    cancel,

    async cancelAll() {
      await Promise.all([...jobs.keys()].map((jobId) => cancel(jobId)));
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
          };
        }),
      );
    },

    isInstalling: (harnessId) => installing.has(harnessId),
  };
}

/** A Store install under way. */
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
    cancel: () => Promise.resolve(),
    cancelAll: () => Promise.resolve(),
    list: () => Promise.resolve([]),
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
 * Writes every file of the validated Harness Package `file` into `target`, each read whole (so its
 * CRC-32 and size are checked) and created new: the archive lists only regular files with safe,
 * distinct paths, which validation checked. An entry that cannot be read from the zip answers
 * `integrity_error`; anything else (an I/O error) throws.
 */
async function unpackArchive(file: string, target: string): Promise<IpcResult<null>> {
  const archive = await openArchiveFile(file);
  for (const path of archive.listFiles()) {
    let bytes: Uint8Array;
    try {
      bytes = await archive.readFile(path);
    } catch (error) {
      if (error instanceof PackageReadError) return fail('integrity_error');
      throw error;
    }
    const destination = join(target, ...path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
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
