import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { validatePackage, type Manifest, type Platform } from '@harness-store/manifest';
import { DirectorySource } from '@harness-store/manifest/node';
import type {
  FolderInspection,
  InstalledHarness,
  InstalledVersion,
  IpcResult,
  ManifestSummary,
} from '../../shared/ipc.js';
import { entryFor, harnessPaths, isInside, type HarnessPaths } from './harness-paths.js';
import type { InstallRow, InstallStore } from './install-store.js';
import { fail, ok } from './ipc-result.js';

/** The installer as the IPC handlers use it. */
export interface InstallsService {
  /** The OS folder picker; the chosen folder, or null when cancelled. */
  chooseFolder(): Promise<string | null>;
  /** Validates a Harness folder without writing anything. */
  inspectFolder(path: string): Promise<IpcResult<FolderInspection>>;
  /** Validates a Harness folder again, copies it into the install layout and records it. */
  installFromFolder(path: string): Promise<IpcResult<InstalledVersion>>;
  /** Every installed Harness, the most recently launched first, then by name. */
  list(): Promise<readonly InstalledHarness[]>;
}

export interface InstallerOptions {
  readonly store: InstallStore;
  /** The app data root: `harnesses/`, `data/` and `downloads/` are made under it. */
  readonly root: string;
  /** This machine's platform as the Manifest names it; null when no Manifest can declare it. */
  readonly platform: Platform | null;
  /** The OS folder picker (Electron's `dialog`); resolves null when the User cancels. */
  readonly pickFolder: () => Promise<string | null>;
  /** Whether the Harness has a launch that has not ended; it is never installed over then. */
  readonly isRunning?: (harnessId: string) => boolean;
  /** Told after an install replaced what `list` returns. */
  readonly onChanged?: (harnessId: string) => void;
  /** The clock of `installed_at`. Default: the system clock. */
  readonly now?: () => Date;
  /** Reports a cleanup that failed after an install was recorded. Default: `console.error`. */
  readonly logError?: (message: string, error: unknown) => void;
}

/**
 * The Runtime's installer for local folders ("Install this folder locally", docs/ux/flows.md F5):
 * the Publisher's way to run their own Harness exactly as Users will, before publishing.
 *
 * The renderer inspects the folder first (`inspectFolder`), shows its problems or the consent
 * dialog, and only after the User consented calls `installFromFolder`. That validates the folder
 * again, as it may have changed in between: a folder that no longer validates, or whose Manifest is
 * not the one last inspected, is refused with `package_invalid` and nothing is written. Then:
 *
 * 1. Exactly the files of the validated listing are copied into a new folder under `downloads/`,
 *    each opened without following a link that replaced it since it was listed. Binary Entries of
 *    every declared platform are made executable (macOS and Linux).
 * 2. That folder is renamed to `harnesses/<publisher>/<slug>/<version>/`. The same version already
 *    installed is replaced; the row is switched to the new version; another version's folder is
 *    deleted after the row no longer names it. One version per Harness is installed.
 * 3. The Data Directory is created if it is missing; a reinstall never touches its content.
 * 4. The `installs` row is written with `source = 'local'` (also over a Store install of the same
 *    Harness ID) and the Declared Permissions as consented.
 *
 * Installs run one at a time. A failure at any step up to writing the row removes what that
 * install created and leaves the previous install as it was. Once the row is written the install
 * has succeeded: deleting the replaced folders and creating the Data Directory are best effort
 * (a failure is logged; a launch creates a missing Data Directory again).
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
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const validateFolder = async (path: string) => {
    let source: DirectorySource;
    try {
      source = await DirectorySource.open(path);
    } catch {
      return null;
    }
    // Local installs are the Publisher's own tests: no publisher or published-version check, so
    // "Install this folder locally" works signed out and offline.
    return { source, result: await validatePackage(source) };
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
        if (options.isRunning?.(harnessId) === true) return fail('harness_running');

        const target = paths.installPath(harnessId, manifest.version);
        const staging = join(paths.downloads, `install-${randomUUID()}`);
        try {
          try {
            await copyListedFiles(source, staging);
          } catch (error) {
            if (error instanceof FolderChangedError) return fail('package_invalid');
            throw error;
          }
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
                source: 'local',
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
      }),

    async list() {
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
  };
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
    list: () => Promise.resolve([]),
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

/**
 * Copies every file of the validated listing (and nothing else: no ignore list) into `target`.
 * Each file is opened without following a symbolic link, as `DirectorySource.readFile` does, and
 * must still be a regular file: a file removed, or replaced by a link, since validation throws
 * {@link FolderChangedError}.
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
 * package made on Windows still launches on macOS and Linux. Windows has no such bit.
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
    aside = join(paths.downloads, `replaced-${randomUUID()}`);
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The installed `assets/icon.png` as a `data:` URL; null when it cannot be read. */
async function readIcon(installPath: string): Promise<string | null> {
  try {
    const bytes = await readFile(join(installPath, 'assets', 'icon.png'));
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}
