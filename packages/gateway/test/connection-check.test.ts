/**
 * Connection tests and model listing: against the fake Provider for the OpenAI-wire Providers, and
 * against an injected `fetch` answering in Anthropic's, Google's and OpenRouter's own formats,
 * which the fake does not speak. Nothing leaves loopback.
 */
import { createServer } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CATALOGUE } from '../src/catalogue.js';
import { listModels, testConnection } from '../src/connection-check.js';
import { FAKE_SCENARIOS, startFakeProvider } from '../src/testing/fake-provider.js';
import type { FakeProvider } from '../src/testing/fake-provider.js';

const KEY = 'sk-fake-connection-key-0123456789';

let fake: FakeProvider;
beforeAll(async () => {
  fake = await startFakeProvider({ apiKey: KEY, aliases: { 'glm-4.5': 'fake/echo' } });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
});

describe('OpenAI-wire Providers that list their models', () => {
  it('list the models of GET /models, sending the key as a Bearer token', async () => {
    const listed = await listModels({
      providerId: 'openai-compatible:fake',
      baseUrl: fake.url,
      apiKey: KEY,
      fetch: globalThis.fetch,
    });
    expect(listed).toEqual({
      ok: true,
      models: [...FAKE_SCENARIOS, 'glm-4.5'].map((id) => ({ id })),
    });
    expect(fake.requests).toMatchObject([
      { method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${KEY}` } },
    ]);
  });

  it('pass the test with GET /models, which also lists the models', async () => {
    const tested = await testConnection({
      providerId: 'ollama',
      baseUrl: fake.url,
      apiKey: KEY,
      fetch: globalThis.fetch,
    });
    expect(tested).toMatchObject({
      ok: true,
      models: expect.arrayContaining([{ id: 'fake/echo' }]) as unknown[],
    });
    expect(fake.requests.map((request) => request.path)).toEqual(['/v1/models']);
  });

  it("fail the test with the Provider's own error text for a bad key", async () => {
    const tested = await testConnection({
      providerId: 'openai',
      baseUrl: fake.url,
      apiKey: 'sk-wrong-key-0123456789',
      fetch: globalThis.fetch,
    });
    expect(tested).toEqual({
      ok: false,
      reason: 'provider_error',
      detail: 'Incorrect API key provided.',
    });
  });

  it('send no Authorization header without a key', async () => {
    await testConnection({ providerId: 'lmstudio', baseUrl: fake.url, fetch: globalThis.fetch });
    expect(fake.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('report a refused connection with its cause, not a bare "fetch failed"', async () => {
    const tested = await testConnection({
      providerId: 'ollama',
      baseUrl: `http://127.0.0.1:${String(await closedPort())}/v1`,
      fetch: globalThis.fetch,
    });
    expect(tested).toMatchObject({
      ok: false,
      reason: 'provider_error',
      detail: expect.stringMatching(/^fetch failed: .*ECONNREFUSED/) as string,
    });
  });

  it('report a Provider that does not answer in time as a timeout, with no app-written text', async () => {
    const hanging: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const tested = await testConnection({
      providerId: 'groq',
      apiKey: KEY,
      fetch: hanging,
      timeoutMs: 20,
    });
    expect(tested).toEqual({ ok: false, reason: 'provider_timeout' });
  });

  it('fail the listing as an unexpected response when the answer is not a model list', async () => {
    const notAList: typeof globalThis.fetch = () => Promise.resolve(Response.json({ models: [] }));
    await expect(
      listModels({ providerId: 'deepseek', apiKey: KEY, fetch: notAList }),
    ).resolves.toEqual({ ok: false, reason: 'unexpected_response' });
  });

  it('fail the test as an unexpected response when the answer is not JSON', async () => {
    const webPage: typeof globalThis.fetch = () =>
      Promise.resolve(new Response('<!doctype html><title>Router</title>', { status: 200 }));
    await expect(
      testConnection({
        providerId: 'openai-compatible',
        baseUrl: 'http://10.0.0.1',
        fetch: webPage,
      }),
    ).resolves.toEqual({ ok: false, reason: 'unexpected_response' });
  });

  it('throw for a target the caller should have checked: an unknown Provider, no base URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(testConnection({ providerId: 'acme', fetch })).rejects.toThrow(
      'Unknown Provider acme.',
    );
    await expect(listModels({ providerId: 'acme', fetch })).rejects.toThrow('Unknown Provider');
    await expect(listModels({ providerId: 'openai-compatible', fetch })).rejects.toThrow(
      /no base URL/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redact the key from error text the Provider echoes', async () => {
    const echoing: typeof globalThis.fetch = () =>
      Promise.resolve(
        Response.json({ error: { message: `Key ${KEY} is revoked.` } }, { status: 401 }),
      );
    await expect(
      testConnection({ providerId: 'moonshot', apiKey: KEY, fetch: echoing }),
    ).resolves.toEqual({
      ok: false,
      reason: 'provider_error',
      detail: 'Key [redacted] is revoked.',
    });
  });
});

