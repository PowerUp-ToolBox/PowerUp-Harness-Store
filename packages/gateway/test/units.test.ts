/**
 * The Gateway's small building blocks on their own: the JSON body reader, log redaction, the
 * in-memory token table, explicit model ids, Provider error mapping and usage translation.
 */
import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, readJsonObject } from '../src/body.js';
import { redact } from '../src/logging.js';
import { toFinishReason, toUsage } from '../src/openai/translate.js';
import { providerError } from '../src/provider-errors.js';
import { PROVIDER_IDS, parseModelRef } from '../src/providers.js';
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

describe('parseModelRef', () => {
  it('splits an explicit id at the first slash', () => {
    expect(parseModelRef('openrouter/anthropic/claude-sonnet-4-5')).toEqual({
      kind: 'explicit',
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });
    expect(parseModelRef('openai-compatible:vllm-2/qwen3:8b')).toEqual({
      kind: 'explicit',
      providerId: 'openai-compatible:vllm-2',
      model: 'qwen3:8b',
    });
  });

  it('accepts every Provider id of the protocol', () => {
    expect(PROVIDER_IDS).toHaveLength(14);
    for (const id of PROVIDER_IDS) {
      expect(parseModelRef(`${id}/m`)).toEqual({ kind: 'explicit', providerId: id, model: 'm' });
    }
  });

  it('reads a value without a slash as a Slot name', () => {
    expect(parseModelRef('default')).toEqual({ kind: 'slot', slot: 'default' });
  });

  it.each([
    'acme/m',
    'openai-compatible:/m',
    'openai-compatible:-x/m',
    'OpenAI/m',
    'openai/',
    'openai/a b',
  ])('rejects %s', (model) => {
    expect(parseModelRef(model)).toBeNull();
  });
});

describe('providerError', () => {
  const apiCallError = (fields: Partial<ConstructorParameters<typeof APICallError>[0]>) =>
    new APICallError({
      message: 'Bad Request',
      url: 'http://127.0.0.1/v1/chat/completions',
      requestBodyValues: {},
      ...fields,
    });

  it('takes the status, message and code from an OpenAI-shaped error body', () => {
    const error = apiCallError({
      statusCode: 400,
      responseBody: JSON.stringify({ error: { message: 'Context too long.', code: 'too_long' } }),
    });
    expect(providerError(error, undefined)).toEqual({
      code: 'provider_error',
      message: expect.stringContaining('Context too long.') as string,
      fields: {
        provider_status: 400,
        provider_message: 'Context too long.',
        provider_code: 'too_long',
      },
    });
  });

  it('falls back to the raw body, cut to 1000 characters', () => {
    const error = apiCallError({ statusCode: 503, responseBody: 'x'.repeat(5000) });
    expect(providerError(error, undefined).fields).toEqual({
      provider_status: 503,
      provider_message: 'x'.repeat(1000),
    });
  });

  it('uses the error message when there is no response, without a status', () => {
    const error = apiCallError({ message: 'Cannot connect to API: ECONNREFUSED' });
    expect(providerError(error, undefined).fields).toEqual({
      provider_message: 'Cannot connect to API: ECONNREFUSED',
    });
  });

  it("redacts the Connection's API key wherever the Provider echoes it", () => {
    const key = 'my-plain-key-without-prefix';
    const error = apiCallError({
      statusCode: 401,
      responseBody: JSON.stringify({ error: { message: `Key ${key} is invalid.`, code: key } }),
    });
    const mapped = providerError(error, key);
    expect(JSON.stringify(mapped)).not.toContain(key);
    expect(mapped.fields.provider_message).toBe('Key [redacted] is invalid.');
  });
});

describe('usage and finish reasons', () => {
  const usage = (input: number | undefined, output: number | undefined, cached?: number) => ({
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: cached,
      cacheWriteTokens: undefined,
    },
    outputTokens: output,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
  });

  it('reports usage only when both token counts are known, never estimated', () => {
    expect(toUsage(usage(3, 4))).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });
    expect(toUsage(usage(3, undefined))).toBeUndefined();
    expect(toUsage(usage(undefined, 4))).toBeUndefined();
  });

  it('includes cached prompt tokens when there are some', () => {
    expect(toUsage(usage(10, 1, 6))).toEqual({
      prompt_tokens: 10,
      completion_tokens: 1,
      total_tokens: 11,
      prompt_tokens_details: { cached_tokens: 6 },
    });
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['tool-calls', 'tool_calls'],
    ['content-filter', 'content_filter'],
    ['error', 'stop'],
    ['other', 'stop'],
  ] as const)('maps the finish reason %s to %s', (reason, mapped) => {
    expect(toFinishReason(reason)).toBe(mapped);
  });
});
