/**
 * The fake Provider: a scriptable OpenAI-compatible HTTP server on loopback that every Model
 * Gateway, Runtime and end-to-end test runs against instead of a real model vendor. It speaks the
 * Chat Completions wire format closely enough that the OpenAI SDK and the Vercel AI SDK's
 * `openai-compatible` adapter treat it like a real Provider. It stands in for a Provider in tests;
 * it is not a Provider a User ever sees.
 *
 * The request's `model` picks a scenario (exact name, see {@link FAKE_SCENARIOS}), so one running
 * server serves every test case. Every request is recorded, so a test can assert on exactly what
 * was sent upstream. It never makes an outbound call.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { serveLoopback } from '../serve.js';

/**
 * The scenarios, by model name. Every one honours the request's `stream` flag.
 *
 * - `fake/echo`, `fake/echo-stream`: replies with the text of the last user message, word for
 *   word (one SSE chunk per word when streaming). Token counts are whitespace-separated words.
 * - `fake/tool-call`: calls `tools[0]` with `{"input":"<last user text>"}`;
 *   `fake/tool-call-parallel` calls the first two tools (or `tools[0]` twice). Once the last
 *   message is a `tool` result, it answers with that result as text, so agent loops end.
 * - `fake/stream-no-usage`: like `fake/echo`, but never reports usage.
 * - `fake/vision`: succeeds only when a user message has an `image_url` part (URL or data URL).
 * - `fake/500`, `fake/rate-limited`: OpenAI-shaped errors at HTTP 500 and 429.
 * - `fake/slow`: like `fake/echo`, after holding back the response headers for `slowMs`.
 * - `fake/stall`: sends the start of the response, then nothing until the client leaves or the
 *   server closes.
 * - `fake/stream-error`: sends the start of the response, then drops the connection.
 */
export const FAKE_SCENARIOS = [
  'fake/echo',
  'fake/echo-stream',
  'fake/tool-call',
  'fake/tool-call-parallel',
  'fake/stream-no-usage',
  'fake/vision',
  'fake/500',
  'fake/rate-limited',
  'fake/slow',
  'fake/stall',
  'fake/stream-error',
] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

export interface FakeProviderOptions {
  /** Loopback host to bind: `127.0.0.1` (default), `::1` or `localhost`. Anything else throws. */
  host?: string;
  /**
   * Port to bind. 0 (default) lets the OS choose; a fixed port lets the fake stand in for a local
   * Provider (Ollama on 11434).
   */
  port?: number;
  /** How long `fake/slow` holds back its response headers, in milliseconds. Default 1000. */
  slowMs?: number;
  /** Extra model names served by a scenario, e.g. `{ 'qwen3:8b': 'fake/echo' }`. */
  aliases?: Readonly<Record<string, FakeScenario>>;
  /**
   * When set, every request needs `Authorization: Bearer <apiKey>` and gets 401
   * `invalid_api_key` otherwise. When unset, any `Authorization` (or none) is accepted.
   */
  apiKey?: string;
}

/** One request as the fake received it. */
export interface RecordedRequest {
  method: string;
  /** Path and query string, e.g. `/v1/chat/completions`. */
  path: string;
  /** Request headers, names lower-cased. */
  headers: Record<string, string>;
  /** The body parsed as JSON; the raw text when it is not JSON; `null` when empty. */
  body: unknown;
  /**
   * Becomes true when the client disconnects before the response finished (not when the fake
   * ends the connection itself: `fake/stream-error`, `close()`).
   */
  aborted: boolean;
}

export interface FakeProvider {
  /** OpenAI base URL, `http://<host>:<port>/v1` (IPv6 in brackets). */
  readonly url: string;
  readonly port: number;
  /** Every request received since start or the last {@link reset}, oldest first. */
  readonly requests: readonly RecordedRequest[];
  /** Forgets the recorded requests. */
  reset(): void;
  /**
   * Cancels pending `fake/slow` delays, destroys every open connection (stalled streams
   * included) and stops listening. Idempotent.
   */
  close(): Promise<void>;
}

/** Starts a fake Provider; resolves once it is listening. */
export async function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const { host = '127.0.0.1', port = 0, slowMs = 1000, aliases = {}, apiKey } = options;
  if (!Number.isFinite(slowMs) || slowMs < 0) {
    throw new Error(`Invalid slowMs ${String(slowMs)}: expected a non-negative number.`);
  }
  for (const [alias, scenario] of Object.entries(aliases)) {
    if (!isScenario(scenario))
      throw new Error(`Alias ${alias} points at unknown ${String(scenario)}.`);
  }
  const state: FakeState = {
    requests: [],
    aliases: new Map(Object.entries(aliases)),
    slowMs,
    apiKey,
    closing: false,
    delays: new Set(),
    completions: 0,
  };
  const server = await serveLoopback(createApp(state).fetch, { host, port });
  return {
    url: `${server.origin}/v1`,
    port: server.port,
    get requests() {
      return state.requests;
    },
    reset() {
      state.requests.length = 0;
    },
    close() {
      state.closing = true;
      for (const cancel of state.delays) cancel();
      return server.close();
    },
  };
}

