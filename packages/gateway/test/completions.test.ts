/**
 * Non-streaming `POST /v1/chat/completions` with an explicit `provider/model` id, through the
 * Gateway HTTP seam: the Gateway and the fake Provider run in-process, `getConnection` points
 * `openai-compatible:fake` at the fake, and the tests drive the Gateway with plain fetch and the
 * OpenAI SDK, asserting on the wire only (HTTP status, JSON bodies, what reached the fake).
 */
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeProvider } from '../src/testing/fake-provider.js';
import type { FakeProvider } from '../src/testing/fake-provider.js';
import type { ConnectionSecret, Gateway, GatewayOptions, Logger } from '../src/index.js';
import { claims, startGateway } from './support/gateway.js';

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

afterEach(async () => {
  await Promise.all(started.splice(0).map((gateway) => gateway.close()));
  fake.reset();
});

/** `getConnection` knowing only the fake Provider. */
function fakeConnections(connection: Partial<ConnectionSecret> = {}) {
  return vi.fn((providerId: string) =>
    Promise.resolve(
      providerId === FAKE ? { baseUrl: fake.url, apiKey: API_KEY, ...connection } : null,
    ),
  );
}

async function start(overrides: Partial<GatewayOptions> = {}) {
  const test = await startGateway({ getConnection: fakeConnections(), ...overrides });
  started.push(test.gateway);
  const token = test.gateway.issueToken(claims());
  return { ...test, token };
}

function complete(
  url: string,
  token: string | undefined,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const hello = [{ role: 'user', content: 'hello there world' }];

/** An assistant message calling `lookup` once per id. */
function assistantCalls(...ids: string[]) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: 'function',
      function: { name: 'lookup', arguments: '{}' },
    })),
  };
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

interface Completion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: string; content: string | null; tool_calls?: unknown[] };
    finish_reason: string;
  }[];
  usage?: Record<string, unknown>;
}

/** The body of the last chat completion the fake received. */
function upstreamBody(): Record<string, unknown> {
  const request = fake.requests.findLast((recorded) => recorded.path === '/v1/chat/completions');
  if (request === undefined) throw new Error('No upstream chat completion was made.');
  return request.body as Record<string, unknown>;
}

