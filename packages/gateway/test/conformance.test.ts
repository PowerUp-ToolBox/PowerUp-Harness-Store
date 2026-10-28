/**
 * The conformance suite: one scenario set, run through the Gateway HTTP seam against every
 * Provider whose adapter can be pointed at the fake Provider (the OpenAI-wire adapters: `openai`,
 * `openrouter` and every `openai-compatible` row). The Providers come from the Provider table
 * itself, so a new preset row is covered without touching this file. Each Provider's Connection
 * points at the fake, and every scenario asserts the same wire behaviour the Gateway's own
 * `openai-compatible` path established, whichever adapter carried the request.
 *
 * Real-Provider runs live in `conformance-live.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROVIDERS } from '../src/providers.js';
import type { AdapterKind } from '../src/providers.js';
import { startFakeProvider } from '../src/testing/fake-provider.js';
import type { FakeProvider } from '../src/testing/fake-provider.js';
import type { Gateway, GatewayOptions } from '../src/index.js';
import { claims, startGateway } from './support/gateway.js';
import { deltas, readSse, textOf } from './support/sse.js';

const API_KEY = 'sk-fake-connection-key-0123456789';

/** The adapters that speak the OpenAI wire format, and so can talk to the fake. */
const OPENAI_WIRE: readonly AdapterKind[] = ['openai', 'openrouter', 'openai-compatible'];
const PROVIDER_IDS_ON_FAKE = PROVIDERS.filter((provider) =>
  OPENAI_WIRE.includes(provider.adapter),
).map((provider) => provider.id);

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider({
    apiKey: API_KEY,
    slowMs: 2000,
    // An OpenRouter-style compound model name, served by the echo scenario.
    aliases: { 'anthropic/claude-sonnet-4-5': 'fake/echo' },
  });
});

afterAll(async () => {
  await fake.close();
});

const started: Gateway[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((gateway) => gateway.close()));
  fake.reset();
});

/** A Gateway whose only Connection is `providerId`'s, pointing at the fake. */
async function start(providerId: string, overrides: Partial<GatewayOptions> = {}) {
  const test = await startGateway({
    getConnection: (id) =>
      Promise.resolve(id === providerId ? { baseUrl: fake.url, apiKey: API_KEY } : null),
    ...overrides,
  });
  started.push(test.gateway);
  return { url: test.url, token: test.gateway.issueToken(claims()) };
}