interface FakeState {
  readonly requests: RecordedRequest[];
  readonly aliases: ReadonlyMap<string, FakeScenario>;
  readonly slowMs: number;
  readonly apiKey: string | undefined;
  closing: boolean;
  /** Cancels a pending `fake/slow` delay. */
  readonly delays: Set<() => void>;
  completions: number;
}

type Body = { ok: true; value: unknown } | { ok: false };

interface AppEnv {
  Bindings: HttpBindings;
  Variables: { body: Body; endedByServer: () => void };
}

type Ctx = Context<AppEnv>;

/** An OpenAI error body: `{ error: { message, type, code } }`. */
function openAiError(c: Ctx, status: 400 | 401 | 404 | 429 | 500, error: OpenAiErrorFields) {
  return c.json({ error }, status);
}

interface OpenAiErrorFields {
  message: string;
  type: string;
  code: string | null;
}

function createApp(state: FakeState): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Record every request, then check the API key.
  app.use(async (c, next) => {
    const url = new URL(c.req.url);
    const text = await c.req.text();
    let body: Body = { ok: true, value: null };
    if (text !== '') {
      try {
        body = { ok: true, value: JSON.parse(text) as unknown };
      } catch {
        body = { ok: false };
      }
    }
    const recorded: RecordedRequest = {
      method: c.req.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(c.req.raw.headers),
      body: body.ok ? body.value : text,
      aborted: false,
    };
    state.requests.push(recorded);
    let endedByServer = false;
    const { outgoing } = c.env;
    outgoing.once('close', () => {
      if (!outgoing.writableFinished && !endedByServer && !state.closing) recorded.aborted = true;
    });
    c.set('body', body);
    c.set('endedByServer', () => {
      endedByServer = true;
    });

    if (state.apiKey !== undefined) {
      const match = /^Bearer (\S+)$/i.exec(c.req.header('authorization') ?? '');
      if (match?.[1] !== state.apiKey) {
        return openAiError(c, 401, {
          message: 'Incorrect API key provided.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        });
      }
    }
    await next();
    return undefined;
  });

  app.get('/v1/models', (c) =>
    c.json({
      object: 'list',
      data: [...FAKE_SCENARIOS, ...state.aliases.keys()].map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'fake-provider',
      })),
    }),
  );

  app.post('/v1/chat/completions', (c) => chatCompletion(c, state));

  app.notFound((c) =>
    openAiError(c, 404, {
      message: `Unknown request URL: ${c.req.method} ${new URL(c.req.url).pathname}.`,
      type: 'invalid_request_error',
      code: 'unknown_url',
    }),
  );

  app.onError((error, c) =>
    openAiError(c, 500, {
      message: `Fake Provider bug: ${error instanceof Error ? error.message : String(error)}`,
      type: 'server_error',
      code: null,
    }),
  );

  return app;
}

/** The subset of a Chat Completions request the scenarios read; everything else is ignored. */
interface ChatRequest {
  model: string;
  messages: Record<string, unknown>[];
  stream: boolean;
  includeUsage: boolean;
  tools: unknown;
}

function parseChatRequest(value: unknown): ChatRequest | string {
  if (!isRecord(value)) return 'The request body must be a JSON object.';
  const { model, messages, stream, stream_options: streamOptions, tools } = value;
  if (typeof model !== 'string') return 'you must provide a model parameter';
  if (!Array.isArray(messages) || messages.length === 0 || !messages.every(isRecord)) {
    return "Invalid 'messages': expected a non-empty array of objects.";
  }
  return {
    model,
    messages,
    stream: stream === true,
    includeUsage: isRecord(streamOptions) && streamOptions.include_usage === true,
    tools,
  };
}

/** What a scenario answers, before it is rendered as JSON or SSE. */
type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'tool_calls'; calls: { id: string; name: string; arguments: string }[] };

/** How the response ends: normally, by stalling, or by dropping the connection. */
type Ending = 'complete' | 'stall' | 'drop';

