/**
 * The Gateway's small building blocks on their own: the JSON body reader, log redaction and the
 * in-memory token table.
 */
import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, readJsonObject } from '../src/body.js';
import { redact } from '../src/logging.js';
import { createInMemoryTokenVerifier } from '../src/tokens.js';

function post(body: string | Uint8Array | null, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST', body, headers });
}

/** A body stream of `total` bytes of JSON-ish filler, without a Content-Length. */
function streamOf(total: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      const size = Math.min(chunk.byteLength, total - sent);
      if (size === 0) {
        controller.close();
        return;
      }
      controller.enqueue(chunk.subarray(0, size));
      sent += size;
    },
  });
}

describe('readJsonObject', () => {
  it('parses a JSON object, whatever the Content-Type', async () => {
    expect(
      await readJsonObject(post('{"model":"default"}', { 'content-type': 'text/plain' })),
    ).toEqual({
      ok: true,
      value: { model: 'default' },
    });
  });

  it.each([
    ['not JSON', '{"model":', 'not valid JSON'],
    ['an array', '[1,2]', 'must be a JSON object'],
    ['null', 'null', 'must be a JSON object'],
    ['a string', '"hello"', 'must be a JSON object'],
    ['empty', '', 'not valid JSON'],
  ])('fails for a body that is %s', async (_name, body, message) => {
    const result = await readJsonObject(post(body));
    expect(result).toEqual({ ok: false, message: expect.stringContaining(message) as string });
  });

  it('fails for a request without a body', async () => {
    const result = await readJsonObject(new Request('http://127.0.0.1/', { method: 'POST' }));
    expect(result.ok).toBe(false);
  });

  it('fails for invalid UTF-8', async () => {
    const result = await readJsonObject(post(new Uint8Array([0x7b, 0xff, 0x7d])));
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('not valid JSON') as string,
    });
  });

  it('accepts exactly 20 MB and fails above it, by Content-Length or by counting', async () => {
    expect(MAX_BODY_BYTES).toBe(20 * 1024 * 1024);
    const fits = `{"pad":"${' '.repeat(MAX_BODY_BYTES - 10)}"}`;
    expect(fits).toHaveLength(MAX_BODY_BYTES);
    expect((await readJsonObject(post(fits))).ok).toBe(true);

    const declared = await readJsonObject(
      post('{}', { 'content-length': String(MAX_BODY_BYTES + 1) }),
    );
    expect(declared).toEqual({
      ok: false,
      message: expect.stringContaining('larger than') as string,
    });

    const streamed = new Request('http://127.0.0.1/', {
      method: 'POST',
      body: streamOf(MAX_BODY_BYTES + 1),
      duplex: 'half',
    });
    expect(await readJsonObject(streamed)).toEqual({
      ok: false,
      message: expect.stringContaining('larger than') as string,
    });
  });
});

describe('redact', () => {
  it.each([
    ['Authorization: Bearer abc.def-123', 'Authorization: [redacted]'],
    ['{"authorization":"Bearer abc"}', '{"authorization":"[redacted]"}'],
    ['x-api-key: secret-value', 'x-api-key: [redacted]'],
    ['sent Bearer tok_123 upstream', 'sent Bearer [redacted] upstream'],
    ['Incorrect API key provided: sk-proj-abcdef123456', 'Incorrect API key provided: [redacted]'],
    ['key sk-ant-api03-xyz_789abc', 'key [redacted]'],
    ['GET /v1/harness/context 200', 'GET /v1/harness/context 200'],
  ])('%s', (input, output) => {
    expect(redact(input)).toBe(output);
  });
});

describe('in-memory token verifier', () => {
  const claims = {
    harnessId: 'alice/hello',
    harnessVersion: '1.0.0',
    launchId: 'launch-1',
    issuedAt: 1,
    locale: 'en',
  };

  it('returns the claims of a live token, as a frozen copy', () => {
    const verifier = createInMemoryTokenVerifier();
    const token = verifier.issue(claims);
    const verified = verifier.verify(token);
    expect(verified).toEqual(claims);
    expect(Object.isFrozen(verified)).toBe(true);
  });

  it('rejects unknown, altered and revoked tokens', () => {
    const verifier = createInMemoryTokenVerifier();
    const token = verifier.issue(claims);
    expect(verifier.verify('')).toBeNull();
    expect(verifier.verify(`${token}x`)).toBeNull();
    expect(verifier.verify(token.slice(0, -1))).toBeNull();
    verifier.revoke(token);
    expect(verifier.verify(token)).toBeNull();
    verifier.revoke(token);
  });
});
