/**
 * Reading a request body as a JSON object, the only body shape the Gateway accepts. The
 * `Content-Type` header is not checked: every body is parsed as JSON.
 */

/** The largest request body the Gateway reads: 20 MB (images arrive inline as data URLs). */
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export type JsonBodyResult =
  | { ok: true; value: Record<string, unknown> }
  /** `message` explains the problem; the caller answers 400 `invalid_request`. */
  | { ok: false; message: string };

/**
 * Reads `request`'s body, stopping as soon as it passes `maxBytes`, and parses it as a JSON
 * object. Fails for an oversized, empty, non-UTF-8 or non-JSON body and for JSON that is not an
 * object.
 */
export async function readJsonObject(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<JsonBodyResult> {
  const tooLarge = {
    ok: false,
    message: `The request body is larger than ${String(maxBytes)} bytes.`,
  } as const;
  const notAnObject = { ok: false, message: 'The request body must be a JSON object.' } as const;
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) return tooLarge;
  if (request.body === null) return notAnObject;

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return tooLarge;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, message: 'The request body is not valid JSON.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return notAnObject;
  return { ok: true, value: value as Record<string, unknown> };
}
