/**
 * `POST /v1/chat/completions`: one pipeline for every request, in the order gateway-protocol.md
 * §5 fixes. Validate the body (400), resolve `model` to a Provider, a model and a Connection
 * (404, 403), call the Provider through its adapter, then answer in the OpenAI shape (a
 * `chat.completion`, or server-sent `chat.completion.chunk`s for `stream: true`), or with the
 * mapped Provider error (502, 504). Nothing before the upstream call reaches a Provider.
 */
import { generateText, streamText, wrapLanguageModel } from 'ai';
import type { LanguageModel, TextStreamPart, ToolSet } from 'ai';
import { createLanguageModel } from './adapters.js';
import { readJsonObject } from './body.js';
import { errorBody, errorResponse } from './errors.js';
import type { GatewayErrorCode } from './errors.js';
import { unlessAborted } from './in-flight.js';
import type { Logger } from './logging.js';
import { parseChatCompletionRequest } from './openai/request.js';
import { ChunkTranslator, SSE_DONE, sseError, sseEvent } from './openai/stream.js';
import { newCompletionId, toCallSettings, toChatCompletion } from './openai/translate.js';
import type { CallSettings } from './openai/translate.js';
import { parseModelRef } from './providers.js';
import { isProviderFailure, providerError, providerTimeout } from './provider-errors.js';
import type { MappedProviderError } from './provider-errors.js';
import type { ConnectionSecret, GatewayOptions } from './types.js';
import { createUpstreamFetch } from './upstream-fetch.js';
import type { UpstreamFetch, UpstreamTimeouts } from './upstream-fetch.js';

/** A model the request resolved to, with the Connection to reach it. */
export interface ResolvedModel {
  providerId: string;
  /** The model name at the Provider, without the Provider prefix. */
  model: string;
  /** The Model Slot asked for; `null` for an explicit `provider/model` id. */
  slot: string | null;
  connection: ConnectionSecret;
}

export interface CompletionDeps {
  readonly options: Pick<GatewayOptions, 'getConnection'>;
  readonly timeouts: UpstreamTimeouts;
  /** For a Gateway bug that surfaces after a stream started, when no 500 can be sent anymore. */
  readonly logger: Logger;
}

/** What one request saw, for the request log: metadata only. */
export interface CompletionTrace {
  /** The resolved `provider/model`. */
  model?: string;
  /** The upstream HTTP status, once the Provider answered. */
  providerStatus?: number;
  /**
   * Set for a streamed response, whose body outlives the handler: settles once the stream has
   * ended, so the request is logged with its whole duration.
   */
  streamEnded?: Promise<void>;
  /** The code of the error event a started stream ended with, if any. */
  streamError?: GatewayErrorCode;
}

export interface CompletionRequest {
  readonly request: Request;
  /** Aborted when the Gateway Token is revoked or the Gateway closes. */
  readonly signal: AbortSignal;
  readonly trace: CompletionTrace;
  /**
   * Keeps the request registered as in flight after the handler returns, for a streamed response
   * whose body is still being written. Returns the function that ends it.
   */
  readonly detach: () => () => void;
}

/**
 * Resolves `model` to a Provider, a model and a Connection, or answers the error. Slot names
 * resolve through Slot Bindings from P0-02.5 on; until then they are `unknown_slot`.
 */
async function resolveModel(
  model: string,
  deps: CompletionDeps,
  signal: AbortSignal,
): Promise<ResolvedModel | Response> {
  const ref = parseModelRef(model);
  if (ref?.kind !== 'explicit') {
    return errorResponse(
      'unknown_slot',
      `${JSON.stringify(model)} is neither a Model Slot of this Harness nor a valid provider/model id.`,
    );
  }
  const connection = await unlessAborted(deps.options.getConnection(ref.providerId), signal);
  if (connection === null) {
    return errorResponse(
      'provider_not_connected',
      `There is no Connection for the Provider ${ref.providerId}.`,
    );
  }
  return { providerId: ref.providerId, model: ref.model, slot: null, connection };
}

/**
 * `model` with the Harness's `tool_choice` handed to the Provider below the AI SDK. Given the tool
 * choice itself, the AI SDK checks the reply against it and throws when the Provider did not
 * comply, which many Providers (small local models especially) do not. The Gateway passes the
 * Provider's reply through instead, so it never enforces `tool_choice` itself.
 */
function withProviderToolChoice(
  model: Exclude<LanguageModel, string>,
  toolChoice: CallSettings['toolChoice'],
): Exclude<LanguageModel, string> {
  if (toolChoice === undefined || toolChoice === 'auto') return model;
  const choice =
    typeof toolChoice === 'string'
      ? { type: toolChoice }
      : { type: 'tool' as const, toolName: toolChoice.toolName };
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: ({ params }) => Promise.resolve({ ...params, toolChoice: choice }),
    },
  });
}

