import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  ArchiveSource,
  PackageReadError,
  validatePackage,
  type Manifest,
  type Problem,
} from '@harness-store/manifest';
import semver from 'semver';
import type {
  FolderValidation,
  IpcError,
  IpcErrorCode,
  IpcResult,
  OwnHarness,
  PublishedVersion,
  PublishRequest,
  UnpublishedVersion,
  UnpublishRequest,
  UploadProgress,
  VersionCheck,
} from '../../shared/ipc.js';
import { fail, ok } from './ipc-result.js';
import { readMyHarnesses, unpublishVersion } from './my-harnesses.js';
import {
  buildPackage,
  BuildSupersededError,
  EntryUnreadableError,
  FolderChangedError,
  FolderUnreadableError,
  type Listing,
} from './package-archive.js';
import { HARNESS_IGNORE_FILE, type ExclusionRules } from './package-exclusions.js';
import { uploadPackage, type UploadOutcome } from './package-upload.js';
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
  /** Told how far an upload is (`progress:<jobId>`). */
  readonly onProgress?: (jobId: string, progress: UploadProgress) => void;
  /**
   * Told when an upload, a read of My Harnesses or an Unpublish got no answer from the Store, so
   * connectivity is checked again.
   */
  readonly onStoreUnreachable?: () => void;
  /** Sends a Harness Package to the `publish` function; default {@link uploadPackage}. */
  readonly upload?: typeof uploadPackage;
  /** Default: {@link FOLDER_CHANGE_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** The archive size limit; default `PACKAGE_LIMITS.maxArchiveBytes`. Tests lower it. */
  readonly maxArchiveBytes?: number;
  /** Files listed before a folder counts as too large; default `PACKAGE_LIMITS.maxListedEntries`. */
  readonly maxListedEntries?: number;
  /** Watches the folder; default `fs.watch`. Tests drive its events. */
  readonly watch?: typeof watch;
  /**
   * Whether one recursive `fs.watch` covers the folder. Default: everywhere but Linux, where Node
   * has no native recursive watch and emulates it by listing and watching the whole tree,
   * excluded folders included, synchronously inside the call. Otherwise every folder the build
   * listed gets a watch of its own.
   */
  readonly recursiveWatch?: boolean;
}

/** The Publish flow's Runtime side (P0-08), as the IPC handlers use it. */
export interface PublishService {
  /** `publish.validateFolder`. */
  validateFolder(path: string): Promise<IpcResult<FolderValidation>>;
  /** `publish.stopWatching`. */
  stopWatching(): void;
  /** The zip of the latest validation while it is still the latest, else null: what is uploaded. */
  archive(archiveId: string): Uint8Array | null;
  /** `publish.publish`. */
  publish(request: PublishRequest): Promise<IpcResult<PublishedVersion>>;
  /** `publish.cancel`. */
  cancel(jobId: string): void;
  /** `publish.myHarnesses`. */
  myHarnesses(): Promise<IpcResult<readonly OwnHarness[]>>;
  /** `publish.unpublish`. */
  unpublish(request: UnpublishRequest): Promise<IpcResult<UnpublishedVersion>>;
  /** Stops watching, on shutdown. */
  close(): void;
}

/**
 * The Publish flow's folder validation (P0-08.1), upload (P0-08.2) and My Harnesses with
 * Unpublish (P0-08.3, ./my-harnesses.ts), Electron-free. Every run
 * builds the Harness Package the upload would send (./package-archive.ts) and validates that zip,
 * so what the Publisher sees is what the Store will check: `validatePackage` from
 * `@harness-store/manifest` over `ArchiveSource`, with the signed-in Publisher's login
 * (`publisher_mismatch`) and, when the Harness ID's publisher segment is that login, every version
 * of the Harness the Store has, in any status (`version_not_greater`), read with the Publisher's
 * session (api.md, "Own versions"). A read that fails leaves `publishedVersions` out
 * (`versionCheck: 'failed'`): the Store checks again on upload. A 401 ends the session
 * (`session_expired`).
 *
 * Runs are numbered: the newest wins, and an older one still going is stopped between folders,
 * files and a file's chunks, and before it opens its zip or asks the Store. Only the newest run's
 * zip is kept, for the upload.
 *
 * The folder of the latest run is watched (`fs.watch`, one folder at a time), from the moment its
 * build has listed it, before any file is read: a change outside what the exclusion rules leave
 * out, `.harnessignore` itself included, is reported once the folder has been quiet for
 * {@link FOLDER_CHANGE_DEBOUNCE_MS}. One recursive watch covers it, except on Linux, where each
 * folder the build listed is watched on its own, so excluded folders are never entered, and every
 * listing replaces those watches (a folder made since is listed by the validation its change
 * brings). A folder with too many files to list is not watched: Re-check validates it again. A
 * watcher that could not start, that failed, or whose folder itself was deleted or moved is
 * dropped, after one last report: the next validation of the folder (that report's, a Re-check, a
 * new pick) watches it afresh.
 *
 * The upload (P0-08.2) sends the latest run's zip, unchanged, to the Store's `publish` function
 * (./package-upload.ts) with the Publisher's session, reporting the bytes sent after each chunk;
 * it can be cancelled until all of them are sent. A 401 ends the session (`session_expired`), and
 * no answer at all has connectivity checked again. A version published ends the folder's watch.
 */