describe('Providers without a model list or catalogue (Zhipu, MiniMax, Doubao)', () => {
  it('pass the test with a 1-token completion to the model the User names', async () => {
    const tested = await testConnection({
      providerId: 'zhipu',
      baseUrl: fake.url,
      apiKey: KEY,
      model: 'glm-4.5',
      fetch: globalThis.fetch,
    });
    expect(tested).toEqual({ ok: true });
    expect(fake.requests).toMatchObject([
      { method: 'POST', path: '/v1/chat/completions', body: { model: 'glm-4.5', max_tokens: 1 } },
    ]);
  });

  it('fail the test with the Provider text for a bad key, and throw without a model name', async () => {
    await expect(
      testConnection({
        providerId: 'doubao',
        baseUrl: fake.url,
        apiKey: 'wrong-0123456789',
        model: 'glm-4.5',
        fetch: globalThis.fetch,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'provider_error',
      detail: 'Incorrect API key provided.',
    });
    await expect(
      testConnection({ providerId: 'minimax', apiKey: KEY, fetch: globalThis.fetch }),
    ).rejects.toThrow('Testing the Provider minimax needs a model name.');
  });

  it('list nothing: the User types the model name', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(listModels({ providerId: 'zhipu', apiKey: KEY, fetch })).resolves.toEqual({
      ok: true,
      models: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (typeof address !== 'object' || address === null) throw new Error('No port');
  return address.port;
}

/** A `fetch` that records each request and answers with `reply(path)`. */
function cannedFetch(reply: (path: string) => Response) {
  const requests: { url: string; headers: Headers; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    requests.push({
      url: request.url,
      headers: request.headers,
      body: text === '' ? null : (JSON.parse(text) as unknown),
    });
    return reply(new URL(request.url).pathname);
  };
  return { fetch, requests };
}

describe('Anthropic and Google', () => {
  it('list the catalogue without a network call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(listModels({ providerId: 'anthropic', fetch })).resolves.toEqual({
      ok: true,
      models: MODEL_CATALOGUE.anthropic,
    });
    await expect(listModels({ providerId: 'google', fetch })).resolves.toEqual({
      ok: true,
      models: MODEL_CATALOGUE.google,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Anthropic: a 1-token message to the smallest catalogue model; a bad key fails with its text', async () => {
    let status = 200;
    const { fetch, requests } = cannedFetch(() =>
      status === 200
        ? Response.json({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-5-5',
            content: [{ type: 'text', text: 'Hi' }],
            stop_reason: 'max_tokens',
            stop_sequence: null,
            usage: { input_tokens: 8, output_tokens: 1 },
          })
        : Response.json(
            {
              type: 'error',
              error: { type: 'authentication_error', message: 'invalid x-api-key' },
            },
            { status },
          ),
    );
    await expect(testConnection({ providerId: 'anthropic', apiKey: KEY, fetch })).resolves.toEqual({
      ok: true,
      models: MODEL_CATALOGUE.anthropic,
    });
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(requests[0]?.headers.get('x-api-key')).toBe(KEY);
    expect(requests[0]?.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 1 });

    status = 401;
    await expect(testConnection({ providerId: 'anthropic', apiKey: KEY, fetch })).resolves.toEqual({
      ok: false,
      reason: 'provider_error',
      detail: 'invalid x-api-key',
    });
  });

  it('Google: a 1-token generateContent to the smallest catalogue model; a bad key fails with its text', async () => {
    let status = 200;
    const { fetch, requests } = cannedFetch(() =>
      status === 200
        ? Response.json({
            candidates: [
              { content: { role: 'model', parts: [{ text: 'Hi' }] }, finishReason: 'MAX_TOKENS' },
            ],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
          })
        : Response.json(
            { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } },
            { status },
          ),
    );
    await expect(
      testConnection({ providerId: 'google', apiKey: KEY, fetch }),
    ).resolves.toMatchObject({ ok: true, models: MODEL_CATALOGUE.google });
    expect(requests[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
    );
    expect(requests[0]?.body).toMatchObject({ generationConfig: { maxOutputTokens: 1 } });

    status = 400;
    await expect(testConnection({ providerId: 'google', apiKey: KEY, fetch })).resolves.toEqual({
      ok: false,
      reason: 'provider_error',
      detail: 'API key not valid.',
    });
  });

  it('test with the model the User names instead of the catalogue one', async () => {
    const { fetch, requests } = cannedFetch(() =>
      Response.json({
        candidates: [
          { content: { role: 'model', parts: [{ text: 'Hi' }] }, finishReason: 'MAX_TOKENS' },
        ],
      }),
    );
    await expect(
      testConnection({ providerId: 'google', apiKey: KEY, model: 'gemini-3.6-flash', fetch }),
    ).resolves.toMatchObject({ ok: true, models: MODEL_CATALOGUE.google });
    expect(requests[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    );
  });
});

describe('OpenRouter', () => {
  it('tests the key with GET /key, since its model list needs none, then lists the models', async () => {
    let keyStatus = 200;
    const { fetch, requests } = cannedFetch((path) => {
      if (path === '/api/v1/key') {
        return keyStatus === 200
          ? Response.json({ data: { label: 'sk-or-v1-abc...' } })
          : Response.json({ error: { message: 'User not found.', code: 401 } }, { status: 401 });
      }
      return Response.json({
        data: [{ id: 'anthropic/claude-sonnet-5-5' }, { id: 'openai/gpt-5' }],
      });
    });
    await expect(testConnection({ providerId: 'openrouter', apiKey: KEY, fetch })).resolves.toEqual(
      {
        ok: true,
        models: [{ id: 'anthropic/claude-sonnet-5-5' }, { id: 'openai/gpt-5' }],
      },
    );
    expect(requests.map((request) => request.url)).toEqual([
      'https://openrouter.ai/api/v1/key',
      'https://openrouter.ai/api/v1/models',
    ]);
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);

    keyStatus = 401;
    await expect(testConnection({ providerId: 'openrouter', apiKey: KEY, fetch })).resolves.toEqual(
      {
        ok: false,
        reason: 'provider_error',
        detail: 'User not found.',
      },
    );
  });

  it('passes a valid key even when the listing then fails', async () => {
    const { fetch } = cannedFetch((path) =>
      path === '/api/v1/key'
        ? Response.json({ data: {} })
        : new Response('Bad gateway', { status: 502 }),
    );
    await expect(testConnection({ providerId: 'openrouter', apiKey: KEY, fetch })).resolves.toEqual(
      {
        ok: true,
      },
    );
  });
});
