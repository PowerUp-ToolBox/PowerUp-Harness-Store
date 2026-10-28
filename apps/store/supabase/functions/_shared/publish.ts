/**
 * The request rules of the `publish` Edge Function that need no network: which Auth errors mean a
 * bad token, the Content-Length check, which Harness a package is for, the HTTP answer to
 * validatePackage's problems and to publish_version's errors, whether a failed publish_version
 * call surely wrote nothing, and the in-app route of a published Harness. The validation itself is
 * validatePackage from @harness-store/manifest, never repeated here. Plain TypeScript with no
 * imports (see storage-paths.ts).
 */

/**
 * A finding of validatePackage, as @harness-store/manifest's `Problem` type declares it (repeated
 * here structurally: this module has relative imports only).
 */
export interface Problem {
  path: string;
  code: string;
  message: string;
  messageKey: string;
  params?: Record<string, string | number>;
}

/** The largest Harness Package (docs/tech/manifest-spec.md §1; `PACKAGE_LIMITS.maxArchiveBytes`). */
export const MAX_PACKAGE_BYTES = 500 * 1024 * 1024;

/**
 * What a request may add to the package for its multipart framing (boundaries, part headers).
 * The exact 500 MB limit is validatePackage's `archive_too_large`, on the zip's own size; the
 * Content-Length check only refuses what cannot be within it, before the body is read.
 */
export const MULTIPART_ALLOWANCE = 64 * 1024;

/** An error answer: HTTP status, API error code and English message. */
export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export const PUBLISHER_MISMATCH: ApiError = {
  status: 403,
  code: 'publisher_mismatch',
  message: "The Harness ID's publisher segment is not your GitHub login.",
};

export const VERSION_NOT_GREATER: ApiError = {
  status: 409,
  code: 'version_not_greater',
  message: 'The version must be greater than every version of this Harness published before.',
};

export const HARNESS_TAKEN_DOWN: ApiError = {
  status: 409,
  code: 'harness_taken_down',
  message: 'This Harness was taken down by the Store and cannot get new versions.',
};

export const RATE_LIMITED: ApiError = {
  status: 429,
  code: 'rate_limited',
  message: 'A Publisher can publish at most 20 versions in 24 hours. Try again later.',
};

export const ICON_TOO_LARGE: ApiError = {
  status: 413,
  code: 'package_too_large',
  message: 'assets/icon.png is larger than 5 MB, the most the Store keeps for an icon.',
};

/** The Auth error codes that say the token itself is not (or no longer) a valid session. */
const BAD_TOKEN_CODES = new Set([
  'bad_jwt',
  'no_authorization',
  'user_not_found',
  'session_not_found',
  'session_expired',
]);

/**
 * Whether an error of Auth's `getUser(token)` means the token is not a valid session (`401
 * unauthenticated`, which ends the desktop app's session), rather than that Auth could not answer
 * (a network error, a 5xx, a 429: `500 internal_error`, which it may retry). `error` is the
 * supabase-js AuthError, read structurally: Auth's own refusal is an `AuthApiError` with its HTTP
 * status and error code, and a session that no longer exists an `AuthSessionMissingError`.
 */
export function isBadToken(error: { name?: string; status?: number; code?: string }): boolean {
  if (error.name === 'AuthSessionMissingError') return true;
  if (error.name !== 'AuthApiError') return false;
  return error.status === 401 || error.status === 403 || BAD_TOKEN_CODES.has(error.code ?? '');
}

/** A refusal of the request from its Content-Length header alone, or undefined to go on. */
export function contentLengthError(header: string | null): ApiError | undefined {
  if (header === null) {
    return {
      status: 411,
      code: 'length_required',
      message: 'The request must declare its Content-Length.',
    };
  }
  if (!/^\d+$/.test(header.trim())) {
    return { status: 400, code: 'invalid_request', message: 'The Content-Length is not a number.' };
  }
  if (Number(header.trim()) > MAX_PACKAGE_BYTES + MULTIPART_ALLOWANCE) {
    return {
      status: 413,
      code: 'package_too_large',
      message: 'The Harness Package is larger than 500 MB.',
    };
  }
  return undefined;
}

