/**
 * The fake Provider on its own: every scenario hit directly with fetch (no Gateway involved),
 * asserting the OpenAI wire shapes the Gateway and the AI SDK adapters rely on.
 */
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_SCENARIOS, startFakeProvider } from '../src/testing/fake-provider.js';
import type { FakeProvider } from '../src/testing/fake-provider.js';
import { deltas, readSse, readUntil, textOf } from './support/sse.js';

const SLOW_MS = 300;

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider({ slowMs: SLOW_MS, aliases: { 'qwen3:8b': 'fake/echo' } });
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.reset();
});

/** Fakes started by a single test, closed after it. */
const extraFakes: FakeProvider[] = [];

afterEach(async () => {
  await Promise.all(extraFakes.splice(0).map((extra) => extra.close()));
});

async function startExtra(options: Parameters<typeof startFakeProvider>[0] = {}) {
  const extra = await startFakeProvider(options);
  extraFakes.push(extra);
  return extra;
}

function post(body: unknown, init: RequestInit = {}, base = fake.url): Promise<Response> {
  return fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

const hello = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Say hello to the world' },
];

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Weather for a city',
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
  },
};
const timeTool = {
  type: 'function',
  function: { name: 'get_time', parameters: { type: 'object', properties: {} } },
};

/** Counts the sockets and listening servers this process holds open. */
function openHandles(): number {
  return process
    .getActiveResourcesInfo()
    .filter((name) => name === 'TCPSocketWrap' || name === 'TCPServerWrap').length;
}

describe('lifecycle', () => {
  it('listens on an OS-assigned loopback port and reports it in the /v1 base URL', () => {
    expect(fake.port).toBeGreaterThan(0);
    expect(fake.url).toBe(`http://127.0.0.1:${String(fake.port)}/v1`);
  });

  it('refuses to bind anything but loopback, so tests never expose it to the network', async () => {
    await expect(startFakeProvider({ host: '0.0.0.0' })).rejects.toThrow(/only 127\.0\.0\.1/);
    await expect(startFakeProvider({ host: '192.168.1.10' })).rejects.toThrow(/Refusing/);
  });

  it('runs offline: the test setup refuses connections beyond loopback', async () => {
    // 192.0.2.1 is TEST-NET-1, reserved for documentation; it is never reached.
    expect(() => connect({ host: '192.0.2.1', port: 80 })).toThrow(/offline/);
    await expect(fetch('http://192.0.2.1/v1/models')).rejects.toThrow();
  });

  it('accepts a fixed port (the fake stands in for Ollama on 11434 in end-to-end tests)', async () => {
    const probe = await startFakeProvider();
    const { port } = probe;
    await probe.close();
    const fixed = await startExtra({ port });
    expect(fixed.port).toBe(port);
    expect((await fetch(`${fixed.url}/models`)).status).toBe(200);
  });

  it('rejects when the port is already taken', async () => {
    await expect(startFakeProvider({ port: fake.port })).rejects.toThrow(/EADDRINUSE/);
  });

  it('leaks no sockets or servers when started and stopped many times', async () => {
    const before = openHandles();
    for (let round = 0; round < 25; round += 1) {
      const extra = await startFakeProvider();
      const response = await post({ model: 'fake/echo', messages: hello }, {}, extra.url);
      expect(response.status).toBe(200);
      await response.json();
      await extra.close();
    }
    await vi.waitFor(() => {
      expect(openHandles()).toBeLessThanOrEqual(before);
    });
  });

  it('closes idempotently', async () => {
    const extra = await startFakeProvider();
    const first = extra.close();
    expect(extra.close()).toBe(first);
    await first;
    await expect(fetch(`${extra.url}/models`)).rejects.toThrow();
  });

  it('rejects options it cannot honour', async () => {
    await expect(startFakeProvider({ slowMs: -1 })).rejects.toThrow(/slowMs/);
    await expect(
      startFakeProvider({ aliases: { 'my-model': 'fake/nope' as 'fake/echo' } }),
    ).rejects.toThrow(/unknown fake\/nope/);
  });
});