describe('a successful completion', () => {
  it('returns an OpenAI chat.completion with fake/echo’s reply', async () => {
    const { url, token } = await start();
    const before = Math.floor(Date.now() / 1000);
    const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const body = (await response.json()) as Completion;
    expect(body).toEqual({
      id: expect.stringMatching(
        /^chatcmpl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ) as string,
      object: 'chat.completion',
      created: expect.any(Number) as number,
      model: 'openai-compatible:fake/fake/echo',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello there world' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    });
    expect(body.created).toBeGreaterThanOrEqual(before);
    expect(body.created).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
  });

  it('answers with the resolved provider/model, whatever the request said', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/echo-stream`,
      messages: hello,
    });
    expect(((await response.json()) as Completion).model).toBe(`${FAKE}/fake/echo-stream`);
    // The Provider only ever sees the model name, never the Provider prefix.
    expect(upstreamBody().model).toBe('fake/echo-stream');
  });

  it('works with the OpenAI SDK pointed at HARNESS_GATEWAY_URL', async () => {
    const { url, token } = await start();
    const client = new OpenAI({ baseURL: url, apiKey: token, maxRetries: 0 });
    const completion = await client.chat.completions.create({
      model: `${FAKE}/fake/echo`,
      messages: [{ role: 'user', content: 'from the sdk' }],
    });
    expect(completion.choices[0]?.message.content).toBe('from the sdk');
    expect(completion.model).toBe(`${FAKE}/fake/echo`);
    expect(completion.usage?.total_tokens).toBe(6);
  });

  it('leaves usage out when the Provider reports none', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stream-no-usage`,
      messages: hello,
    });
    const body = (await response.json()) as Completion;
    expect(body.choices[0]?.message.content).toBe('hello there world');
    expect(body).not.toHaveProperty('usage');
  });

  it('ignores unsupported fields instead of rejecting them, and does not forward them', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/echo`,
      messages: [{ role: 'user', content: 'hi', name: 'alice', foo: 1 }],
      foo: 'bar',
      n: 3,
      presence_penalty: 0.5,
      frequency_penalty: 0.5,
      logprobs: true,
      parallel_tool_calls: false,
      user: 'someone',
      metadata: { a: 'b' },
      store: true,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Completion).choices[0]?.message.content).toBe('hi');
    const upstream = upstreamBody();
    for (const field of [
      'foo',
      'n',
      'presence_penalty',
      'frequency_penalty',
      'logprobs',
      'parallel_tool_calls',
      'user',
      'metadata',
      'store',
    ]) {
      expect(upstream, field).not.toHaveProperty(field);
    }
  });

  it('forwards the supported sampling fields; max_completion_tokens wins over max_tokens', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/echo`,
      messages: hello,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 10,
      max_completion_tokens: 20,
      stop: 'END',
      seed: 42,
    });
    expect(response.status).toBe(200);
    expect(upstreamBody()).toMatchObject({
      model: 'fake/echo',
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 20,
      stop: ['END'],
      seed: 42,
    });
  });

  it('sends system and developer messages upstream as system messages, in place', async () => {
    const { url, token } = await start();
    await complete(url, token, {
      model: `${FAKE}/fake/echo`,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'one' },
        { role: 'developer', content: [{ type: 'text', text: 'Be kind.' }] },
        { role: 'user', content: [{ type: 'text', text: 'two' }] },
      ],
    });
    expect(upstreamBody().messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'one' },
      { role: 'system', content: 'Be kind.' },
      { role: 'user', content: 'two' },
    ]);
  });

  it('returns the raw text for a JSON response_format, even when it is not JSON', async () => {
    const { url, token } = await start();
    for (const responseFormat of [
      { type: 'json_object' },
      {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object', properties: {} } },
      },
    ]) {
      const response = await complete(url, token, {
        model: `${FAKE}/fake/echo`,
        messages: [{ role: 'user', content: 'not json at all' }],
        response_format: responseFormat,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Completion;
      expect(body.choices[0]?.message.content).toBe('not json at all');
      // Both formats reach the Provider as structured-output requests.
      expect(upstreamBody().response_format).toMatchObject(responseFormat);
    }
  });
});

describe('tool calls and images', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Looks a word up.',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
      },
    },
  ];

  it('forwards tools and tool_choice and returns the tool calls', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/tool-call`,
      messages: [{ role: 'user', content: 'find cats' }],
      tools,
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Completion;
    expect(body.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'lookup', arguments: '{"input":"find cats"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
    const upstream = upstreamBody();
    expect(upstream.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Looks a word up.',
          parameters: tools[0]?.function.parameters,
        },
      },
    ]);
    expect(upstream.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } });
  });

  it.each([
    ['required', 'fake/echo', { content: 'find cats' }],
    [
      'none',
      'fake/tool-call',
      { content: null, tool_calls: [expect.objectContaining({ id: 'call_0' })] },
    ],
  ])(
    'passes the reply through when the Provider ignores tool_choice %s',
    async (toolChoice, model, message) => {
      const error = vi.fn<Logger['error']>();
      const { url, token } = await start({ logger: { debug: () => undefined, error } });
      const response = await complete(url, token, {
        model: `${FAKE}/${model}`,
        messages: [{ role: 'user', content: 'find cats' }],
        tools,
        tool_choice: toolChoice,
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as Completion).choices[0]?.message).toEqual({
        role: 'assistant',
        ...message,
      });
      expect(upstreamBody().tool_choice).toBe(toolChoice);
      expect(error).not.toHaveBeenCalled();
    },
  );

  it('round-trips a tool result to the Provider', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/tool-call`,
      messages: [
        { role: 'user', content: 'find cats' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_0',
              type: 'function',
              function: { name: 'lookup', arguments: '{"input":"find cats"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_0', content: 'cats are found' },
      ],
      tools,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Completion;
    expect(body.choices[0]?.message.content).toBe('cats are found');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect((upstreamBody().messages as unknown[]).slice(1)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'lookup', arguments: '{"input":"find cats"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_0', content: 'cats are found' },
    ]);
  });

  it('accepts parallel tool calls once every one has its result', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/echo`,
      messages: [
        ...hello,
        assistantCalls('c1', 'c2'),
        { role: 'tool', tool_call_id: 'c2', content: 'two' },
        { role: 'tool', tool_call_id: 'c1', content: 'one' },
        { role: 'user', content: 'thanks' },
      ],
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Completion).choices[0]?.message.content).toBe('thanks');
  });

  it.each([
    ['an http(s) URL', 'https://example.com/cat.png'],
    ['a data URL', 'data:image/png;base64,iVBORw0KGgo='],
  ])('passes an image given as %s through to the Provider', async (_name, imageUrl) => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/vision`,
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
    const [message] = upstreamBody().messages as { content: unknown[] }[];
    expect(message?.content[1]).toEqual({ type: 'image_url', image_url: { url: imageUrl } });
  });
});