/** What every upstream call starts from: the adapter's model behind the Gateway's timed fetch. */
interface UpstreamCall {
  /** The resolved `provider/model`, as responses report it. */
  model: string;
  languageModel: Exclude<LanguageModel, string>;
  upstream: UpstreamFetch;
  callSettings: Omit<CallSettings, 'toolChoice'>;
}

function prepareCall(
  resolved: ResolvedModel,
  settings: CallSettings,
  deps: CompletionDeps,
): UpstreamCall {
  const upstream = createUpstreamFetch(deps.timeouts);
  const { toolChoice, ...callSettings } = settings;
  const languageModel = withProviderToolChoice(
    createLanguageModel({
      providerId: resolved.providerId,
      model: resolved.model,
      connection: resolved.connection,
      fetch: upstream.fetch,
    }),
    toolChoice,
  );
  return {
    model: `${resolved.providerId}/${resolved.model}`,
    languageModel,
    upstream,
    callSettings,
  };
}

/**
 * The documented error for a failed upstream call: `provider_timeout` when one of the Gateway's
 * timeouts aborted it, else `provider_error`. `undefined` for an error the Provider did not cause
 * (a Gateway bug), which the caller reports as `internal_error`.
 */
function upstreamFailure(
  error: unknown,
  upstream: UpstreamFetch,
  resolved: ResolvedModel,
  timeouts: UpstreamTimeouts,
): MappedProviderError | undefined {
  if (upstream.timedOut) {
    const firstByte = upstream.status === undefined;
    return providerTimeout(firstByte ? timeouts.firstByteMs : timeouts.idleMs, firstByte);
  }
  return isProviderFailure(error) ? providerError(error, resolved.connection.apiKey) : undefined;
}

/** Calls the Provider and answers the `chat.completion`, or the mapped Provider error. */
async function complete(
  resolved: ResolvedModel,
  settings: CallSettings,
  deps: CompletionDeps,
  { request, signal, trace }: CompletionRequest,
): Promise<Response> {
  const { model, languageModel, upstream, callSettings } = prepareCall(resolved, settings, deps);
  try {
    const result = await generateText({
      model: languageModel,
      ...callSettings,
      // OpenAI clients put system messages anywhere in `messages`; they come from the Harness.
      allowSystemInMessages: true,
      // Retries would repeat a failing call behind the Harness's back (and its Usage Record).
      maxRetries: 0,
      // Stop the upstream call when the Harness hangs up, too.
      abortSignal: AbortSignal.any([signal, request.signal]),
    });
    let text = result.text;
    if (settings.output !== undefined) {
      try {
        // The structured-output text, which some adapters report apart from the plain text.
        text = result.output;
      } catch {
        // No output (tool calls only): keep the plain text.
      }
    }
    return Response.json(
      toChatCompletion(
        {
          text,
          toolCalls: result.toolCalls,
          finishReason: result.finishReason,
          usage: result.usage,
        },
        model,
      ),
    );
  } catch (error) {
    signal.throwIfAborted();
    // The Harness hung up: nobody reads this response.
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const mapped = upstreamFailure(error, upstream, resolved, deps.timeouts);
    if (mapped === undefined) throw error;
    return errorResponse(mapped.code, mapped.message, mapped.fields);
  } finally {
    if (upstream.status !== undefined) trace.providerStatus = upstream.status;
  }
}

type StreamPart = TextStreamPart<ToolSet>;

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };

/**
 * Calls the Provider with streaming and answers server-sent events. The 200 headers go out only
 * once the Provider's answer starts (the first stream part other than `start`/`start-step`), so
 * anything that fails before then is an ordinary HTTP error, exactly as without streaming. After
 * that a failure ends the stream with an error event and `[DONE]`: the mapped Provider error, or
 * `invalid_token` when the Gateway Token is revoked (closing the Gateway drops the connection
 * instead). When the Harness stops reading, the upstream call is aborted.
 */
