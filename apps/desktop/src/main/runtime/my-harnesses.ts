import semver from 'semver';
import type {
  HarnessStoreStatus,
  HarnessVersionStatus,
  IpcError,
  IpcErrorCode,
  IpcResult,
  OwnHarness,
  OwnVersion,
  UnpublishedVersion,
  UnpublishRequest,
} from '../../shared/ipc.js';
import { fail, ok } from './ipc-result.js';
import type { StoreAuth, StoreFetch } from './store-auth.js';

/** A read of the Publisher's Harnesses gives up after this long. */
const READ_TIMEOUT_MS = 15_000;

/** An Unpublish gives up after this long; asking again is safe, it is idempotent. */
const UNPUBLISH_TIMEOUT_MS = 30_000;

/** The "Own versions" read's columns (docs/tech/api.md). */
const OWN_VERSIONS_SELECT =
  'harness_id:manifest->>id,name:manifest->>name,version,status,takedown_note,download_count,published_at,unpublished_at';

export interface MyHarnessesOptions {
  /** Makes the Store calls (Electron's `net.fetch`). */
  readonly fetch: StoreFetch;
  /** The Store base URL, read on every request (the `store_base_url` setting). */
  readonly storeBaseUrl: () => string;
  /** The Store's anon key, sent as `apikey`. */
  readonly anonKey: string;
  /** The Publisher's session: their login, an access token, and what a 401 means for it. */
  readonly auth: Pick<StoreAuth, 'login' | 'accessToken' | 'sessionRejected'>;
  /** Told when the Store did not answer at all, so connectivity is checked again. */
  readonly onStoreUnreachable?: () => void;
}

/**
 * My Harnesses (P0-08.3): the signed-in Publisher's Harnesses with every version, any status, read
 * with their session through api.md's "Own versions" read, which the Publisher-only read policy on
 * `harness_versions` (P0-07.6) answers with their Unpublished and taken-down versions too, each
 * taken-down one with the administrator's note. The `like.<login>/*` filter keeps out the other
 * Publishers' published versions, which the same session also sees. Versions are grouped by
 * Harness, newest published first, and the groups ordered by their newest version; each
 * Harness's own status and latest version come from one `latest_versions` call (there is no owner
 * policy on `harnesses`), and its downloads are those of its versions added up.
 *
 * A 401 ends the session (`session_expired`) and answers `unauthenticated`; no answer at all, or
 * a 5xx, is `store_unreachable`.
 */