describe('request validation', () => {
  it.each([
    ['messages missing', { model: `${FAKE}/fake/echo` }],
    ['model missing', { messages: hello }],
    ['messages empty', { model: `${FAKE}/fake/echo`, messages: [] }],
    ['messages not an array', { model: `${FAKE}/fake/echo`, messages: 'hi' }],
    ['a message without a role', { model: `${FAKE}/fake/echo`, messages: [{ content: 'hi' }] }],
    [
      'an unknown role',
      { model: `${FAKE}/fake/echo`, messages: [{ role: 'function', content: 'hi', name: 'f' }] },
    ],
    [
      'a user message without content',
      { model: `${FAKE}/fake/echo`, messages: [{ role: 'user' }] },
    ],
    [
      'an unknown content part',
      {
        model: `${FAKE}/fake/echo`,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }],
      },
    ],
    [
      'an image in an assistant message',
      {
        model: `${FAKE}/fake/echo`,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
          },
        ],
      },
    ],
    [
      'an image URL that is neither http(s) nor data',
      {
        model: `${FAKE}/fake/echo`,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'file:///etc/passwd' } }],
          },
        ],
      },
    ],
    ...[
      ['without a comma', 'data:image/png;base64'],
      ['with characters outside base64', 'data:image/png;base64,@@@###'],
      ['with base64 of an impossible length', 'data:image/png;base64,iVBOR'],
      ['without data', 'data:image/png;base64,'],
      ['that is not base64', 'data:image/svg+xml,%3Csvg%2F%3E'],
      ['of a PDF', 'data:application/pdf;base64,aGk='],
      ['of audio', 'data:audio/wav;base64,aGk='],
      ['of text', 'data:text/plain;base64,aGk='],
      ['without a media type', 'data:;base64,aGk='],
    ].map(([name, imageUrl]): [string, unknown] => [
      `an image data URL ${String(name)}`,
      {
        model: `${FAKE}/fake/vision`,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: imageUrl } }],
          },
        ],
      },
    ]),
    [
      'a tool_choice naming a function not in tools',
      {
        model: `${FAKE}/fake/tool-call`,
        messages: hello,
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        tool_choice: { type: 'function', function: { name: 'nope' } },
      },
    ],
    [
      'a tool_choice naming a function without tools',
      {
        model: `${FAKE}/fake/tool-call`,
        messages: hello,
        tool_choice: { type: 'function', function: { name: 'lookup' } },
      },
    ],
    [
      'tool_choice required without tools',
      { model: `${FAKE}/fake/echo`, messages: hello, tool_choice: 'required' },
    ],
    [
      'a tool result matching no tool call',
      {
        model: `${FAKE}/fake/echo`,
        messages: [...hello, { role: 'tool', tool_call_id: 'call_9', content: 'x' }],
      },
    ],
    [
      'a tool call left unanswered before the next user message',
      {
        model: `${FAKE}/fake/echo`,
        messages: [...hello, assistantCalls('c1'), { role: 'user', content: 'never mind' }],
      },
    ],
    [
      'two parallel tool calls with only one tool result',
      {
        model: `${FAKE}/fake/echo`,
        messages: [
          ...hello,
          assistantCalls('c1', 'c2'),
          { role: 'tool', tool_call_id: 'c1', content: 'x' },
        ],
      },
    ],
    [
      'a trailing assistant message with tool calls',
      { model: `${FAKE}/fake/echo`, messages: [...hello, assistantCalls('c1')] },
    ],
    [
      'a tool call left unanswered before a system message',
      {
        model: `${FAKE}/fake/echo`,
        messages: [...hello, assistantCalls('c1'), { role: 'developer', content: 'Be brief.' }],
      },
    ],
    ['temperature as a string', { model: `${FAKE}/fake/echo`, messages: hello, temperature: '1' }],
    ['a fractional max_tokens', { model: `${FAKE}/fake/echo`, messages: hello, max_tokens: 1.5 }],
    ['stop as a number', { model: `${FAKE}/fake/echo`, messages: hello, stop: 3 }],
    ['tools not an array', { model: `${FAKE}/fake/echo`, messages: hello, tools: {} }],
    [
      'an unknown tool_choice',
      { model: `${FAKE}/fake/echo`, messages: hello, tool_choice: 'sometimes' },
    ],
    [
      'an unknown response_format',
      { model: `${FAKE}/fake/echo`, messages: hello, response_format: { type: 'yaml' } },
    ],
    ['a JSON array', [1, 2]],
    ['not JSON', '{"model":'],
  ])('rejects a body with %s as 400 invalid_request', async (_name, body) => {
    const getConnection = fakeConnections();
    const { url, token } = await start({ getConnection });
    const response = await complete(url, token, body);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toEqual({
      code: 'invalid_request',
      message: expect.any(String) as string,
      type: 'harness_store',
    });
    // Validation runs before model resolution: nothing reaches a Provider.
    expect(getConnection).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
  });

  it('names the offending field in the message', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, { model: `${FAKE}/fake/echo` });
    expect((await errorOf(response)).message).toContain('messages');
  });

  it('accepts null for optional fields, as OpenAI does', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/echo`,
      messages: hello,
      temperature: null,
      tools: null,
      stop: null,
      response_format: null,
    });
    expect(response.status).toBe(200);
  });
});

describe('model resolution', () => {
  it('rejects a Provider without a Connection with 403 provider_not_connected', async () => {
    const getConnection = fakeConnections();
    const { url, token } = await start({ getConnection });
    for (const model of ['anthropic/claude-sonnet-4-5', 'openai-compatible:other/fake/echo']) {
      const response = await complete(url, token, { model, messages: hello });
      expect(response.status, model).toBe(403);
      expect(await errorOf(response)).toEqual({
        code: 'provider_not_connected',
        message: expect.any(String) as string,
        type: 'harness_store',
      });
    }
    expect(getConnection.mock.calls).toEqual([['anthropic'], ['openai-compatible:other']]);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ['a Slot name (resolved from P0-02.5 on)', 'default'],
    ['an unknown Provider', 'acme/model-1'],
    ['a malformed openai-compatible name', 'openai-compatible:Fake_1/fake/echo'],
    ['an empty model name', `${FAKE}/`],
    ['whitespace in the model name', `${FAKE}/fake echo`],
    ['a leading slash', '/fake/echo'],
  ])('rejects %s with 404 unknown_slot', async (_name, model) => {
    const getConnection = fakeConnections();
    const { url, token } = await start({ getConnection });
    const response = await complete(url, token, { model, messages: hello });
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toEqual({
      code: 'unknown_slot',
      message: expect.any(String) as string,
      type: 'harness_store',
    });
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('answers 500 internal_error when getConnection fails', async () => {
    const error = vi.fn<Logger['error']>();
    const { url, token } = await start({
      getConnection: () => Promise.reject(new Error('keychain locked')),
      logger: { debug: () => undefined, error },
    });
    const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe('internal_error');
    expect(error).toHaveBeenCalledOnce();
  });

  it('answers 500 internal_error for an openai-compatible Connection without a base URL', async () => {
    const { url, token } = await start({
      getConnection: () => Promise.resolve({ apiKey: API_KEY }),
    });
    const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    expect(response.status).toBe(500);
    expect((await errorOf(response)).code).toBe('internal_error');
  });
});

describe('Provider errors', () => {
  it('maps an upstream 500 to 502 provider_error with the status and message verbatim', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, { model: `${FAKE}/fake/500`, messages: hello });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toEqual({
      code: 'provider_error',
      message: expect.any(String) as string,
      type: 'provider',
      provider_status: 500,
      provider_message: 'The server had an error while processing your request. Sorry about that!',
    });
    // No retries behind the Harness's back.
    expect(fake.requests).toHaveLength(1);
  });

  it('maps an upstream 429 to 502 provider_error with provider_status 429', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/rate-limited`,
      messages: hello,
    });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toEqual({
      code: 'provider_error',
      message: expect.any(String) as string,
      type: 'provider',
      provider_status: 429,
      provider_message: 'Rate limit reached for requests. Please try again later.',
      provider_code: 'rate_limit_exceeded',
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('passes a Provider rejection (a missing image for fake/vision) through as provider_error', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, { model: `${FAKE}/fake/vision`, messages: hello });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toMatchObject({ code: 'provider_error', provider_status: 400 });
  });

  it('passes an unknown model at the Provider through as provider_error', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/no-such-model`,
      messages: hello,
    });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toMatchObject({
      code: 'provider_error',
      provider_status: 404,
      provider_code: 'model_not_found',
    });
  });

  it('reports a wrong Connection key as provider_error 401', async () => {
    const { url, token } = await start({
      getConnection: fakeConnections({ apiKey: 'sk-wrong-key-abcdefghijkl' }),
    });
    const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    expect(response.status).toBe(502);
    expect(await errorOf(response)).toMatchObject({
      code: 'provider_error',
      provider_status: 401,
      provider_code: 'invalid_api_key',
    });
  });

  it('maps a refused connection to 502 provider_error without provider_status', async () => {
    const closed = await startFakeProvider();
    const baseUrl = closed.url;
    await closed.close();
    const { url, token } = await start({ getConnection: fakeConnections({ baseUrl }) });
    const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    expect(response.status).toBe(502);
    const error = await errorOf(response);
    expect(error).toMatchObject({ code: 'provider_error', type: 'provider' });
    expect(error).not.toHaveProperty('provider_status');
    expect(error.provider_message).toEqual(expect.any(String));
  });

  it('maps a connection dropped mid-body to 502 provider_error', async () => {
    const { url, token } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stream-error`,
      messages: hello,
    });
    expect(response.status).toBe(502);
    const error = await errorOf(response);
    expect(error.code).toBe('provider_error');
    expect(error).not.toHaveProperty('provider_status');
  });
});