async function chatCompletion(c: Ctx, state: FakeState): Promise<Response> {
  const body = c.get('body');
  if (!body.ok) {
    return openAiError(c, 400, {
      message: 'We could not parse the JSON body of your request.',
      type: 'invalid_request_error',
      code: null,
    });
  }
  const request = parseChatRequest(body.value);
  if (typeof request === 'string') {
    return openAiError(c, 400, { message: request, type: 'invalid_request_error', code: null });
  }
  const scenario = isScenario(request.model) ? request.model : state.aliases.get(request.model);
  if (scenario === undefined) {
    return openAiError(c, 404, {
      message: `The model \`${request.model}\` does not exist or you do not have access to it.`,
      type: 'invalid_request_error',
      code: 'model_not_found',
    });
  }

  let reply: Reply;
  let ending: Ending = 'complete';
  let reportUsage = true;
  switch (scenario) {
    case 'fake/500':
      return openAiError(c, 500, {
        message: 'The server had an error while processing your request. Sorry about that!',
        type: 'server_error',
        code: null,
      });
    case 'fake/rate-limited':
      return openAiError(c, 429, {
        message: 'Rate limit reached for requests. Please try again later.',
        type: 'requests',
        code: 'rate_limit_exceeded',
      });
    case 'fake/tool-call':
    case 'fake/tool-call-parallel': {
      const result = toolCallReply(request, scenario === 'fake/tool-call-parallel');
      if (typeof result === 'string') {
        return openAiError(c, 400, { message: result, type: 'invalid_request_error', code: null });
      }
      reply = result;
      break;
    }
    case 'fake/vision': {
      const images = countImages(request.messages);
      if (images === 0) {
        return openAiError(c, 400, {
          message: 'fake/vision needs at least one image_url content part in a user message.',
          type: 'invalid_request_error',
          code: null,
        });
      }
      reply = { kind: 'text', text: `I see ${String(images)} image${images === 1 ? '' : 's'}.` };
      break;
    }
    case 'fake/slow':
      if (!(await delay(state, state.slowMs, c.req.raw.signal))) {
        // The client left or the server is closing; nobody reads this.
        return new Response(null, { status: 503 });
      }
      reply = { kind: 'text', text: lastUserText(request.messages) };
      break;
    case 'fake/stall':
    case 'fake/stream-error':
      reply = { kind: 'text', text: lastUserText(request.messages) || 'partial reply' };
      ending = scenario === 'fake/stall' ? 'stall' : 'drop';
      break;
    case 'fake/stream-no-usage':
      reportUsage = false;
      reply = { kind: 'text', text: lastUserText(request.messages) };
      break;
    case 'fake/echo':
    case 'fake/echo-stream':
      reply = { kind: 'text', text: lastUserText(request.messages) };
      break;
  }

  state.completions += 1;
  const meta: CompletionMeta = {
    id: `chatcmpl-fake-${String(state.completions)}`,
    created: Math.floor(Date.now() / 1000),
    model: request.model,
  };
  const usage = reportUsage ? usageOf(request.messages, reply) : undefined;

  if (request.stream) {
    const events = streamEvents(reply, meta, request.includeUsage ? usage : undefined);
    // A partial stream is the role chunk and the first content chunk.
    if (ending !== 'complete')
      return sendPartial(c, SSE_HEADERS, events.slice(0, 2).join(''), ending);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const event of events) controller.enqueue(encoder.encode(event));
          controller.close();
        },
      }),
      { headers: SSE_HEADERS },
    );
  }
  const json = JSON.stringify(completionBody(reply, meta, usage));
  if (ending !== 'complete') {
    return sendPartial(c, JSON_HEADERS, json.slice(0, Math.floor(json.length / 2)), ending);
  }
  return new Response(json, { headers: JSON_HEADERS });
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
};
const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * Writes the status, the headers and `text` straight to the socket, then either leaves the
 * response open (`stall`) or destroys the connection once `text` is flushed (`drop`).
 */
function sendPartial(
  c: Ctx,
  headers: Record<string, string>,
  text: string,
  ending: 'stall' | 'drop',
): Response {
  const { outgoing } = c.env;
  outgoing.writeHead(200, headers);
  outgoing.write(text, () => {
    if (ending === 'drop') {
      c.get('endedByServer')();
      outgoing.destroy();
    }
  });
  return RESPONSE_ALREADY_SENT;
}

/**
 * Waits `ms`; resolves false instead when the client disconnects or the server closes first.
 * Pending delays are tracked so close() leaves no timer behind.
 */
function delay(state: FakeState, ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      state.delays.delete(cancel);
      signal.removeEventListener('abort', cancel);
      resolve(completed);
    };
    const cancel = () => {
      finish(false);
    };
    const timer = setTimeout(() => {
      finish(true);
    }, ms);
    state.delays.add(cancel);
    signal.addEventListener('abort', cancel);
    if (signal.aborted || state.closing) cancel();
  });
}

