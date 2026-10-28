/**
 * Streaming `POST /v1/chat/completions` (`stream: true`), tool calling, image parts and usage,
 * with an explicit `provider/model` id, through the Gateway HTTP seam: the Gateway and the fake
 * Provider run in-process and the tests read the SSE body with plain fetch, asserting on the wire
 * only (status, chunks, what reached the fake and whether the fake saw its request aborted).
 */
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeProvider } from '../src/testing/fake-provider.js';
import type { FakeProvider } from '../src/testing/fake-provider.js';
import type { Gateway, GatewayOptions, Logger } from '../src/index.js';
import { claims, startGateway } from './support/gateway.js';
import { chunk, startScriptedUpstream } from './support/scripted-upstream.js';
import type { ScriptedReply } from './support/scripted-upstream.js';
import { deltas, readSse, readUntil, textOf } from './support/sse.js';
import type { SseBody } from './support/sse.js';

/** The Provider id the fake stands in for. */
const FAKE = 'openai-compatible:fake';
const API_KEY = 'sk-fake-connection-key-0123456789';

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider({ apiKey: API_KEY, slowMs: 2000 });
});

afterAll(async () => {
  await fake.close();
});

/** Gateways started by the current test, closed after it. */
const started: Gateway[] = [];
/** Scripted upstreams started by the current test, closed after its Gateways. */
const upstreams: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((gateway) => gateway.close()));
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  fake.reset();
});

/** The Provider id a scripted upstream stands in for. */
const SCRIPTED = 'openai-compatible:scripted';

/** A Gateway whose `openai-compatible:scripted` Connection points at an upstream answering `reply`. */
async function startScripted(
  reply: (body: Record<string, unknown>) => ScriptedReply,
  overrides: Partial<GatewayOptions> = {},
) {
  const upstream = await startScriptedUpstream(reply);
  upstreams.push(upstream);
  return start({
    getConnection: (providerId) =>
      Promise.resolve(providerId === SCRIPTED ? { baseUrl: upstream.url, apiKey: API_KEY } : null),
    ...overrides,
  });
}

async function start(overrides: Partial<GatewayOptions> = {}) {
  const test = await startGateway({
    getConnection: (providerId) =>
      Promise.resolve(providerId === FAKE ? { baseUrl: fake.url, apiKey: API_KEY } : null),
    ...overrides,
  });
  started.push(test.gateway);
  const token = test.gateway.issueToken(claims());
  return { ...test, token };
}

function complete(url: string, token: string, body: unknown, signal?: AbortSignal) {
  return fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    ...(signal !== undefined && { signal }),
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

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function: { name?: string; arguments?: string };
}

interface Chunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: { index: number; delta: Record<string, unknown>; finish_reason: string | null }[];
  usage?: Record<string, unknown>;
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

function chunksOf(body: SseBody): Chunk[] {
  return body.chunks as unknown as Chunk[];
}

/** The tool calls a client assembles from the streamed fragments, as OpenAI SDKs do. */
function accumulateToolCalls(body: SseBody): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const delta of deltas(body)) {
    for (const fragment of (delta.tool_calls as ToolCallDelta[] | undefined) ?? []) {
      const call = (calls[fragment.index] ??= {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      });
      if (fragment.id !== undefined) call.id = fragment.id;
      if (fragment.function.name !== undefined) call.function.name = fragment.function.name;
      call.function.arguments += fragment.function.arguments ?? '';
    }
  }
  return calls;
}

/** The finish reason of the stream: the only chunk that has one. */
function finishReasons(body: SseBody): (string | null)[] {
  return chunksOf(body)
    .flatMap((chunk) => chunk.choices.map((choice) => choice.finish_reason))
    .filter((reason) => reason !== null);
}