describe('fake/echo', () => {
  it('returns an OpenAI chat.completion echoing the last user message, with usage', async () => {
    const response = await post({ model: 'fake/echo', messages: hello });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.stringMatching(/^chatcmpl-/) as string,
      object: 'chat.completion',
      created: expect.any(Number) as number,
      model: 'fake/echo',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Say hello to the world' },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      // prompt: 2 + 5 words; completion: 5 words.
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    });
  });

  it('echoes text content parts too', async () => {
    const response = await post({
      model: 'fake/echo',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'one two' },
            { type: 'text', text: 'three' },
          ],
        },
      ],
    });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe('one two three');
  });

  it('serves an alias like its scenario', async () => {
    const response = await post({ model: 'qwen3:8b', messages: hello });
    const body = (await response.json()) as { model: string; choices: unknown[] };
    expect(body.model).toBe('qwen3:8b');
    expect(body.choices).toHaveLength(1);
  });

  it('streams when the request asks for it, whatever the scenario name says', async () => {
    const response = await post({ model: 'fake/echo', messages: hello, stream: true });
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const sse = await readSse(response);
    expect(sse.done).toBe(true);
  });
});

describe('fake/echo-stream', () => {
  it('streams one chunk per word after a role chunk, then the finish reason and [DONE]', async () => {
    const response = await post({ model: 'fake/echo-stream', messages: hello, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const sse = await readSse(response);
    expect(sse.done).toBe(true);
    for (const chunk of sse.chunks) {
      expect(chunk).toMatchObject({ object: 'chat.completion.chunk', model: 'fake/echo-stream' });
      expect(chunk.id).toBe(sse.chunks[0]?.id);
    }
    expect(deltas(sse)).toEqual([
      { role: 'assistant', content: '' },
      { content: 'Say ' },
      { content: 'hello ' },
      { content: 'to ' },
      { content: 'the ' },
      { content: 'world' },
      {},
    ]);
    const choices = sse.chunks.map((chunk) => (chunk.choices as Record<string, unknown>[])[0]);
    expect(choices.at(-1)?.finish_reason).toBe('stop');
    expect(sse.chunks.some((chunk) => 'usage' in chunk)).toBe(false);
  });

  it('adds a usage chunk with empty choices when stream_options.include_usage is true', async () => {
    const response = await post({
      model: 'fake/echo-stream',
      messages: hello,
      stream: true,
      stream_options: { include_usage: true },
    });
    const sse = await readSse(response);
    expect(sse.done).toBe(true);
    expect(sse.chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    });
    expect(sse.chunks.filter((chunk) => 'usage' in chunk)).toHaveLength(1);
  });

  it('answers in one piece when the request does not stream', async () => {
    const response = await post({ model: 'fake/echo-stream', messages: hello });
    const body = (await response.json()) as { object: string };
    expect(body.object).toBe('chat.completion');
  });
});

describe('fake/tool-call', () => {
  it('calls tools[0] with the last user text and finishes with tool_calls', async () => {
    const response = await post({
      model: 'fake/tool-call',
      messages: [{ role: 'user', content: 'Weather in Paris' }],
      tools: [weatherTool, timeTool],
      tool_choice: 'auto',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_0',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"input":"Weather in Paris"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    });
  });

  it('fake/tool-call-parallel calls the first two tools, or tools[0] twice', async () => {
    const two = await post({
      model: 'fake/tool-call-parallel',
      messages: [{ role: 'user', content: 'Go' }],
      tools: [weatherTool, timeTool],
    });
    const calls = (await two.json()) as {
      choices: { message: { tool_calls: { id: string; function: { name: string } }[] } }[];
    };
    expect(
      calls.choices[0]?.message.tool_calls.map((call) => [call.id, call.function.name]),
    ).toEqual([
      ['call_0', 'get_weather'],
      ['call_1', 'get_time'],
    ]);

    const one = await post({
      model: 'fake/tool-call-parallel',
      messages: [{ role: 'user', content: 'Go' }],
      tools: [timeTool],
    });
    const repeated = (await one.json()) as typeof calls;
    expect(
      repeated.choices[0]?.message.tool_calls.map((call) => [call.id, call.function.name]),
    ).toEqual([
      ['call_0', 'get_time'],
      ['call_1', 'get_time'],
    ]);
  });

  it('streams each call as an id and name chunk, then the arguments in at least 2 fragments', async () => {
    const response = await post({
      model: 'fake/tool-call-parallel',
      messages: [{ role: 'user', content: 'Weather in Paris' }],
      tools: [weatherTool, timeTool],
      stream: true,
      stream_options: { include_usage: true },
    });
    const sse = await readSse(response);
    expect(sse.done).toBe(true);
    const fragments = new Map<number, string[]>();
    const starts: unknown[] = [];
    for (const delta of deltas(sse)) {
      for (const call of (delta.tool_calls ?? []) as {
        index: number;
        id?: string;
        type?: string;
        function: { name?: string; arguments: string };
      }[]) {
        if (call.id !== undefined)
          starts.push([call.index, call.id, call.type, call.function.name]);
        fragments.set(call.index, [...(fragments.get(call.index) ?? []), call.function.arguments]);
      }
    }
    expect(starts).toEqual([
      [0, 'call_0', 'function', 'get_weather'],
      [1, 'call_1', 'function', 'get_time'],
    ]);
    for (const parts of fragments.values()) {
      expect(parts.length).toBeGreaterThanOrEqual(2);
      expect(parts.join('')).toBe('{"input":"Weather in Paris"}');
    }
    const last = sse.chunks.at(-2)?.choices as { delta: object; finish_reason: string }[];
    expect(last).toEqual([
      expect.objectContaining({ delta: {}, finish_reason: 'tool_calls' }) as unknown,
    ]);
    expect(sse.chunks.at(-1)).toMatchObject({ choices: [], usage: { completion_tokens: 6 } });
  });

  it('answers a tool result with text, so an agent loop ends', async () => {
    const response = await post({
      model: 'fake/tool-call',
      messages: [
        { role: 'user', content: 'Weather in Paris' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_0',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"input":"Weather in Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_0', content: 'Sunny, 21 C' },
      ],
      tools: [weatherTool],
    });
    const body = (await response.json()) as {
      choices: { message: unknown; finish_reason: string }[];
    };
    expect(body.choices[0]).toMatchObject({
      message: { role: 'assistant', content: 'Sunny, 21 C' },
      finish_reason: 'stop',
    });
  });

  it('rejects a request without tools with 400', async () => {
    const response = await post({ model: 'fake/tool-call', messages: hello });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: expect.any(String) as string, type: 'invalid_request_error', code: null },
    });
  });
});

