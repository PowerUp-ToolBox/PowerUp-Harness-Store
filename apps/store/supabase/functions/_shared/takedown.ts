/**
 * The request rules of the `admin` Edge Function (`admin/takedown`) that need no network: its
 * route, the request body and the errors the take_down SQL function raises. Plain TypeScript with
 * relative imports only (see storage-paths.ts).
 */
import { invalidRequest, isText } from './http.ts';
import type { ApiError } from './http.ts';
import { MAX_LOOKUP_LENGTH, NOT_FOUND } from './unpublish.ts';

/** A valid `admin/takedown` request body (docs/tech/api.md). */
export interface TakedownRequest {
  harness_id: string;
  /** Undefined: the whole Harness and every one of its versions. */
  version?: string;
  note: string;
}

/** The longest takedown note (`harness_versions.takedown_note`, `admin_actions.note`). */
export const MAX_NOTE_LENGTH = 2000;

export const UNAUTHENTICATED: ApiError = {
  status: 401,
  code: 'unauthenticated',
  message: 'Sign in with GitHub as a Store administrator.',
};

export const FORBIDDEN: ApiError = {
  status: 403,
  code: 'forbidden',
  message: 'Only a Store administrator can take content down.',
};

export const ROUTE_NOT_FOUND: ApiError = {
  status: 404,
  code: 'not_found',
  message: 'No such admin action; the one there is: POST /functions/v1/admin/takedown.',
};

/** What take_down raises (SQLSTATE `PT<status>`, the code as message). */
export const TAKEDOWN_ERRORS: readonly ApiError[] = [NOT_FOUND, FORBIDDEN];

/**
 * Whether a request path is `admin/takedown`. A function's name cannot hold a `/`, so the one
 * `admin` function serves it: the path it sees ends with `/admin/takedown` (after
 * `/functions/v1` behind the gateway, or not), with or without a trailing slash.
 */
export function isTakedownRoute(pathname: string): boolean {
  return /(^|\/)admin\/takedown\/?$/.test(pathname);
}

/**
 * The request, or the 400 that refuses it: `harness_id` a non-empty string, `version` absent,
 * null or a non-empty string, `note` a string of 1 to {@link MAX_NOTE_LENGTH} characters (not
 * only whitespace). Other fields are ignored.
 */
export function takedownRequest(body: unknown): TakedownRequest | ApiError {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalidRequest('The body must be a JSON object.');
  }
  const { harness_id, version, note } = body as Record<string, unknown>;
  if (!isText(harness_id, MAX_LOOKUP_LENGTH)) {
    return invalidRequest('"harness_id" must be a Harness ID.');
  }
  if (version !== undefined && version !== null && !isText(version, MAX_LOOKUP_LENGTH)) {
    return invalidRequest('"version" must be a version, or left out for the whole Harness.');
  }
  if (!isText(note, MAX_NOTE_LENGTH) || note.trim() === '') {
    return invalidRequest(
      `"note" must be a string of 1 to ${String(MAX_NOTE_LENGTH)} characters saying why.`,
    );
  }
  return { harness_id, ...(typeof version === 'string' ? { version } : {}), note };
}