describe('streaming', () => {
  it('streams fake/echo-stream as OpenAI chunks ending in [DONE]', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/echo-stream`,
      messages: hello,
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const body = await readSse(response);
    expect(body.done).toBe(true);
    const chunks = chunksOf(body);
    const [first] = chunks;
    expect(first?.id).toMatch(/^chatcmpl_[0-9a-f-]{36}$/);
    for (const chunk of chunks) {
      expect(chunk).toMatchObject({
        id: first?.id,
        object: 'chat.completion.chunk',
        created: first?.created,
        model: `${FAKE}/fake/echo-stream`,
      });
    }
    expect(first?.choices).toEqual([
      { index: 0, delta: { role: 'assistant' }, finish_reason: null },
    ]);
    // One content delta per word, as the Provider sent them.
    expect(deltas(body).filter((delta) => 'content' in delta)).toEqual([
      { content: 'hello ' },
      { content: 'there ' },
      { content: 'world' },
    ]);
    expect(textOf(body)).toBe('hello there world');
    expect(chunks.at(-1)?.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    expect(chunks.some((chunk) => 'usage' in chunk)).toBe(false);
    // The Provider streamed too.
    expect(fake.requests[0]?.body).toMatchObject({ model: 'fake/echo-stream', stream: true });
  });

  it('can be consumed by the OpenAI SDK streaming client', async () => {
    const { url, token } = await start();
    const client = new OpenAI({ baseURL: url, apiKey: token, maxRetries: 0 });
    const stream = await client.chat.completions.create({
      model: `${FAKE}/fake/echo-stream`,
      messages: [{ role: 'user', content: 'from the sdk' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let usage: OpenAI.CompletionUsage | null | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? '';
      usage = chunk.usage ?? usage;
    }
    expect(text).toBe('from the sdk');
    expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 });

    const helper = client.chat.completions.stream({
      model: `${FAKE}/fake/tool-call`,
      messages: [{ role: 'user', content: 'find cats' }],
      tools: [lookup as OpenAI.ChatCompletionTool],
    });
    const completion = await helper.finalChatCompletion();
    expect(completion.choices[0]?.finish_reason).toBe('tool_calls');
    expect(completion.choices[0]?.message.tool_calls).toMatchObject([
      { id: 'call_0', function: { name: 'lookup', arguments: '{"input":"find cats"}' } },
    ]);
  });

  it('ends with a usage chunk when stream_options.include_usage is true', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/echo-stream`,
      messages: hello,
      stream: true,
      stream_options: { include_usage: true },
    });
    const body = await readSse(response);
    expect(body.done).toBe(true);
    const chunks = chunksOf(body);
    expect(chunks.at(-2)?.choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    expect(chunks.at(-1)).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    });
    expect(chunks.filter((chunk) => 'usage' in chunk)).toHaveLength(1);
  });

  it('never fabricates usage the Provider did not report', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stream-no-usage`,
      messages: hello,
      stream: true,
      stream_options: { include_usage: true },
    });
    const body = await readSse(response);
    expect(body.done).toBe(true);
    expect(textOf(body)).toBe('hello there world');
    expect(chunksOf(body).some((chunk) => 'usage' in chunk)).toBe(false);
  });
});

describe('tool calls', () => {
  it('returns parallel tool calls without streaming, in a stable order', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/tool-call-parallel`,
      messages: [{ role: 'user', content: 'find cats' }],
      tools: [lookup, define],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: { message: { content: unknown; tool_calls: ToolCall[] }; finish_reason: string }[];
    };
    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
    expect(body.choices[0]?.message.content).toBeNull();
    // Array position is the tool call's index, the one its streamed fragments carry.
    expect(body.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_0',
        type: 'function',
        function: { name: 'lookup', arguments: '{"input":"find cats"}' },
      },
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'define', arguments: '{"input":"find cats"}' },
      },
    ]);
  });

  it('streams parallel tool calls as fragments with distinct indices', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/tool-call-parallel`,
      messages: [{ role: 'user', content: 'find cats' }],
      tools: [lookup, define],
      stream: true,
    });
    const body = await readSse(response);
    expect(body.done).toBe(true);
    const fragments = deltas(body).flatMap(
      (delta) => (delta.tool_calls as ToolCallDelta[] | undefined) ?? [],
    );
    // Each call opens with its id, type and name, then its arguments arrive in pieces.
    expect(fragments.filter((fragment) => fragment.id !== undefined)).toEqual([
      { index: 0, id: 'call_0', type: 'function', function: { name: 'lookup', arguments: '' } },
      { index: 1, id: 'call_1', type: 'function', function: { name: 'define', arguments: '' } },
    ]);
    for (const index of [0, 1]) {
      const pieces = fragments.filter((f) => f.index === index && f.function.arguments !== '');
      expect(pieces.length).toBeGreaterThanOrEqual(2);
    }
    expect(accumulateToolCalls(body).map((call) => call.id)).toEqual(['call_0', 'call_1']);
    expect(finishReasons(body)).toEqual(['tool_calls']);
  });

  it('accumulates a streamed tool call into what the non-streaming response returns', async () => {
    const { url, token } = await start();
    const request = {
      model: `${FAKE}/fake/tool-call`,
      messages: [{ role: 'user', content: 'find cats' }],
      tools: [lookup],
      tool_choice: 'required',
    };
    const whole = (await (await complete(url, token, request)).json()) as {
      choices: { message: { tool_calls: ToolCall[] } }[];
    };
    const body = await readSse(await complete(url, token, { ...request, stream: true }));
    expect(accumulateToolCalls(body)).toEqual(whole.choices[0]?.message.tool_calls);
    expect(textOf(body)).toBe('');
    expect(finishReasons(body)).toEqual(['tool_calls']);
    // tools and tool_choice reached the Provider on the streamed call too.
    expect(fake.requests[1]?.body).toMatchObject({ tools: [lookup], tool_choice: 'required' });
  });

  it('streams the Provider’s argument text, equal as JSON to the non-streaming arguments', async () => {
    const args = '{"input": "find cats"}';
    const { url, token } = await startScripted((body) =>
      body.stream === true
        ? {
            sse: [
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'lookup', arguments: '' },
                  },
                ],
              }),
              chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, 9) } }] }),
              chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(9) } }] }),
              chunk({}, 'tool_calls'),
            ],
          }
        : {
            json: {
              ...chunk({}),
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_a',
                        type: 'function',
                        function: { name: 'lookup', arguments: args },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          },
    );
    const request = { model: `${SCRIPTED}/m`, messages: hello, tools: [lookup] };
    const whole = (await (await complete(url, token, request)).json()) as {
      choices: { message: { tool_calls: ToolCall[] } }[];
    };
    const [call] = accumulateToolCalls(
      await readSse(await complete(url, token, { ...request, stream: true })),
    );
    const [wholeCall] = whole.choices[0]?.message.tool_calls ?? [];
    expect(call).toMatchObject({ id: 'call_a', function: { name: 'lookup', arguments: args } });
    expect(call?.id).toBe(wholeCall?.id);
    expect(JSON.parse(call?.function.arguments ?? '')).toEqual(
      JSON.parse(wholeCall?.function.arguments ?? ''),
    );
  });

  /**
   * An upstream that answers one `lookup` call (id `call_a`) whose argument text is `fragments`:
   * streamed as one tool-call delta per fragment, or joined in a non-streaming response.
   */
  function startToolCallUpstream(fragments: string[]) {
    return startScripted((body) =>
      body.stream === true
        ? {
            sse: [
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'lookup', arguments: '' },
                  },
                ],
              }),
              ...fragments.map((text) =>
                chunk({ tool_calls: [{ index: 0, function: { arguments: text } }] }),
              ),
              chunk({}, 'tool_calls'),
            ],
          }
        : {
            json: {
              ...chunk({}),
              object: 'chat.completion',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_a',
                        type: 'function',
                        function: { name: 'lookup', arguments: fragments.join('') },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          },
    );
  }

  it.each([
    ['no argument text', []],
    ['whitespace-only argument text', [' ']],
    ['whitespace-only argument text in fragments', [' ', '\n\t ']],
  ])('streams {} for a tool call the Provider sent with %s', async (_, fragments: string[]) => {
    const { url, token } = await startToolCallUpstream(fragments);
    const request = { model: `${SCRIPTED}/m`, messages: hello, tools: [lookup] };
    const body = await readSse(await complete(url, token, { ...request, stream: true }));
    expect(body.done).toBe(true);
    expect(accumulateToolCalls(body)).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ]);
    expect(finishReasons(body)).toEqual(['tool_calls']);
    // The same answer without streaming holds the same arguments.
    const whole = (await (await complete(url, token, request)).json()) as {
      choices: { message: { tool_calls: ToolCall[] } }[];
    };
    expect(whole.choices[0]?.message.tool_calls).toEqual(accumulateToolCalls(body));
  });

  it('streams leading whitespace once argument JSON follows it', async () => {
    const { url, token } = await startToolCallUpstream([' ', '\n', '{"input":', ' "cats"}']);
    const body = await readSse(
      await complete(url, token, {
        model: `${SCRIPTED}/m`,
        messages: hello,
        tools: [lookup],
        stream: true,
      }),
    );
    const [call] = accumulateToolCalls(body);
    expect(call?.function.arguments).toBe(' \n{"input": "cats"}');
    expect(JSON.parse(call?.function.arguments ?? '')).toEqual({ input: 'cats' });
  });

  it('streams the text answer to a tool result', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/tool-call`,
      messages: [
        { role: 'user', content: 'find cats' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_0', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_0', content: 'cats are mammals' },
      ],
      tools: [lookup],
      stream: true,
    });
    const body = await readSse(response);
    expect(textOf(body)).toBe('cats are mammals');
    expect(finishReasons(body)).toEqual(['stop']);
  });
});

