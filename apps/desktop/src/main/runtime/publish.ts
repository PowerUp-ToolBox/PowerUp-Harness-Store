import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { sep } from 'node:path';
import {
  ArchiveSource,
  PackageReadError,
  validatePackage,
  type Problem,
} from '@harness-store/manifest';
import semver from 'semver';
import type { FolderValidation, IpcResult, VersionCheck } from '../../shared/ipc.js';
import { fail, ok } from './ipc-result.js';
import {
  buildPackage,
  BuildSupersededError,
  EntryUnreadableError,
  FolderChangedError,
  FolderUnreadableError,
} from './package-archive.js';
import { exclusionRules, HARNESS_IGNORE_FILE, type ExclusionRules } from './package-exclusions.js';
import type { StoreAuth, StoreFetch } from './store-auth.js';

/** The watcher reports a change once the folder has been quiet this long. */
export const FOLDER_CHANGE_DEBOUNCE_MS = 500;

/** The pre-flight read of the Publisher's versions gives up after this long. */
const PREFLIGHT_TIMEOUT_MS = 15_000;

/** The icon the preview shows is read up to this size: the Store's own limit for it. */
const MAX_ICON_BYTES = 5 * 1024 * 1024;

/** The README the preview shows is read up to this size: what the Store keeps of it. */
const MAX_README_BYTES = 1024 * 1024;

export interface PublishServiceOptions {
  /** Makes the Store's PostgREST calls (Electron's `net.fetch`). */
  readonly fetch: StoreFetch;
  /** The Store base URL, read on every request (the `store_base_url` setting). */
  readonly storeBaseUrl: () => string;
  /** The Store's anon key, sent as `apikey`. */
  readonly anonKey: string;
  /** The Publisher's session: their login, an access token, and what a 401 means for it. */
  readonly auth: Pick<StoreAuth, 'login' | 'accessToken' | 'sessionRejected'>;
  /** Told when the watched folder changed (`publish.folderChanged`). */
  readonly onFolderChanged?: (path: string) => void;
  /** Default: {@link FOLDER_CHANGE_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** The archive size limit; default `PACKAGE_LIMITS.maxArchiveBytes`. Tests lower it. */
  readonly maxArchiveBytes?: number;
}

/** The Publish flow's Runtime side (P0-08), as the IPC handlers use it. */
export interface PublishService {
  /** `publish.validateFolder`. */
  validateFolder(path: string): Promise<IpcResult<FolderValidation>>;
  /** `publish.stopWatching`. */
  stopWatching(): void;
  /** The zip of the latest validation while it is still the latest, else null (P0-08.2). */
  archive(archiveId: string): Uint8Array | null;
  /** Stops watching, on shutdown. */
  close(): void;
}

/**
 * The Publish flow's folder validation (P0-08.1), Electron-free. Every run builds the Harness
 * Package the upload would send (./package-archive.ts) and validates that zip, so what the
 * Publisher sees is what the Store will check: `validatePackage` from `@harness-store/manifest`
 * over `ArchiveSource`, with the signed-in Publisher's login (`publisher_mismatch`) and, when the
 * Harness ID's publisher segment is that login, every version of the Harness the Store has, in any
 * status (`version_not_greater`), read with the Publisher's session (api.md, "Own versions"). A
 * read that fails leaves `publishedVersions` out (`versionCheck: 'failed'`): the Store checks
 * again on upload. A 401 ends the session (`session_expired`).
 *
 * Runs are numbered: the newest wins, and an older one still going is stopped between files. Only
 * the newest run's zip is kept, for the upload.
 *
 * The folder of the latest run is watched (`fs.watch`, recursive, one folder at a time): a change
 * outside what the exclusion rules leave out, `.harnessignore` itself included, is reported once
 * the folder has been quiet for {@link FOLDER_CHANGE_DEBOUNCE_MS}. A folder the OS cannot watch
 * is not watched; Re-check still works.
 */