describe('fake/stream-no-usage', () => {
  it('streams content but no chunk carries usage, even when include_usage is asked for', async () => {
    const response = await post({
      model: 'fake/stream-no-usage',
      messages: hello,
      stream: true,
      stream_options: { include_usage: true },
    });
    const sse = await readSse(response);
    expect(sse.done).toBe(true);
    expect(textOf(sse)).toBe('Say hello to the world');
    expect(sse.chunks.some((chunk) => 'usage' in chunk)).toBe(false);
    expect(sse.chunks.at(-1)?.choices).toEqual([
      expect.objectContaining({ finish_reason: 'stop' }) as unknown,
    ]);
  });

  it('leaves usage out of a non-streaming completion', async () => {
    const response = await post({ model: 'fake/stream-no-usage', messages: hello });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe('chat.completion');
    expect(body).not.toHaveProperty('usage');
  });
});

describe('fake/vision', () => {
  const withImage = (url: string) => [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url } },
      ],
    },
  ];

  it.each([
    ['an https URL', 'https://example.com/cat.png'],
    ['a data URL', 'data:image/png;base64,iVBORw0KGgo='],
  ])('describes %s image', async (_name, url) => {
    const response = await post({ model: 'fake/vision', messages: withImage(url) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe('I see 1 image.');
  });

  it('streams when asked', async () => {
    const response = await post({
      model: 'fake/vision',
      messages: withImage('https://example.com/cat.png'),
      stream: true,
    });
    const sse = await readSse(response);
    expect(textOf(sse)).toBe('I see 1 image.');
  });

  it('rejects a request without an image with 400 invalid_request_error', async () => {
    const response = await post({ model: 'fake/vision', messages: hello });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: expect.any(String) as string, type: 'invalid_request_error', code: null },
    });
  });
});

