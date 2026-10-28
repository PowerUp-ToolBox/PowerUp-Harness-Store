/**
 * The HTTP conventions every Store Edge Function follows (docs/tech/api.md): JSON bodies, and
 * errors as `{ "error": { "code", "message", ... } }` with a stable snake_case `code` the desktop
 * app maps to translated copy. Plain TypeScript with no imports (see storage-paths.ts).
 */

/** A JSON response. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** An error response; `details` adds fields next to `code` and `message` (e.g. `problems`). */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return jsonResponse(status, { error: { code, message, ...details } });
}

/** The token of an `Authorization: Bearer <token>` header, or undefined. */
export function bearerToken(authorization: string | null): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  return match?.[1];
}

/** An error answer: HTTP status, API error code and English message. */
export interface ApiError {
  status: number;
  code: string;
  message: string;
}

/** The response of an {@link ApiError}. */
export function failure(error: ApiError, details?: Record<string, unknown>): Response {
  return errorResponse(error.status, error.code, error.message, details);
}

/** A `400 invalid_request` saying what is wrong with the body. */
export function invalidRequest(message: string): ApiError {
  return { status: 400, code: 'invalid_request', message };
}

/**
 * Whether `value` is a string Postgres can store as text: no NUL character (U+0000), which `text`
 * and `jsonb` refuse, so a body carrying one is a bad request rather than a failed database call.
 */
export function isStorable(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\u0000');
}

/** Whether `value` is a non-empty storable string of at most `maxLength` characters. */
export function isText(value: unknown, maxLength: number): value is string {
  return isStorable(value) && value !== '' && value.length <= maxLength;
}

/** The JSON body of a request, or undefined when it is not JSON. */
export async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/**
 * The answer to an error a Store SQL function raised on purpose: SQLSTATE `PT<status>` with the
 * API error code as its message, one of `known`. Undefined for any other error (a server error).
 */
export function raisedError(
  sqlState: string | undefined,
  message: string | undefined,
  known: readonly ApiError[],
): ApiError | undefined {
  return known.find((error) => `PT${String(error.status)}` === sqlState && error.code === message);
}