function complete(url: string, token: string, body: unknown) {
  return fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const hello = [{ role: 'user', content: 'hello there world' }];

const lookup = {
  type: 'function',
  function: {
    name: 'lookup',
    description: 'Looks a word up.',
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
  },
};
const define = { ...lookup, function: { ...lookup.function, name: 'define' } };

interface Completion {
  model: string;
  choices: {
    message: {
      role: string;
      content: string | null;
      tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
  usage?: Record<string, unknown>;
}

interface ToolCallDelta {
  index: number;
  id?: string;
  function: { name?: string; arguments?: string };
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

/** Streamed tool calls, assembled by index. */
function streamedToolCalls(body: Awaited<ReturnType<typeof readSse>>) {
  const calls: { id?: string; name?: string; arguments: string }[] = [];
  for (const delta of deltas(body)) {
    for (const fragment of (delta.tool_calls as ToolCallDelta[] | undefined) ?? []) {
      const call = (calls[fragment.index] ??= { arguments: '' });
      call.id ??= fragment.id;
      call.name ??= fragment.function.name;
      call.arguments += fragment.function.arguments ?? '';
    }
  }
  return calls.map((call) => ({ ...call, arguments: JSON.parse(call.arguments) as unknown }));
}

describe.each(PROVIDER_IDS_ON_FAKE)('conformance: %s', (providerId) => {
  const model = (scenario: string) => `${providerId}/${scenario}`;

  it('answers a non-streaming echo with the resolved model and usage', async () => {
    const { url, token } = await start(providerId);
    const response = await complete(url, token, { model: model('fake/echo'), messages: hello });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Completion;
    expect(body.model).toBe(model('fake/echo'));
    expect(body.choices[0]).toEqual({
      index: 0,
      message: { role: 'assistant', content: 'hello there world' },
      finish_reason: 'stop',
    });
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 });
    // The Connection's key reached the Provider, and the model name went through unchanged.
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(fake.requests[0]?.body).toMatchObject({ model: 'fake/echo' });
  });

  it('streams an echo: role chunk, content, finish chunk, usage chunk, [DONE]', async () => {
    const { url, token } = await start(providerId);
    const response = await complete(url, token, {
      model: model('fake/echo-stream'),
      messages: hello,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const body = await readSse(response);
    expect(body.done).toBe(true);
    expect(deltas(body)[0]).toEqual({ role: 'assistant' });
    expect(textOf(body)).toBe('hello there world');
    const last = body.chunks.at(-1) as { choices: unknown[]; usage: unknown };
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({ prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 });
    const finish = body.chunks.at(-2) as { choices: { delta: unknown; finish_reason: unknown }[] };
    expect(finish.choices[0]).toMatchObject({ delta: {}, finish_reason: 'stop' });
  });

  it('sends a json_schema response format with the request’s strict (false when absent)', async () => {
    const { url, token } = await start(providerId);
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    for (const [strict, upstream] of [
      [false, false],
      [true, true],
      [undefined, false],
    ] as const) {
      fake.reset();
      const response = await complete(url, token, {
        model: model('fake/echo'),
        messages: hello,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'r', schema, ...(strict !== undefined && { strict }) },
        },
      });
      expect(response.status).toBe(200);
      expect(fake.requests[0]?.body).toMatchObject({
        response_format: { type: 'json_schema', json_schema: { name: 'r', strict: upstream } },
      });
    }
  });

  it('sends stop sequences upstream, given as a string or a list, streamed or not', async () => {
    const { url, token } = await start(providerId);
    for (const [stop, upstream] of [
      ['END', ['END']],
      [
        ['END', '\n\n'],
        ['END', '\n\n'],
      ],
    ] as const) {
      for (const stream of [false, true]) {
        fake.reset();
        const response = await complete(url, token, {
          model: model('fake/echo'),
          messages: hello,
          stop,
          stream,
        });
        expect(response.status).toBe(200);
        await response.text();
        expect(fake.requests[0]?.body, JSON.stringify({ stop, stream })).toMatchObject({
          stop: upstream,
        });
      }
    }
  });

  it('returns a tool call', async () => {
    const { url, token } = await start(providerId);
    const response = await complete(url, token, {
      model: model('fake/tool-call'),
      messages: hello,
      tools: [lookup],
    });
    expect(response.status).toBe(200);
    const [choice] = ((await response.json()) as Completion).choices;
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.tool_calls).toHaveLength(1);
    const [call] = choice?.message.tool_calls ?? [];
    expect(call).toMatchObject({ id: 'call_0', type: 'function', function: { name: 'lookup' } });
    expect(JSON.parse(call?.function.arguments ?? '')).toEqual({ input: 'hello there world' });
  });

  it('streams a tool call', async () => {
    const { url, token } = await start(providerId);
    const response = await complete(url, token, {
      model: model('fake/tool-call'),
      messages: hello,
      tools: [lookup],
      stream: true,
    });
    expect(response.status).toBe(200);
    const body = await readSse(response);
    expect(streamedToolCalls(body)).toEqual([
      { id: 'call_0', name: 'lookup', arguments: { input: 'hello there world' } },
    ]);
    const finish = body.chunks.at(-1) as { choices: { finish_reason: unknown }[] };
    expect(finish.choices[0]?.finish_reason).toBe('tool_calls');
    expect(body.done).toBe(true);
  });

  it('returns parallel tool calls in order, streamed or not', async () => {
    const { url, token } = await start(providerId);
    const request = { model: model('fake/tool-call-parallel'), messages: hello };
    const plain = await complete(url, token, { ...request, tools: [lookup, define] });
    const calls = ((await plain.json()) as Completion).choices[0]?.message.tool_calls ?? [];
    expect(calls.map((call) => [call.id, call.function.name])).toEqual([
      ['call_0', 'lookup'],
      ['call_1', 'define'],
    ]);
    const streamed = await complete(url, token, {
      ...request,
      tools: [lookup, define],
      stream: true,
    });
    expect(streamedToolCalls(await readSse(streamed))).toEqual([
      { id: 'call_0', name: 'lookup', arguments: { input: 'hello there world' } },
      { id: 'call_1', name: 'define', arguments: { input: 'hello there world' } },
    ]);
  });

  it('sends no usage chunk when the Provider reports no usage', async () => {
    const { url, token } = await start(providerId);
    const response = await complete(url, token, {
      model: model('fake/stream-no-usage'),
      messages: hello,
      stream: true,
      stream_options: { include_usage: true },
    });
    const body = await readSse(response);
    expect(textOf(body)).toBe('hello there world');
    expect(body.chunks.some((chunk) => 'usage' in chunk)).toBe(false);
    expect(body.done).toBe(true);
  });

  it.each([
    ['an http(s) URL', 'https://example.com/cat.png'],
    ['a data URL', 'data:image/png;base64,iVBORw0KGgo='],
  ])('hands an image given as %s to the Provider', async (_name, imageUrl) => {
    const { url, token } = await start(providerId);
    const response = await complete(url, token, {
      model: model('fake/vision'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Completion).choices[0]?.message.content).toBe(
      'I see 1 image.',
    );
  });

  it('maps an upstream 500 to 502 provider_error', async () => {
    const { url, token } = await start(providerId);
    const response = await complete(url, token, { model: model('fake/500'), messages: hello });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toMatchObject({
      code: 'provider_error',
      type: 'provider',
      provider_status: 500,
    });
    // Never retried.
    expect(fake.requests).toHaveLength(1);
  });

  it('maps an upstream rate limit to 502 provider_error with the Provider’s code', async () => {
    const { url, token } = await start(providerId);
    const response = await complete(url, token, {
      model: model('fake/rate-limited'),
      messages: hello,
    });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toMatchObject({
      code: 'provider_error',
      provider_status: 429,
      provider_code: 'rate_limit_exceeded',
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('answers 504 provider_timeout when the Provider is too slow', async () => {
    const { url, token } = await start(providerId, { firstByteTimeoutMs: 100 });
    const response = await complete(url, token, { model: model('fake/slow'), messages: hello });
    expect(response.status).toBe(504);
    expect((await errorOf(response)).code).toBe('provider_timeout');
  });
});

describe('OpenRouter model names', () => {
  it('passes a compound model name through to OpenRouter unchanged', async () => {
    const { url, token } = await start('openrouter');
    const response = await complete(url, token, {
      model: 'openrouter/anthropic/claude-sonnet-4-5',
      messages: hello,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Completion).model).toBe(
      'openrouter/anthropic/claude-sonnet-4-5',
    );
    expect(fake.requests[0]?.body).toMatchObject({ model: 'anthropic/claude-sonnet-4-5' });
  });
});