export function createPublishService(options: PublishServiceOptions): PublishService {
  const debounceMs = options.debounceMs ?? FOLDER_CHANGE_DEBOUNCE_MS;
  const watchFolder = options.watch ?? watch;
  const recursive = options.recursiveWatch ?? process.platform !== 'linux';
  const upload = options.upload ?? uploadPackage;
  let runs = 0;
  let latest: LatestArchive | null = null;
  let watched: Watched | null = null;
  /** The uploads in flight, by job. */
  const jobs = new Map<string, AbortController>();

  const stopWatching = () => {
    if (watched === null) return;
    if (watched.timer !== null) clearTimeout(watched.timer);
    for (const watcher of watched.watchers) watcher.close();
    watched = null;
  };

  /** Watches `path`, as its build listed it. */
  const startWatching = (path: string, listing: Listing) => {
    if (recursive && watched?.path === path && watched.watchers.length > 0) {
      watched.rules = listing.rules;
      return;
    }
    const entry: Watched = { path, rules: listing.rules, watchers: [], timer: null };
    const changed = () => {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (watched === entry) options.onFolderChanged?.(path);
      }, debounceMs);
    };
    /** The watcher is dead: the next validation of the folder starts a new one. */
    const drop = () => {
      for (const watcher of entry.watchers) watcher.close();
      entry.watchers = [];
    };
    /** Watches `folder` (relative to `path`), recursively or not. */
    const watchOne = (folder: string) => {
      const target = folder === '' ? path : join(path, ...folder.split('/'));
      const watcher = watchFolder(target, { recursive }, (event, filename) => {
        const name = filename === null ? '' : filename.split(sep).join('/');
        const relative = folder === '' || name === '' ? folder || name : `${folder}/${name}`;
        if (relative === '') {
          // The folder itself. Linux reports its deletion or move as a 'rename' of '' (and the
          // rules cannot be asked about '').
          if (event === 'rename') drop();
        } else if (relative !== HARNESS_IGNORE_FILE) {
          if (entry.rules.excludesFile(relative) || entry.rules.excludesFolder(relative)) return;
        }
        changed();
      });
      entry.watchers.push(watcher);
      // The folder was deleted or moved: one more report, whose validation says so.
      watcher.on('error', () => {
        drop();
        changed();
      });
    };
    try {
      if (recursive) watchOne('');
      else for (const folder of listing.folders) watchOne(folder);
    } catch {
      // Too many watches, or a file system that cannot be watched: Re-check tries again.
      drop();
    }
    // The new watches are up before the old ones close, so no change falls in between, and a
    // change the old ones were about to report is still reported.
    const pending = watched?.path === path && watched.timer !== null;
    stopWatching();
    watched = entry;
    if (pending) changed();
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

      let built;
      try {
        built = await buildPackage(path, {
          isCurrent,
          // Watched once listed within the limit, so a folder too large to list (a home folder
          // dropped by mistake) is never walked by a watcher; a newer run keeps its own watch.
          onListed: (listing) => {
            if (isCurrent()) startWatching(path, listing);
          },
          ...(options.maxArchiveBytes === undefined ? {} : { maxBytes: options.maxArchiveBytes }),
          ...(options.maxListedEntries === undefined
            ? {}
            : { maxListed: options.maxListedEntries }),
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
      if (!isCurrent()) return fail('package_invalid');
      // Too many files to list: it was not watched, and is no longer.
      if (built.problem?.messageKey === 'archive_too_many_files.not_counted') stopWatching();

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
        latest = null;
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
      // A run replaced meanwhile does not ask the Store (nor end the session on a 401).
      if (!isCurrent()) return fail('package_invalid');
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
      latest = {
        id: archiveId,
        bytes: built.bytes,
        // Only a Harness Package without problems is uploaded.
        manifest: result.ok ? result.manifest : null,
      };
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

    async publish({ archiveId, jobId }) {
      const archive = latest;
      if (archive?.id !== archiveId || archive.manifest === null || jobs.has(jobId)) {
        return fail('package_invalid');
      }
      const { manifest } = archive;
      const controller = new AbortController();
      jobs.set(jobId, controller);
      try {
        let token: string | null;
        try {
          token = await options.auth.accessToken();
        } catch {
          // The session's refresh got no answer: the session is kept.
          options.onStoreUnreachable?.();
          return fail('store_unreachable');
        }
        if (token === null) return fail('unauthenticated');
        if (controller.signal.aborted) return fail('upload_cancelled');
        const base = options.storeBaseUrl().replace(/\/+$/, '');
        const outcome = await upload({
          url: `${base}/functions/v1/publish`,
          headers: { apikey: options.anonKey, authorization: `Bearer ${token}` },
          fileName: packageFileName(manifest),
          bytes: archive.bytes,
          signal: controller.signal,
          onProgress: (sent, total) => options.onProgress?.(jobId, { sent, total }),
        });
        if (outcome.kind === 'cancelled') return fail('upload_cancelled');
        if (outcome.kind === 'unreachable') {
          options.onStoreUnreachable?.();
          return fail('store_unreachable');
        }
        if (outcome.status === 401) await options.auth.sessionRejected(token);
        const answer = publishAnswer(outcome, manifest);
        // The folder is published: its watch ends before the answer goes back, so no change
        // reported afterwards can replace the success screen with a new validation.
        if (answer.ok) stopWatching();
        return answer;
      } finally {
        jobs.delete(jobId);
      }
    },

    cancel(jobId) {
      jobs.get(jobId)?.abort();
    },

    myHarnesses() {
      return readMyHarnesses(options);
    },

    unpublish(request) {
      return unpublishVersion(options, request);
    },

    close() {
      runs += 1;
      latest = null;
      for (const controller of jobs.values()) controller.abort();
      stopWatching();
    },
  };
}

/** The latest validation's zip, kept for the upload. */
interface LatestArchive {
  readonly id: string;
  readonly bytes: Uint8Array;
  /** The zip's Manifest; null when the zip has problems, and is never uploaded. */
  readonly manifest: Manifest | null;
}

/** The Store's refusals of a publish, by `error.code`, each kept as it is. */
const PUBLISH_REFUSALS: ReadonlySet<string> = new Set<IpcErrorCode>([
  'publisher_mismatch',
  'version_not_greater',
  'invalid_manifest',
  'package_too_large',
  'rate_limited',
  'harness_taken_down',
  'forbidden',
  'not_found',
]);

/** Refusals without a known code, by HTTP status. */
const REFUSAL_BY_STATUS: Readonly<Record<number, IpcErrorCode>> = {
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  413: 'package_too_large',
  429: 'rate_limited',
};

/**
 * The `publish` function's answer (docs/tech/api.md): `201 { harness_id, version, url }`, or
 * `{ error: { code, message, problems? } }`. A 201 is the version published, whatever its body:
 * one cut off or unreadable is answered from the uploaded zip's `manifest`. A refusal keeps the
 * Store's code when the app knows it, else goes by status; its English message and its problems
 * (ordered by path) come along. A 5xx is `store_unreachable`; anything else unexpected
 * `internal_error`.
 */
function publishAnswer(
  outcome: Extract<UploadOutcome, { kind: 'answered' }>,
  manifest: Manifest,
): IpcResult<PublishedVersion> {
  const { status, body } = outcome;
  if (status === 201) {
    const { harness_id: id, version: answered, url } = isRecord(body) ? body : {};
    const [harnessId, version] =
      typeof id === 'string' && typeof answered === 'string'
        ? [id, answered]
        : [manifest.id, manifest.version];
    // The listing's in-app route; built from the ID when the Store sent anything else.
    const route =
      typeof url === 'string' && url.startsWith('/store/h/') ? url : `/store/h/${harnessId}`;
    return ok({ harnessId, version, url: route });
  }
  if (status >= 500) return fail('store_unreachable');
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const code =
    status === 401
      ? 'unauthenticated'
      : typeof error.code === 'string' && PUBLISH_REFUSALS.has(error.code)
        ? (error.code as IpcErrorCode)
        : (REFUSAL_BY_STATUS[status] ?? 'internal_error');
  const failed = fail(code);
  const refusal: IpcError = {
    ...failed.error,
    ...(typeof error.message === 'string' && error.message !== ''
      ? { message: error.message }
      : {}),
    ...(Array.isArray(error.problems)
      ? { problems: sortByPath(error.problems.filter(isProblem)) }
      : {}),
  };
  return { ok: false, error: refusal };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A Problem as validatePackage returns it, params of strings and numbers only. */
function isProblem(value: unknown): value is Problem {
  if (!isRecord(value)) return false;
  const { path, code, message, messageKey, params } = value;
  return (
    typeof path === 'string' &&
    typeof code === 'string' &&
    typeof message === 'string' &&
    typeof messageKey === 'string' &&
    (params === undefined ||
      (isRecord(params) &&
        Object.values(params).every(
          (param) => typeof param === 'string' || typeof param === 'number',
        )))
  );
}

/** The folder being watched, with the exclusion rules its latest build read. */
interface Watched {
  readonly path: string;
  rules: ExclusionRules;
  /** One recursive watch, or one per folder listed; none once dropped. */
  watchers: FSWatcher[];
  timer: ReturnType<typeof setTimeout> | null;
}

/** The upload's file name, `<slug>-<version>.zip`. */
function packageFileName(manifest: Manifest): string {
  return `${manifest.id.slice(manifest.id.indexOf('/') + 1)}-${manifest.version}.zip`;
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