async function completeStream(
  resolved: ResolvedModel,
  settings: CallSettings,
  includeUsage: boolean,
  deps: CompletionDeps,
  { request, signal, trace, detach }: CompletionRequest,
): Promise<Response> {
  const { model, languageModel, upstream, callSettings } = prepareCall(resolved, settings, deps);
  /** Aborted when the Harness stops reading the stream, or the stream ends in a failure. */
  const stop = new AbortController();
  const result = streamText({
    model: languageModel,
    ...callSettings,
    allowSystemInMessages: true,
    maxRetries: 0,
    abortSignal: AbortSignal.any([signal, request.signal, stop.signal]),
    // Failures arrive as `error` parts below; the default handler would print them.
    onError: () => undefined,
  });
  const parts = result.stream[Symbol.asyncIterator]();
  /** The next part; `undefined` once the stream is over. Never rejects. */
  const next = async (): Promise<StreamPart | undefined> => {
    try {
      const step = await parts.next();
      return step.done === true ? undefined : step.value;
    } catch (error) {
      return { type: 'error', error };
    }
  };

  let first: StreamPart | undefined;
  try {
    do {
      // A revoked token fails the request with 401 even if the stream is slow to notice.
      first = await unlessAborted(next(), signal);
    } while (first?.type === 'start' || first?.type === 'start-step');
  } finally {
    if (upstream.status !== undefined) trace.providerStatus = upstream.status;
  }
  if (first === undefined || first.type === 'error' || first.type === 'abort') {
    stop.abort();
    signal.throwIfAborted();
    if (request.signal.aborted) return new Response(null, { status: 499 });
    const error = first?.type === 'error' ? first.error : new Error('The stream ended unanswered.');
    const mapped = upstreamFailure(error, upstream, resolved, deps.timeouts);
    if (mapped === undefined) throw error;
    return errorResponse(mapped.code, mapped.message, mapped.fields);
  }

  // From here on the response outlives this handler: keep it in flight until the stream ends.
  const endInFlight = detach();
  let streamEnded: () => void = () => undefined;
  trace.streamEnded = new Promise((resolve) => {
    streamEnded = resolve;
  });
  const translator = new ChunkTranslator(newCompletionId(), model, includeUsage);
  const encoder = new TextEncoder();
  let ended = false;
  const end = (failed: boolean) => {
    if (ended) return;
    ended = true;
    if (failed) stop.abort();
    endInFlight();
    streamEnded();
  };
  /** The events that end the stream after a failure; `undefined` when nobody reads them. */
  const failureEvents = (part: Extract<StreamPart, { type: 'error' | 'abort' }>) => {
    if (signal.aborted) {
      trace.streamError = 'invalid_token';
      return sseError(errorBody('invalid_token', 'The Gateway Token was revoked.'));
    }
    if (request.signal.aborted || stop.signal.aborted) return undefined;
    const error = part.type === 'error' ? part.error : new Error('The stream was aborted.');
    const mapped = upstreamFailure(error, upstream, resolved, deps.timeouts);
    if (mapped !== undefined) {
      trace.streamError = mapped.code;
      return sseError(errorBody(mapped.code, mapped.message, mapped.fields));
    }
    trace.streamError = 'internal_error';
    deps.logger.error('internal error', {
      method: 'POST',
      path: '/v1/chat/completions',
      model,
      error,
    });
    return sseError(errorBody('internal_error', 'The Model Gateway failed to handle the request.'));
  };

  const firstChunks = [translator.start(), ...translator.translate(first)];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunks.map(sseEvent).join('')));
    },
    async pull(controller) {
      for (;;) {
        const part = await next();
        // The Harness stopped reading meanwhile.
        if (ended) return;
        if (part === undefined) {
          controller.enqueue(encoder.encode(SSE_DONE));
          controller.close();
          end(false);
          return;
        }
        if (part.type === 'error' || part.type === 'abort') {
          const events = failureEvents(part);
          if (events !== undefined) controller.enqueue(encoder.encode(events));
          controller.close();
          end(true);
          return;
        }
        const chunks = translator.translate(part);
        if (chunks.length > 0) {
          controller.enqueue(encoder.encode(chunks.map(sseEvent).join('')));
          return;
        }
      }
    },
    cancel() {
      end(true);
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

/** Handles `POST /v1/chat/completions` for an authenticated request. */
export async function handleChatCompletion(
  deps: CompletionDeps,
  call: CompletionRequest,
): Promise<Response> {
  let body;
  try {
    body = await unlessAborted(readJsonObject(call.request), call.signal);
  } catch {
    // Revoked or closed while the body was arriving.
    call.signal.throwIfAborted();
    // The body stream fails only when the Harness hangs up mid-upload: nobody reads this response.
    return new Response(null, { status: 499 });
  }
  if (!body.ok) return errorResponse('invalid_request', body.message);
  const parsed = parseChatCompletionRequest(body.value);
  if (!parsed.ok) return errorResponse('invalid_request', parsed.message);
  const translated = toCallSettings(parsed.request);
  if (!translated.ok) return errorResponse('invalid_request', translated.message);

  const resolved = await resolveModel(parsed.request.model, deps, call.signal);
  if (resolved instanceof Response) return resolved;
  call.trace.model = `${resolved.providerId}/${resolved.model}`;
  const { stream, stream_options: streamOptions } = parsed.request;
  if (stream !== true) return complete(resolved, translated.settings, deps, call);
  const includeUsage = streamOptions?.include_usage === true;
  return completeStream(resolved, translated.settings, includeUsage, deps, call);
}
