/**
 * The Provider table and the adapters built from it: the table matches gateway-protocol.md §6,
 * every Provider id gives a working AI SDK model that reaches its endpoint with the Connection's
 * credentials, a preset is a table row and nothing else, and the adapters that cannot talk to the
 * fake Provider (Anthropic, Google) still answer the Gateway's wire format end to end against a
 * canned upstream. The OpenAI-wire adapters are covered scenario by scenario in
 * `conformance.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { generateText, streamText } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLanguageModel } from '../src/adapters.js';
import { PROVIDERS, PROVIDER_IDS, findProvider } from '../src/providers.js';
import type { ProviderInfo } from '../src/providers.js';
import { serveLoopback } from '../src/serve.js';
import { startFakeProvider } from '../src/testing/fake-provider.js';
import type { FakeProvider } from '../src/testing/fake-provider.js';
import type { ConnectionSecret, Gateway } from '../src/index.js';
import { claims, startGateway } from './support/gateway.js';

const API_KEY = 'sk-test-connection-key-0123456789';

/** The Provider ids in the first column of gateway-protocol.md §6. */
function protocolProviderIds(): string[] {
  const doc = readFileSync(
    new URL('../../../docs/tech/gateway-protocol.md', import.meta.url),
    'utf8',
  );
  const section = doc.slice(doc.indexOf('## 6.'), doc.indexOf('## 7.'));
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1] ?? '');
}

describe('the Provider table', () => {
  it('lists exactly the Provider ids of gateway-protocol.md §6, in order', () => {
    expect(protocolProviderIds()).toHaveLength(14);
    expect(PROVIDER_IDS).toEqual(protocolProviderIds());
    expect(PROVIDERS.map((provider) => provider.id)).toEqual(PROVIDER_IDS);
  });

  it('gives every Provider but the generic openai-compatible a default base URL', () => {
    for (const provider of PROVIDERS) {
      if (provider.id === 'openai-compatible') expect(provider.baseUrl).toBeUndefined();
      else expect(provider.baseUrl, provider.id).toMatch(/^(https:\/\/|http:\/\/127\.0\.0\.1:)/);
    }
  });

  it('needs a key everywhere except Ollama, LM Studio and the generic openai-compatible', () => {
    expect(PROVIDERS.filter((provider) => !provider.requiresKey).map(({ id }) => id)).toEqual([
      'ollama',
      'lmstudio',
      'openai-compatible',
    ]);
  });

  it('serves openai-compatible:<name> from the openai-compatible row', () => {
    expect(findProvider('openai-compatible:vllm')?.id).toBe('openai-compatible');
    expect(findProvider('acme')).toBeUndefined();
  });
});

/** A `fetch` that records every request and answers it with an upstream 500. */
function recordingFetch() {
  const requests: { url: string; headers: Headers }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    return Promise.resolve(Response.json({}, { status: 500 }));
  };
  return { requests, fetch };
}

/** The credential headers a request carried, whichever scheme the Provider uses. */
function credentialOf(headers: Headers): string | null {
  return headers.get('authorization') ?? headers.get('x-api-key') ?? headers.get('x-goog-api-key');
}