describe('timeouts', () => {
  it('answers 504 provider_timeout when the first byte is late, and aborts upstream', async () => {
    const { url, token } = await start({ firstByteTimeoutMs: 100 });
    const started = performance.now();
    const response = await complete(url, token, { model: `${FAKE}/fake/slow`, messages: hello });
    expect(response.status).toBe(504);
    expect(await errorOf(response)).toEqual({
      code: 'provider_timeout',
      message: expect.any(String) as string,
      type: 'provider',
    });
    // fake/slow holds its headers for 2 s; the Gateway gave up long before.
    expect(performance.now() - started).toBeLessThan(1500);
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });

  it('answers 504 provider_timeout when the body stalls past the idle timeout', async () => {
    const { url, token } = await start({ streamIdleTimeoutMs: 100 });
    const response = await complete(url, token, { model: `${FAKE}/fake/stall`, messages: hello });
    expect(response.status).toBe(504);
    expect((await errorOf(response)).code).toBe('provider_timeout');
    await vi.waitFor(() => {
      expect(fake.requests[0]?.aborted).toBe(true);
    });
  });

  it('does not time out a Provider that answers within the timeouts', async () => {
    const { url, token } = await start({ firstByteTimeoutMs: 5000, streamIdleTimeoutMs: 5000 });
    const response = await complete(url, token, { model: `${FAKE}/fake/slow`, messages: hello });
    expect(response.status).toBe(200);
  });
});