export async function readMyHarnesses(
  options: MyHarnessesOptions,
): Promise<IpcResult<readonly OwnHarness[]>> {
  const login = await options.auth.login();
  if (login === null) return fail('unauthenticated');
  const query = new URLSearchParams({
    select: OWN_VERSIONS_SELECT,
    'manifest->>id': `like.${login.toLowerCase()}/*`,
    order: 'published_at.desc',
  });
  const rows = await storeCall(options, `rest/v1/harness_versions?${query.toString()}`, {
    method: 'GET',
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (!rows.ok) return rows;
  if (!Array.isArray(rows.data)) return fail('internal_error');

  const groups = new Map<string, { name: string; version: OwnVersion }[]>();
  for (const row of rows.data.map(parseOwnVersion)) {
    if (row === null) continue;
    const group = groups.get(row.harnessId) ?? [];
    groups.set(row.harnessId, group);
    group.push(row);
  }
  for (const group of groups.values()) group.sort((a, b) => newestFirst(a.version, b.version));
  const ids = [...groups.keys()];
  if (ids.length === 0) return ok([]);

  const statuses = await storeCall(
    options,
    'rest/v1/rpc/latest_versions?select=harness_id,store_status,latest_version',
    { method: 'POST', body: { harness_ids: ids }, timeoutMs: READ_TIMEOUT_MS },
  );
  if (!statuses.ok) return statuses;
  if (!Array.isArray(statuses.data)) return fail('internal_error');
  const status = new Map<
    string,
    { storeStatus: HarnessStoreStatus; latestVersion: string | null }
  >();
  for (const row of statuses.data) {
    if (!isRecord(row) || typeof row.harness_id !== 'string') continue;
    const storeStatus = STORE_STATUSES.has(row.store_status as HarnessStoreStatus)
      ? (row.store_status as HarnessStoreStatus)
      : 'not_found';
    const latestVersion = typeof row.latest_version === 'string' ? row.latest_version : null;
    status.set(row.harness_id, { storeStatus, latestVersion });
  }

  const harnesses = ids.map((harnessId): OwnHarness => {
    const group = groups.get(harnessId) ?? [];
    const versions = group.map((row) => row.version);
    const known = status.get(harnessId) ?? { storeStatus: 'not_found', latestVersion: null };
    return {
      harnessId,
      // The name its newest version gives it.
      name: group[0]?.name ?? harnessId,
      storeStatus: known.storeStatus,
      latestVersion: known.storeStatus === 'available' ? known.latestVersion : null,
      downloadCount: versions.reduce((sum, version) => sum + version.downloadCount, 0),
      versions,
    };
  });
  // The Harness with the most recently published version first.
  return ok(harnesses.sort((a, b) => newestFirst(a.versions[0] ?? NEVER, b.versions[0] ?? NEVER)));
}

/**
 * Unpublishes one of the Publisher's Harness Versions through the Store's `unpublish` function
 * (api.md): the version can no longer be downloaded, existing installs keep working, and the
 * Store moves the Harness's latest version back to the previous published one. Unpublishing a
 * version already Unpublished is a success too, so a double click or a stale list shows no error.
 * The Store's refusals keep its code (`forbidden`, `not_found`, `harness_taken_down`) and its
 * English message; a 401 ends the session.
 */
export async function unpublishVersion(
  options: MyHarnessesOptions,
  request: UnpublishRequest,
): Promise<IpcResult<UnpublishedVersion>> {
  const answer = await storeCall(options, 'functions/v1/unpublish', {
    method: 'POST',
    body: { harness_id: request.harnessId, version: request.version },
    timeoutMs: UNPUBLISH_TIMEOUT_MS,
  });
  if (!answer.ok) return answer;
  const {
    harness_id: harnessId,
    version,
    latest_version: latest,
  } = isRecord(answer.data) ? answer.data : {};
  return ok({
    harnessId: typeof harnessId === 'string' ? harnessId : request.harnessId,
    version: typeof version === 'string' ? version : request.version,
    latestVersion: typeof latest === 'string' ? latest : null,
  });
}

/** By `published_at`, newest first, then by version, highest first. */
function newestFirst(a: OwnVersion, b: OwnVersion): number {
  const byTime = Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  const [left, right] = [semver.valid(a.version), semver.valid(b.version)];
  return left !== null && right !== null ? semver.rcompare(left, right) : 0;
}

const NEVER: OwnVersion = {
  version: '0.0.0',
  status: 'published',
  publishedAt: new Date(0).toISOString(),
  unpublishedAt: null,
  takedownNote: null,
  downloadCount: 0,
};

const VERSION_STATUSES: ReadonlySet<HarnessVersionStatus> = new Set([
  'published',
  'unpublished',
  'taken_down',
]);

const STORE_STATUSES: ReadonlySet<HarnessStoreStatus> = new Set([
  'available',
  'unpublished',
  'taken_down',
  'not_found',
]);

/** A row of the "Own versions" read, or null when it is not one. */
function parseOwnVersion(
  row: unknown,
): { harnessId: string; name: string; version: OwnVersion } | null {
  if (!isRecord(row)) return null;
  const { harness_id: harnessId, name, version, status, published_at: publishedAt } = row;
  if (
    typeof harnessId !== 'string' ||
    typeof version !== 'string' ||
    typeof publishedAt !== 'string' ||
    !VERSION_STATUSES.has(status as HarnessVersionStatus)
  ) {
    return null;
  }
  return {
    harnessId,
    name: typeof name === 'string' && name !== '' ? name : harnessId,
    version: {
      version,
      status: status as HarnessVersionStatus,
      publishedAt,
      unpublishedAt: typeof row.unpublished_at === 'string' ? row.unpublished_at : null,
      takedownNote: typeof row.takedown_note === 'string' ? row.takedown_note : null,
      downloadCount: typeof row.download_count === 'number' ? row.download_count : 0,
    },
  };
}

/** The Store's refusals of these calls, by `error.code`, each kept as it is. */
const REFUSALS: ReadonlySet<string> = new Set<IpcErrorCode>([
  'forbidden',
  'not_found',
  'harness_taken_down',
]);

/** Refusals without a known code, by HTTP status. */
const REFUSAL_BY_STATUS: Readonly<Record<number, IpcErrorCode>> = {
  403: 'forbidden',
  404: 'not_found',
  409: 'harness_taken_down',
};

/**
 * One Store call with the Publisher's session (`apikey` and the bearer token): its JSON body on a
 * 2xx. No session is `unauthenticated`; a 401 ends the session (only while that token is still
 * the stored one) and is `unauthenticated`; no answer, or a refresh of the session that got none,
 * is `store_unreachable`, and connectivity is checked again; a 5xx is `store_unreachable` too. A
 * refusal keeps the Store's code when it is one of {@link REFUSALS}, else goes by status, with
 * the Store's English message.
 */
async function storeCall(
  options: MyHarnessesOptions,
  path: string,
  request: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<IpcResult<unknown>> {
  let token: string | null;
  try {
    token = await options.auth.accessToken();
  } catch {
    options.onStoreUnreachable?.();
    return fail('store_unreachable');
  }
  if (token === null) return fail('unauthenticated');
  const base = options.storeBaseUrl().replace(/\/+$/, '');
  let response: Response;
  let body: unknown;
  try {
    response = await options.fetch(`${base}/${path}`, {
      method: request.method,
      headers: {
        apikey: options.anonKey,
        authorization: `Bearer ${token}`,
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    body = await response.json().catch(() => null);
  } catch {
    options.onStoreUnreachable?.();
    return fail('store_unreachable');
  }
  if (response.status === 401) {
    await options.auth.sessionRejected(token);
    return fail('unauthenticated');
  }
  if (response.status >= 500) return fail('store_unreachable');
  if (response.ok) return ok(body);
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const code =
    typeof error.code === 'string' && REFUSALS.has(error.code)
      ? (error.code as IpcErrorCode)
      : (REFUSAL_BY_STATUS[response.status] ?? 'internal_error');
  const failed = fail(code);
  const refusal: IpcError = {
    ...failed.error,
    ...(typeof error.message === 'string' && error.message !== ''
      ? { message: error.message }
      : {}),
  };
  return { ok: false, error: refusal };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