/**
 * The Harness ID in a package's manifest.json, when it is one of `login`'s: which Harness's
 * versions validatePackage must compare the new version with. Anything else (no manifest, not
 * JSON, another Publisher's ID) gives undefined: validatePackage then reports what is wrong, and
 * no other Publisher's versions are ever looked up.
 */
export function ownHarnessId(
  manifestJson: Uint8Array | undefined,
  login: string,
): string | undefined {
  if (manifestJson === undefined) return undefined;
  let id: unknown;
  try {
    id = (JSON.parse(new TextDecoder().decode(manifestJson)) as { id?: unknown } | null)?.id;
  } catch {
    return undefined;
  }
  if (typeof id !== 'string') return undefined;
  const [publisher, slug, ...rest] = id.split('/');
  return publisher === login && slug !== undefined && slug !== '' && rest.length === 0
    ? id
    : undefined;
}

const TOO_LARGE_CODES = new Set(['archive_too_large', 'archive_too_many_files']);

/**
 * The answer to a package validatePackage refused, from all its problems: 413 when it is too
 * large or holds too many files, else 422 when anything is wrong with it besides who publishes it
 * and its version, else 403 for another Publisher's Harness ID, else 409 for a version that is
 * not greater than every earlier one. The body carries every problem, whatever the status.
 */
export function rejection(problems: readonly Problem[]): ApiError {
  const codes = new Set(problems.map((problem) => problem.code));
  if ([...codes].some((code) => TOO_LARGE_CODES.has(code))) {
    return {
      status: 413,
      code: 'package_too_large',
      message: 'The Harness Package is larger than 500 MB or holds more than 20 000 files.',
    };
  }
  if ([...codes].some((code) => code !== 'publisher_mismatch' && code !== 'version_not_greater')) {
    return {
      status: 422,
      code: 'invalid_manifest',
      message: 'The Harness Package is not valid; see problems.',
    };
  }
  if (codes.has('publisher_mismatch')) return PUBLISHER_MISMATCH;
  return VERSION_NOT_GREATER;
}

/**
 * The answer to an error of the publish_version SQL function, from its SQLSTATE and message: the
 * errors it raises itself (PT403, PT409, PT429 with the API code as message), and a unique
 * violation of (harness, version), which is another publish of the same version winning a race.
 * Undefined for anything else (a server error).
 */
export function publishVersionError(sqlState: string, message: string): ApiError | undefined {
  if (sqlState === '23505') return VERSION_NOT_GREATER;
  if (!sqlState.startsWith('PT')) return undefined;
  return [PUBLISHER_MISMATCH, VERSION_NOT_GREATER, HARNESS_TAKEN_DOWN, RATE_LIMITED].find(
    (error) => error.code === message && `PT${String(error.status)}` === sqlState,
  );
}

/**
 * Whether a failed call of publish_version surely wrote nothing: PostgREST answered it with a code,
 * a SQLSTATE from the rolled-back transaction or its own `PGRST…` code for a request it never ran.
 * An error without one (supabase-js reports a lost connection with an empty code, and the gateway
 * giving up on PostgREST with a body that has none) leaves the outcome unknown: the transaction can
 * still be waiting for the Publisher's lock, or running, and commit afterwards. `error` is the
 * supabase-js PostgrestError, read structurally.
 */
export function rolledBack(error: { code?: string | null }): boolean {
  return typeof error.code === 'string' && error.code !== '';
}

/** Where the desktop app shows a Harness: its Store tab's detail route (P0-08 opens it). */
export function storeRoute(harnessId: string): string {
  return `/store/h/${harnessId}`;
}
