/**
 * The request rules of the `unpublish` Edge Function that need no network: the request body and
 * the errors the unpublish_version SQL function raises. Plain TypeScript with relative imports
 * only (see storage-paths.ts).
 */
import { invalidRequest, isText } from './http.ts';
import type { ApiError } from './http.ts';

/** A valid `unpublish` request body (docs/tech/api.md). */
export interface UnpublishRequest {
  harness_id: string;
  version: string;
}

/** The longest Harness ID or version looked up; anything longer cannot exist. */
export const MAX_LOOKUP_LENGTH = 256;

export const UNAUTHENTICATED: ApiError = {
  status: 401,
  code: 'unauthenticated',
  message: 'Sign in with GitHub to Unpublish a version.',
};

export const NOT_FOUND: ApiError = {
  status: 404,
  code: 'not_found',
  message: 'No such Harness or Harness Version.',
};

export const FORBIDDEN: ApiError = {
  status: 403,
  code: 'forbidden',
  message: 'Only the Publisher of a Harness can Unpublish its versions.',
};

export const TAKEN_DOWN: ApiError = {
  status: 409,
  code: 'harness_taken_down',
  message: 'This Harness or Harness Version was taken down by the Store and cannot be Unpublished.',
};

/** What unpublish_version raises (SQLSTATE `PT<status>`, the code as message). */
export const UNPUBLISH_ERRORS: readonly ApiError[] = [NOT_FOUND, FORBIDDEN, TAKEN_DOWN];

/**
 * The request, or the 400 that refuses it: `harness_id` and `version` non-empty strings. Other
 * fields are ignored.
 */
export function unpublishRequest(body: unknown): UnpublishRequest | ApiError {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalidRequest('The body must be a JSON object.');
  }
  const { harness_id, version } = body as Record<string, unknown>;
  if (!isText(harness_id, MAX_LOOKUP_LENGTH)) {
    return invalidRequest('"harness_id" must be a Harness ID.');
  }
  if (!isText(version, MAX_LOOKUP_LENGTH)) {
    return invalidRequest('"version" must be the version to Unpublish.');
  }
  return { harness_id, version };
}