describe('images', () => {
  const withImage = (imageUrl: string) => [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ];

  it.each([
    ['an http(s) URL', 'https://example.com/cat.png'],
    ['a data URL', 'data:image/png;base64,iVBORw0KGgo='],
  ])('streams fake/vision’s answer to an image given as %s', async (_name, imageUrl) => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/vision`,
      messages: withImage(imageUrl),
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(textOf(await readSse(response))).toBe('I see 1 image.');
  });

  it('fails the same request without the image, so the image did reach the Provider', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/vision`,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }] }],
      stream: true,
    });
    // The Provider refused before the stream started: an ordinary HTTP error.
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toMatchObject({ code: 'provider_error', provider_status: 400 });
  });
});

describe('failures', () => {
  it('answers an error before the stream starts with an ordinary HTTP status', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/rate-limited`,
      messages: hello,
      stream: true,
    });
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await errorOf(response)).toMatchObject({
      code: 'provider_error',
      type: 'provider',
      provider_status: 429,
      provider_code: 'rate_limit_exceeded',
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('ends a stream the Provider breaks off with an error event, then [DONE]', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stream-error`,
      messages: hello,
      stream: true,
    });
    expect(response.status).toBe(200);
    const body = await readSse(response);
    expect(body.done).toBe(true);
    expect(textOf(body)).toBe('hello ');
    const last = body.chunks.at(-1) as { error: Record<string, unknown> };
    expect(last.error).toMatchObject({ code: 'provider_error', type: 'provider' });
    expect(last.error).not.toHaveProperty('provider_status');
  });

  /** An error frame inside a 200 stream, as OpenRouter, vLLM and Ollama send them. */
  const inStreamError = {
    error: { message: `Model overloaded (key ${API_KEY})`, code: 'overloaded' },
  };

  it('answers 502 provider_error for an in-stream error before any output', async () => {
    const { url, token } = await startScripted(() => ({ sse: [inStreamError], done: false }));
    const response = await complete(url, token, {
      model: `${SCRIPTED}/m`,
      messages: hello,
      stream: true,
    });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toEqual({
      code: 'provider_error',
      message: 'The Provider returned an error: Model overloaded (key [redacted])',
      type: 'provider',
      provider_message: 'Model overloaded (key [redacted])',
      provider_code: 'overloaded',
    });
  });

  it('ends the stream with a provider_error event for an in-stream error after output', async () => {
    const error = vi.fn<Logger['error']>();
    const { url, token } = await startScripted(
      () => ({
        sse: [chunk({ role: 'assistant', content: 'hello ' }), inStreamError],
        done: false,
      }),
      { logger: { debug: () => undefined, error } },
    );
    const response = await complete(url, token, {
      model: `${SCRIPTED}/m`,
      messages: hello,
      stream: true,
    });
    expect(response.status).toBe(200);
    const body = await readSse(response);
    expect(body.done).toBe(true);
    expect(textOf(body)).toBe('hello ');
    expect(body.chunks.at(-1)).toEqual({
      error: {
        code: 'provider_error',
        message: 'The Provider returned an error: Model overloaded (key [redacted])',
        type: 'provider',
        provider_message: 'Model overloaded (key [redacted])',
        provider_code: 'overloaded',
      },
    });
    // A Provider failure, not a Gateway bug.
    expect(error).not.toHaveBeenCalled();
  });

  it('answers 504 when the Provider sends no bytes within the timeout', async () => {
    const { url, token } = await start({ firstByteTimeoutMs: 100 });
    const response = await complete(url, token, {
      model: `${FAKE}/fake/slow`,
      messages: hello,
      stream: true,
    });
    expect(response.status).toBe(504);
    expect(await errorOf(response)).toMatchObject({ code: 'provider_timeout', type: 'provider' });
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });

  it('ends a stream that goes idle with a provider_timeout event, and aborts upstream', async () => {
    const { url, token } = await start({ streamIdleTimeoutMs: 100 });
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stall`,
      messages: hello,
      stream: true,
    });
    expect(response.status).toBe(200);
    const body = await readSse(response);
    expect(body.done).toBe(true);
    expect(textOf(body)).toBe('hello ');
    expect(body.chunks.at(-1)).toEqual({
      error: { code: 'provider_timeout', message: expect.any(String) as string, type: 'provider' },
    });
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });

  it('aborts the upstream request when the Harness disconnects mid-stream', async () => {
    const { url, token } = await start();
    const client = new AbortController();
    const response = await complete(
      url,
      token,
      { model: `${FAKE}/fake/stall`, messages: hello, stream: true },
      client.signal,
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, '"content":"hello');
    expect(fake.requests[0]?.aborted).toBe(false);
    client.abort();
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });

  it('ends an open stream with invalid_token when its token is revoked', async () => {
    const { gateway, url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stall`,
      messages: hello,
      stream: true,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let received = await readUntil(reader, '"content":"hello');
    gateway.revokeLaunch('launch-1');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    expect(received).toMatch(
      /data: {"error":{[^\n]*"code":"invalid_token"[^\n]*}}\n\ndata: \[DONE\]\n\n$/,
    );
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });

  it('answers 401 when the token is revoked before the stream starts', async () => {
    const { gateway, url, token } = await start();
    const pending = complete(url, token, {
      model: `${FAKE}/fake/slow`,
      messages: hello,
      stream: true,
    });
    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(1);
    });
    gateway.revokeToken(token);
    const response = await pending;
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('invalid_token');
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });

  it('stops open streams and their upstream calls when the Gateway closes', async () => {
    const debug = vi.fn<Logger['debug']>();
    const { gateway, url, token } = await start({ logger: { debug, error: () => undefined } });
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stall`,
      messages: hello,
      stream: true,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, '"content":"hello');
    await gateway.close();
    // close() drops open connections: the stream ends without a final event.
    await expect(
      (async () => {
        for (;;) if ((await reader.read()).done) return 'ended';
      })().catch(() => 'ended'),
    ).resolves.toBe('ended');
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
    // The dropped stream still ends its request, which is logged.
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith(
        'request',
        expect.objectContaining({ path: '/v1/chat/completions' }),
      );
    });
  });

  it('logs the stream’s metadata, never its content', async () => {
    const debug = vi.fn<Logger['debug']>();
    const { url, token } = await start({ logger: { debug, error: () => undefined } });
    const body = await readSse(
      await complete(url, token, {
        model: `${FAKE}/fake/echo-stream`,
        messages: [{ role: 'user', content: 'a very private question' }],
        stream: true,
      }),
    );
    expect(body.done).toBe(true);
    expect(debug).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({
        model: `${FAKE}/fake/echo-stream`,
        status: 200,
        providerStatus: 200,
      }),
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
  });

  it('logs a stream when it ends, with its whole duration and the error it ended with', async () => {
    const debug = vi.fn<Logger['debug']>();
    const { url, token } = await start({
      streamIdleTimeoutMs: 200,
      logger: { debug, error: () => undefined },
    });
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stall`,
      messages: hello,
      stream: true,
    });
    // The headers are out, but the stream has not ended: nothing is logged yet.
    expect(response.status).toBe(200);
    expect(debug).not.toHaveBeenCalled();
    expect((await readSse(response)).done).toBe(true);
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledTimes(1);
    });
    expect(debug).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({
        path: '/v1/chat/completions',
        status: 200,
        streamError: 'provider_timeout',
      }),
    );
    const [[, fields]] = debug.mock.calls as [[string, { durationMs: number }]];
    expect(fields.durationMs).toBeGreaterThanOrEqual(200);
  });
});