describe('createLanguageModel', () => {
  it.each(PROVIDERS.map((provider) => [provider.id, provider] as const))(
    'builds a %s model that calls its endpoint with the Connection key',
    async (providerId, provider) => {
      const recorded = recordingFetch();
      const connection: ConnectionSecret = { apiKey: API_KEY };
      // The generic openai-compatible Provider has no default endpoint.
      if (provider.baseUrl === undefined) connection.baseUrl = 'http://127.0.0.1:8000/v1';
      const model = createLanguageModel({
        providerId,
        model: 'some-model',
        connection,
        fetch: recorded.fetch,
      });
      expect(model.modelId).toBe('some-model');
      await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
      expect(recorded.requests).toHaveLength(1);
      const [request] = recorded.requests;
      expect(request?.url.startsWith(`${connection.baseUrl ?? provider.baseUrl ?? ''}/`)).toBe(
        true,
      );
      expect(credentialOf(request?.headers ?? new Headers())).toMatch(API_KEY);
    },
  );

  it.each(['ollama', 'lmstudio'])(
    'builds %s from an empty Connection, sending no key',
    async (id) => {
      const recorded = recordingFetch();
      const model = createLanguageModel({
        providerId: id,
        model: 'qwen3:8b',
        connection: {},
        fetch: recorded.fetch,
      });
      await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
      const [request] = recorded.requests;
      expect(request?.url).toBe(`${findProvider(id)?.baseUrl ?? ''}/chat/completions`);
      expect(request?.headers.get('authorization')).toBeNull();
    },
  );

  it('prefers the Connection’s base URL to the Provider’s default', async () => {
    const recorded = recordingFetch();
    const model = createLanguageModel({
      providerId: 'ollama',
      model: 'qwen3:8b',
      connection: { baseUrl: 'http://127.0.0.1:11500/v1' },
      fetch: recorded.fetch,
    });
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
    expect(recorded.requests[0]?.url).toBe('http://127.0.0.1:11500/v1/chat/completions');
  });

  it.each(PROVIDERS.filter((provider) => provider.requiresKey).map(({ id }) => id))(
    'refuses a %s Connection without an API key, never reading one from the environment',
    (providerId) => {
      for (const connection of [{}, { apiKey: '' }]) {
        expect(() =>
          createLanguageModel({ providerId, model: 'm', connection, fetch: globalThis.fetch }),
        ).toThrow(/no API key/);
      }
    },
  );

  it('refuses an openai-compatible Connection without a base URL', () => {
    expect(() =>
      createLanguageModel({
        providerId: 'openai-compatible:vllm',
        model: 'm',
        connection: { apiKey: API_KEY, baseUrl: '' },
        fetch: globalThis.fetch,
      }),
    ).toThrow(/no base URL/);
  });

  it('refuses a Provider id no row serves', () => {
    expect(() =>
      createLanguageModel({
        providerId: 'acme',
        model: 'm',
        connection: { apiKey: API_KEY },
        fetch: globalThis.fetch,
      }),
    ).toThrow(/No Provider adapter/);
  });
});