describe('authentication and secrets', () => {
  it('checks the Gateway Token before anything else', async () => {
    const getConnection = fakeConnections();
    const { url } = await start({ getConnection });
    for (const body of [{ model: `${FAKE}/fake/echo`, messages: hello }, { foo: 1 }, 'not json']) {
      for (const token of [undefined, 'not-a-token']) {
        const response = await complete(url, token, body);
        expect(response.status).toBe(401);
        expect((await errorOf(response)).code).toBe('invalid_token');
      }
    }
    expect(getConnection).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
  });

  it('sends the Connection key upstream and never the Gateway Token or inbound headers', async () => {
    const { url, token } = await start();
    const response = await complete(
      url,
      token,
      { model: `${FAKE}/fake/echo`, messages: hello },
      { 'x-harness-secret': 'do-not-forward', 'openai-organization': 'org-1' },
    );
    expect(response.status).toBe(200);
    const [request] = fake.requests;
    expect(request?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.stringify(request)).not.toContain(token);
    expect(request?.headers).not.toHaveProperty('x-harness-secret');
    expect(request?.headers).not.toHaveProperty('openai-organization');
  });

  it('fails a request in flight with 401 when its token is revoked, and aborts upstream', async () => {
    const { gateway, url, token } = await start();
    const pending = complete(url, token, { model: `${FAKE}/fake/slow`, messages: hello });
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

  it('logs the resolved model and upstream status, never content or secrets', async () => {
    const debug = vi.fn<Logger['debug']>();
    const { url, token } = await start({ logger: { debug, error: () => undefined } });
    await complete(url, token, {
      model: `${FAKE}/fake/rate-limited`,
      messages: [{ role: 'user', content: 'a very private question' }],
    });
    expect(debug).toHaveBeenCalledWith('request', {
      method: 'POST',
      path: '/v1/chat/completions',
      harnessId: 'alice/hello',
      model: `${FAKE}/fake/rate-limited`,
      status: 502,
      providerStatus: 429,
      durationMs: expect.any(Number) as number,
    });
    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).not.toContain('private question');
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(token);
  });
});

describe('a request body cut short', () => {
  /**
   * Sends a request's headers and the start of its body over a raw socket, resolving once the
   * Gateway is reading the body (it answers `Expect: 100-continue` before handling the request).
   */
  function startUpload(url: string, token: string): Promise<Socket> {
    const { port } = new URL(url);
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: Number(port) });
      socket.once('error', reject);
      socket.once('data', () => {
        resolve(socket);
      });
      socket.write(
        [
          'POST /v1/chat/completions HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          `Authorization: Bearer ${token}`,
          'Content-Type: application/json',
          'Content-Length: 1000',
          'Expect: 100-continue',
          '',
          '{"model":',
        ].join('\r\n'),
      );
    });
  }

  it('is not an internal error when the Harness hangs up mid-upload', async () => {
    const debug = vi.fn<Logger['debug']>();
    const error = vi.fn<Logger['error']>();
    const { url, token } = await start({ logger: { debug, error } });
    const socket = await startUpload(url, token);
    socket.destroy();
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith(
        'request',
        expect.objectContaining({ path: '/v1/chat/completions', status: 499 }),
      );
    });
    expect(error).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
  });

  it('is not an internal error when the Gateway closes mid-upload', async () => {
    const debug = vi.fn<Logger['debug']>();
    const error = vi.fn<Logger['error']>();
    const { gateway, url, token } = await start({ logger: { debug, error } });
    const socket = await startUpload(url, token);
    await gateway.close();
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith(
        'request',
        expect.objectContaining({ path: '/v1/chat/completions', status: 401 }),
      );
    });
    expect(error).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('fails with 401 when the token is revoked mid-upload', async () => {
    const { gateway, url, token } = await start();
    const socket = await startUpload(url, token);
    const reply = new Promise<string>((resolve) => {
      let text = '';
      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        if (text.includes('}}')) resolve(text);
      });
    });
    gateway.revokeToken(token);
    expect(await reply).toMatch(/^HTTP\/1\.1 401 [\s\S]*"code":"invalid_token"/);
    socket.destroy();
  });
});