describe('error scenarios', () => {
  it.each([false, true])('fake/500 answers HTTP 500 server_error (stream: %s)', async (stream) => {
    const response = await post({ model: 'fake/500', messages: hello, stream });
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({
      error: { message: expect.any(String) as string, type: 'server_error', code: null },
    });
  });

  it.each([false, true])(
    'fake/rate-limited answers HTTP 429 rate_limit_exceeded (stream: %s)',
    async (stream) => {
      const response = await post({ model: 'fake/rate-limited', messages: hello, stream });
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        error: {
          message: expect.stringMatching(/rate limit/i) as string,
          type: 'requests',
          code: 'rate_limit_exceeded',
        },
      });
    },
  );

  it('answers 404 model_not_found for a model that is no scenario and no alias', async () => {
    const response = await post({ model: 'fake/echo-v2', messages: hello });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        message: expect.stringContaining('fake/echo-v2') as string,
        type: 'invalid_request_error',
        code: 'model_not_found',
      },
    });
  });

  it.each([
    ['a body that is not JSON', '{"model": "fake/echo",'],
    ['a JSON array', '[]'],
    ['no model', { messages: hello }],
    ['no messages', { model: 'fake/echo' }],
    ['empty messages', { model: 'fake/echo', messages: [] }],
  ])('answers 400 invalid_request_error for %s', async (_name, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: expect.any(String) as string, type: 'invalid_request_error', code: null },
    });
  });

  it('answers 404 for an unknown path', async () => {
    const response = await fetch(`${fake.url}/embeddings`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { type: 'invalid_request_error', code: 'unknown_url' },
    });
  });
});