describe('a preset added as a table row only', () => {
  let fake: FakeProvider;

  beforeAll(async () => {
    fake = await startFakeProvider({ apiKey: API_KEY });
  });

  afterAll(async () => {
    await fake.close();
  });

  /** A throwaway preset: the Provider table plus one row, and no other change anywhere. */
  const withAcme = (baseUrl: string): ProviderInfo[] => [
    ...PROVIDERS,
    {
      id: 'acme',
      displayName: 'Acme AI',
      adapter: 'openai-compatible',
      baseUrl,
      requiresKey: true,
      supportsModelList: true,
      docsUrl: 'https://acme.example/docs',
      keyPlaceholder: 'acme-...',
    },
  ];

  it('works through the openai-compatible adapter, streamed or not', async () => {
    const model = createLanguageModel(
      {
        providerId: 'acme',
        model: 'fake/echo',
        connection: { apiKey: API_KEY },
        fetch: globalThis.fetch,
      },
      withAcme(fake.url),
    );
    const result = await generateText({ model, prompt: 'hello acme', maxRetries: 0 });
    expect(result.text).toBe('hello acme');
    expect(result.usage.inputTokens).toBe(2);
    const stream = streamText({ model, prompt: 'hello again acme', maxRetries: 0 });
    expect(await stream.text).toBe('hello again acme');
    expect(fake.requests.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${API_KEY}`,
      `Bearer ${API_KEY}`,
    ]);
  });

  it('is unknown without its row', () => {
    expect(() =>
      createLanguageModel({
        providerId: 'acme',
        model: 'fake/echo',
        connection: { apiKey: API_KEY },
        fetch: globalThis.fetch,
      }),
    ).toThrow(/No Provider adapter/);
  });
});

/**
 * Anthropic and Google through the Gateway HTTP seam, against a local upstream answering each
 * Provider's own wire format with canned bodies. Their Connection's base URL points there.
 */
describe.each([
  {
    providerId: 'anthropic',
    path: '/v1/messages',
    reply: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'Hello from Anthropic.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 4 },
    },
    error: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    text: 'Hello from Anthropic.',
    usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
    /** Where the image URL is in the upstream request. */
    image: (body: unknown) =>
      (body as { messages: { content: { type: string; source?: unknown }[] }[] }).messages[0]
        ?.content[1],
    expectedImage: { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
  },
  {
    providerId: 'google',
    path: '/v1beta/models/gemini-2.5-flash:generateContent',
    reply: {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hello from Gemini.' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4, totalTokenCount: 10 },
    },
    error: { error: { code: 401, message: 'API key not valid.', status: 'UNAUTHENTICATED' } },
    text: 'Hello from Gemini.',
    usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
    image: (body: unknown) =>
      (body as { contents: { parts: unknown[] }[] }).contents[0]?.parts.find(
        (part) => typeof part === 'object' && part !== null && 'fileData' in part,
      ),
    expectedImage: {
      fileData: { mimeType: 'image/png', fileUri: 'https://example.com/cat.png' },
    },
  },
])('the $providerId adapter through the Gateway', (provider) => {
  const model = provider.providerId === 'anthropic' ? 'claude-haiku-4-5' : 'gemini-2.5-flash';
  const requests: { path: string; headers: Headers; body: unknown }[] = [];
  let status = 200;
  let upstream: { origin: string; close(): Promise<void> };
  let gateway: Gateway;
  let url: string;
  let token: string;

  beforeAll(async () => {
    upstream = await serveLoopback(
      async (request) => {
        requests.push({
          path: new URL(request.url).pathname,
          headers: request.headers,
          body: await request.json(),
        });
        return Response.json(status === 200 ? provider.reply : provider.error, { status });
      },
      { host: '127.0.0.1', port: 0 },
    );
    const base = provider.providerId === 'anthropic' ? '/v1' : '/v1beta';
    const started = await startGateway({
      getConnection: (id) =>
        Promise.resolve(
          id === provider.providerId
            ? { apiKey: API_KEY, baseUrl: `${upstream.origin}${base}` }
            : null,
        ),
    });
    gateway = started.gateway;
    url = started.url;
    token = gateway.issueToken(claims());
  });

  afterAll(async () => {
    await gateway.close();
    await upstream.close();
  });

  afterEach(() => {
    requests.length = 0;
    status = 200;
  });

  const complete = (body: unknown) =>
    fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  it('answers an OpenAI chat.completion with the resolved model and usage', async () => {
    const response = await complete({
      model: `${provider.providerId}/${model}`,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: 'chat.completion',
      model: `${provider.providerId}/${model}`,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: provider.text },
          finish_reason: 'stop',
        },
      ],
      usage: provider.usage,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe(provider.path);
    expect(credentialOf(requests[0]?.headers ?? new Headers())).toBe(API_KEY);
    // The Gateway Token never reaches the Provider.
    expect([...(requests[0]?.headers.values() ?? [])].join('\n')).not.toContain(token);
  });

  it('hands an http(s) image URL to the Provider instead of downloading it', async () => {
    const response = await complete({
      model: `${provider.providerId}/${model}`,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(provider.image(requests[0]?.body)).toEqual(provider.expectedImage);
  });

  it('maps an upstream 401 to 502 provider_error', async () => {
    status = 401;
    const response = await complete({
      model: `${provider.providerId}/${model}`,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: 'provider_error', type: 'provider', provider_status: 401 },
    });
  });
});
