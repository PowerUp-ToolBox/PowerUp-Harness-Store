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