describe('fake/slow', () => {
  it.each([false, true])(
    'sends no byte before the configured delay, then answers like fake/echo (stream: %s)',
    async (stream) => {
      const started = performance.now();
      const response = await post({ model: 'fake/slow', messages: hello, stream });
      // fetch resolves once the status line and headers arrive.
      expect(performance.now() - started).toBeGreaterThanOrEqual(SLOW_MS - 5);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('world');
    },
  );

  it('close() cancels a pending delay and ends the request at once', async () => {
    const slow = await startExtra({ slowMs: 60_000 });
    const pending = post({ model: 'fake/slow', messages: hello }, {}, slow.url);
    await vi.waitFor(() => {
      expect(slow.requests).toHaveLength(1);
    });
    const started = performance.now();
    await slow.close();
    await expect(pending).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('fake/stall', () => {
  it('streams the first content chunk, then nothing until the client goes away', async () => {
    const controller = new AbortController();
    const response = await post(
      { model: 'fake/stall', messages: hello, stream: true },
      { signal: controller.signal },
    );
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    const received = await readUntil(reader, '"content":"Say "');
    const next = reader.read();
    const outcome = await Promise.race([
      next.then(() => 'more data'),
      new Promise((resolve) => setTimeout(resolve, 200, 'silence')),
    ]);
    expect(outcome).toBe('silence');
    expect(received).not.toContain('[DONE]');
    expect(fake.requests[0]?.aborted).toBe(false);

    controller.abort();
    await next.catch(() => undefined);
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });

  it('sends half of a non-streaming body, then stalls', async () => {
    const controller = new AbortController();
    const response = await post(
      { model: 'fake/stall', messages: hello },
      { signal: controller.signal },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    expect(await readUntil(reader, '"object":"chat.completion"')).not.toContain('usage');
    controller.abort();
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });

  it('ends when the server closes', async () => {
    const stalled = await startExtra();
    const response = await post(
      { model: 'fake/stall', messages: hello, stream: true },
      {},
      stalled.url,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('no body');
    await readUntil(reader, '"content":"Say "');
    await stalled.close();
    await expect(readUntil(reader, '[DONE]')).rejects.toThrow();
    expect(stalled.requests[0]?.aborted).toBe(false);
  });
});

describe('fake/stream-error', () => {
  it.each([true, false])(
    'sends the start of the response, then drops the connection (stream: %s)',
    async (stream) => {
      const response = await post({ model: 'fake/stream-error', messages: hello, stream });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('no body');
      await readUntil(reader, stream ? '"content":"Say "' : '"chat.completion"');
      await expect(readUntil(reader, '\u0000never')).rejects.toThrow();
      // The fake ended it, not the client.
      expect(fake.requests[0]?.aborted).toBe(false);
    },
  );
});

describe('GET /v1/models', () => {
  it('lists every scenario and alias in the OpenAI list shape', async () => {
    const response = await fetch(`${fake.url}/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; data: Record<string, unknown>[] };
    expect(body.object).toBe('list');
    expect(body.data.map((model) => model.id)).toEqual([...FAKE_SCENARIOS, 'qwen3:8b']);
    expect(body.data[0]).toEqual({
      id: 'fake/echo',
      object: 'model',
      created: 0,
      owned_by: 'fake-provider',
    });
  });
});

describe('API key', () => {
  it('accepts any Authorization, or none, by default', async () => {
    expect((await fetch(`${fake.url}/models`)).status).toBe(200);
    const response = await post({ model: 'fake/echo', messages: hello });
    expect(response.status).toBe(200);
  });

  it('answers 401 invalid_api_key for a wrong or missing key once apiKey is set', async () => {
    const keyed = await startExtra({ apiKey: 'sk-fake-123' });
    const unauthorized = {
      error: {
        message: expect.any(String) as string,
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    };
    const missing = await fetch(`${keyed.url}/models`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual(unauthorized);

    const wrong = await post({ model: 'fake/echo', messages: hello }, {}, keyed.url);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(unauthorized);

    const right = await post(
      { model: 'fake/echo', messages: hello },
      { headers: { authorization: 'bearer sk-fake-123' } },
      keyed.url,
    );
    expect(right.status).toBe(200);
  });
});

describe('request recording', () => {
  it('records method, path, lower-cased headers and the parsed body of every request', async () => {
    const body = {
      model: 'fake/tool-call',
      messages: [{ role: 'user', content: 'Weather in Paris' }],
      tools: [weatherTool],
    };
    await (
      await post(body, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk-up',
          'X-Trace': 't1',
        },
      })
    ).json();
    await (await fetch(`${fake.url}/models?limit=5`)).json();

    expect(fake.requests).toHaveLength(2);
    const [completion, models] = fake.requests;
    expect(completion).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: 'Bearer sk-up', 'x-trace': 't1' },
      body,
      aborted: false,
    });
    expect(models).toMatchObject({ method: 'GET', path: '/v1/models?limit=5', body: null });
  });

  it('records a body that is not JSON as its raw text', async () => {
    await post('not json');
    expect(fake.requests[0]?.body).toBe('not json');
  });

  it('records requests that fail authentication too, and reset() forgets them', async () => {
    const keyed = await startExtra({ apiKey: 'sk-fake-123' });
    await (await fetch(`${keyed.url}/models`)).json();
    expect(keyed.requests).toHaveLength(1);
    const live = keyed.requests;
    keyed.reset();
    expect(keyed.requests).toHaveLength(0);
    expect(live).toHaveLength(0);
  });

  it('marks a request aborted when the client disconnects before the response ends', async () => {
    // node:http so the request can be torn down mid-flight without fetch's own retries.
    const url = new URL(`${fake.url}/chat/completions`);
    await new Promise<void>((resolve) => {
      const request = httpRequest(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' } },
        (response) => {
          response.once('data', () => {
            request.destroy();
            resolve();
          });
        },
      );
      request.on('error', () => undefined);
      request.end(JSON.stringify({ model: 'fake/stall', messages: hello, stream: true }));
    });
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });
});