export function createPublishService(options: PublishServiceOptions): PublishService {
  const debounceMs = options.debounceMs ?? FOLDER_CHANGE_DEBOUNCE_MS;
  let runs = 0;
  let latest: { readonly id: string; readonly bytes: Uint8Array } | null = null;
  let watched: Watched | null = null;

  const stopWatching = () => {
    if (watched === null) return;
    if (watched.timer !== null) clearTimeout(watched.timer);
    watched.watcher?.close();
    watched = null;
  };

  const startWatching = (path: string) => {
    if (watched?.path === path) return;
    stopWatching();
    const entry: Watched = { path, rules: exclusionRules(null), watcher: null, timer: null };
    const changed = () => {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (watched === entry) options.onFolderChanged?.(path);
      }, debounceMs);
    };
    try {
      entry.watcher = watch(path, { recursive: true }, (_event, filename) => {
        const relative = filename === null ? null : filename.split(sep).join('/');
        if (relative !== null && relative !== HARNESS_IGNORE_FILE) {
          if (entry.rules.excludesFile(relative) || entry.rules.excludesFolder(relative)) return;
        }
        changed();
      });
      // The folder was deleted or moved: one more report, whose validation says so.
      entry.watcher.on('error', () => {
        entry.watcher?.close();
        changed();
      });
    } catch {
      // Too many watches, or a file system that cannot be watched: Re-check still works.
    }
    watched = entry;
  };

  /** The Publisher's versions of `harnessId`, any status, or why there are none to pass. */
  const preflight = async (
    harnessId: string,
  ): Promise<{ check: VersionCheck; versions?: string[] }> => {
    let token: string | null;
    try {
      token = await options.auth.accessToken();
    } catch {
      return { check: 'failed' };
    }
    if (token === null) return { check: 'failed' };
    const base = options.storeBaseUrl().replace(/\/+$/, '');
    const query = new URLSearchParams({ select: 'version', 'manifest->>id': `eq.${harnessId}` });
    let response: Response;
    let body: unknown;
    try {
      response = await options.fetch(`${base}/rest/v1/harness_versions?${query.toString()}`, {
        method: 'GET',
        headers: { apikey: options.anonKey, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });
      body = response.status === 200 ? await response.json() : null;
    } catch {
      return { check: 'failed' };
    }
    if (response.status === 401) {
      await options.auth.sessionRejected(token);
      return { check: 'failed' };
    }
    if (response.status !== 200 || !Array.isArray(body)) return { check: 'failed' };
    const versions = body
      .map((row: unknown) =>
        typeof row === 'object' && row !== null ? (row as { version?: unknown }).version : null,
      )
      .filter(isStrictVersion);
    return { check: 'checked', versions };
  };

  return {
    async validateFolder(path) {
      runs += 1;
      const run = runs;
      const isCurrent = () => run === runs;
      try {
        if (!(await stat(path)).isDirectory()) return fail('invalid_input', { path });
      } catch {
        return fail('package_invalid');
      }
      startWatching(path);

      let built;
      try {
        built = await buildPackage(path, {
          isCurrent,
          ...(options.maxArchiveBytes === undefined ? {} : { maxBytes: options.maxArchiveBytes }),
        });
      } catch (error) {
        if (error instanceof EntryUnreadableError) {
          return fail('file_unreadable', { path: error.path });
        }
        if (
          error instanceof FolderUnreadableError ||
          error instanceof FolderChangedError ||
          error instanceof BuildSupersededError
        ) {
          return fail('package_invalid');
        }
        throw error;
      }
      if (watched?.path === path) watched.rules = built.rules;

      const empty = {
        warnings: [],
        manifest: null,
        iconDataUrl: null,
        readme: null,
        excluded: built.excluded,
        archiveSize: built.size,
        versionCheck: 'skipped',
        lastPublishedVersion: null,
        isNew: false,
      } as const;
      if (built.bytes === null) {
        if (isCurrent()) latest = null;
        return ok({
          ...empty,
          archiveId: null,
          problems: built.problem === null ? [] : [built.problem],
        });
      }

      const source = await ArchiveSource.open(built.bytes);
      const login = await options.auth.login();
      const harnessId = await readHarnessId(source);
      let check: VersionCheck = 'skipped';
      let versions: string[] | undefined;
      if (login !== null && harnessId !== null && publisherOf(harnessId) === login.toLowerCase()) {
        ({ check, versions } = await preflight(harnessId));
      }
      const result = await validatePackage(source, {
        ...(login === null ? {} : { publisher: login }),
        ...(versions === undefined ? {} : { publishedVersions: versions }),
      });
      const iconDataUrl = await readIcon(source);
      const readme = await readText(source, 'README.md', MAX_README_BYTES);
      if (!isCurrent()) return fail('package_invalid');

      const archiveId = randomUUID();
      latest = { id: archiveId, bytes: built.bytes };
      const highest = versions === undefined ? null : (semver.rsort([...versions])[0] ?? null);
      return ok({
        ...empty,
        archiveId,
        problems: result.ok ? [] : sortByPath(result.problems),
        warnings: result.warnings,
        manifest: result.ok ? result.manifest : null,
        iconDataUrl,
        readme,
        versionCheck: check,
        lastPublishedVersion: highest,
        isNew: check === 'checked' && highest === null,
      });
    },

    stopWatching,

    archive(archiveId) {
      return latest?.id === archiveId ? latest.bytes : null;
    },

    close() {
      runs += 1;
      latest = null;
      stopWatching();
    },
  };
}

/** The folder being watched, with the exclusion rules its latest build read. */
interface Watched {
  readonly path: string;
  rules: ExclusionRules;
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The publisher segment of a Harness ID, lower-cased. */
function publisherOf(harnessId: string): string {
  return harnessId.slice(0, harnessId.indexOf('/')).toLowerCase();
}

/** Problems ordered by path (code-unit order), keeping the validator's order within a path. */
function sortByPath(problems: readonly Problem[]): Problem[] {
  return [...problems].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Strict semver as the Manifest allows it (no build metadata), so validatePackage takes it. */
function isStrictVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = semver.parse(value);
  return parsed !== null && parsed.version === value && parsed.build.length === 0;
}

/** The `id` of the zip's manifest.json when it reads as a Harness ID; null otherwise. */
async function readHarnessId(source: ArchiveSource): Promise<string | null> {
  const text = await readText(source, 'manifest.json', 1024 * 1024);
  if (text === null) return null;
  try {
    const { id } = JSON.parse(text) as { id?: unknown };
    return typeof id === 'string' && /^[^/]+\/[^/]+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A file of the zip as UTF-8 text (its first `maxBytes`), null when it has none. */
async function readText(
  source: ArchiveSource,
  path: string,
  maxBytes: number,
): Promise<string | null> {
  if (!source.listFiles().includes(path)) return null;
  try {
    return new TextDecoder().decode(await source.readFile(path, { maxBytes }));
  } catch (error) {
    if (error instanceof PackageReadError) return null;
    throw error;
  }
}

/** `assets/icon.png` of the zip as a `data:` URL; null when missing, too large or not a PNG. */
async function readIcon(source: ArchiveSource): Promise<string | null> {
  const path = 'assets/icon.png';
  if (!source.listFiles().includes(path)) return null;
  try {
    const bytes = await source.readFile(path, { maxBytes: MAX_ICON_BYTES + 1 });
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length > MAX_ICON_BYTES || png.some((byte, index) => bytes[index] !== byte)) {
      return null;
    }
    return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  } catch (error) {
    if (error instanceof PackageReadError) return null;
    throw error;
  }
}