function toolCallReply(request: ChatRequest, parallel: boolean): Reply | string {
  const { tools, messages } = request;
  if (!Array.isArray(tools) || tools.length === 0) {
    return 'fake/tool-call needs a non-empty tools array.';
  }
  const names: string[] = [];
  for (const tool of tools) {
    const name = isRecord(tool) && isRecord(tool.function) ? tool.function.name : undefined;
    if (typeof name !== 'string') return 'Every tool needs function.name.';
    names.push(name);
  }
  const last = messages.at(-1);
  if (last?.role === 'tool') return { kind: 'text', text: textOf(last) };
  const called = parallel ? [names[0], names[1] ?? names[0]] : [names[0]];
  const args = JSON.stringify({ input: lastUserText(messages) });
  return {
    kind: 'tool_calls',
    calls: called.map((name, index) => ({
      id: `call_${String(index)}`,
      name: name ?? '',
      arguments: args,
    })),
  };
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Tokens are whitespace-separated words: of every message's text, and of the reply. */
function usageOf(messages: readonly Record<string, unknown>[], reply: Reply): Usage {
  const prompt = messages.reduce((sum, message) => sum + countWords(textOf(message)), 0);
  const completion =
    reply.kind === 'text'
      ? countWords(reply.text)
      : reply.calls.reduce((sum, call) => sum + countWords(call.arguments), 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

interface CompletionMeta {
  id: string;
  created: number;
  model: string;
}

function finishReason(reply: Reply): 'stop' | 'tool_calls' {
  return reply.kind === 'text' ? 'stop' : 'tool_calls';
}

/** A non-streaming `chat.completion` object; `usage` is left out when undefined. */
function completionBody(reply: Reply, meta: CompletionMeta, usage: Usage | undefined) {
  const message =
    reply.kind === 'text'
      ? { role: 'assistant', content: reply.text }
      : {
          role: 'assistant',
          content: null,
          tool_calls: reply.calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        };
  return {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason(reply) }],
    ...(usage && { usage }),
  };
}

/**
 * The SSE events of a streamed completion, as OpenAI sends them: a role chunk, the content (one
 * chunk per word) or the tool calls (each call's arguments in two fragments), a chunk with the
 * finish reason, the usage chunk (`choices: []`) when `usage` is given, then `[DONE]`.
 */
function streamEvents(reply: Reply, meta: CompletionMeta, usage: Usage | undefined): string[] {
  const chunk = (choices: unknown[], extra: object = {}) =>
    `data: ${JSON.stringify({ id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model, choices, ...extra })}\n\n`;
  const delta = (value: object, finish: string | null = null) =>
    chunk([{ index: 0, delta: value, logprobs: null, finish_reason: finish }]);

  const events: string[] = [];
  if (reply.kind === 'text') {
    events.push(delta({ role: 'assistant', content: '' }));
    for (const word of splitWords(reply.text)) events.push(delta({ content: word }));
  } else {
    events.push(delta({ role: 'assistant', content: null }));
    reply.calls.forEach((call, index) => {
      const middle = Math.ceil(call.arguments.length / 2);
      const [head, tail] = [call.arguments.slice(0, middle), call.arguments.slice(middle)];
      events.push(
        delta({
          tool_calls: [
            {
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: head },
            },
          ],
        }),
        delta({ tool_calls: [{ index, function: { arguments: tail } }] }),
      );
    });
  }
  events.push(delta({}, finishReason(reply)));
  if (usage) events.push(chunk([], { usage }));
  events.push('data: [DONE]\n\n');
  return events;
}

/** Splits `text` into pieces that each hold one word and that concatenate back to `text`. */
function splitWords(text: string): string[] {
  return text.split(/(?<=\s)(?=\S)/).filter((piece) => piece !== '');
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/** A message's text: its string content, or its text parts joined by spaces. */
function textOf(message: Record<string, unknown>): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : []))
    .join(' ');
}

function lastUserText(messages: readonly Record<string, unknown>[]): string {
  const last = messages.findLast((message) => message.role === 'user');
  return last ? textOf(last) : '';
}

/** `image_url` parts with an http(s) URL or a data URL, across user messages. */
function countImages(messages: readonly Record<string, unknown>[]): number {
  let images = 0;
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== 'image_url' || !isRecord(part.image_url)) continue;
      const { url } = part.image_url;
      if (typeof url === 'string' && /^(https?:\/\/|data:image\/)/i.test(url)) images += 1;
    }
  }
  return images;
}

function isScenario(model: string): model is FakeScenario {
  return (FAKE_SCENARIOS as readonly string[]).includes(model);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
