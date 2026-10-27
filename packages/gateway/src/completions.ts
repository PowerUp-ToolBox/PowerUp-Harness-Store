/**
 * `POST /v1/chat/completions`: one pipeline for every request, in the order gateway-protocol.md
 * §5 fixes. Validate the body (400), resolve `model` to a Provider, a model and a Connection
 * (404, 403), call the Provider through its adapter, then answer in the OpenAI shape, or with the
 * mapped Provider error (502, 504). Nothing before the upstream call reaches a Provider.
 */
import { generateText, wrapLanguageModel } from 'ai';
import type { LanguageModel } from 'ai';
import { createLanguageModel } from './adapters.js';
import { readJsonObject } from './body.js';
import { errorResponse } from './errors.js';
import { unlessAborted } from './in-flight.js';
import { parseChatCompletionRequest } from './openai/request.js';
import { toCallSettings, toChatCompletion } from './openai/translate.js';
import type { CallSettings } from './openai/translate.js';
import { parseModelRef } from './providers.js';
import { isProviderFailure, providerError, providerTimeout } from './provider-errors.js';
import type { ConnectionSecret, GatewayOptions } from './types.js';
import { createUpstreamFetch } from './upstream-fetch.js';
import type { UpstreamTimeouts } from './upstream-fetch.js';

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
}

/** What one request saw, for the request log: metadata only. */
export interface CompletionTrace {
  /** The resolved `provider/model`. */
  model?: string;
  /** The upstream HTTP status, once the Provider answered. */
  providerStatus?: number;
}

export interface CompletionRequest {
  readonly request: Request;
  /** Aborted when the Gateway Token is revoked or the Gateway closes. */
  readonly signal: AbortSignal;
  readonly trace: CompletionTrace;
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

/** Calls the Provider and answers the `chat.completion`, or the mapped Provider error. */
async function complete(
  resolved: ResolvedModel,
  settings: CallSettings,
  deps: CompletionDeps,
  { request, signal, trace }: CompletionRequest,
): Promise<Response> {
  const model = `${resolved.providerId}/${resolved.model}`;
  const upstream = createUpstreamFetch(deps.timeouts);
  // Stop the upstream call when the Harness hangs up, too.
  const abortSignal = AbortSignal.any([signal, request.signal]);
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
  try {
    const result = await generateText({
      model: languageModel,
      ...callSettings,
      // OpenAI clients put system messages anywhere in `messages`; they come from the Harness.
      allowSystemInMessages: true,
      // Retries would repeat a failing call behind the Harness's back (and its Usage Record).
      maxRetries: 0,
      abortSignal,
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
    if (upstream.timedOut) {
      const firstByte = upstream.status === undefined;
      const mapped = providerTimeout(
        firstByte ? deps.timeouts.firstByteMs : deps.timeouts.idleMs,
        firstByte,
      );
      return errorResponse(mapped.code, mapped.message, mapped.fields);
    }
    if (!isProviderFailure(error)) throw error;
    const mapped = providerError(error, resolved.connection.apiKey);
    return errorResponse(mapped.code, mapped.message, mapped.fields);
  } finally {
    if (upstream.status !== undefined) trace.providerStatus = upstream.status;
  }
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
  if (parsed.request.stream === true) {
    // Streaming arrives with P0-02.4.
    return errorResponse('invalid_request', 'Streaming is not supported yet.');
  }
  const translated = toCallSettings(parsed.request);
  if (!translated.ok) return errorResponse('invalid_request', translated.message);

  const resolved = await resolveModel(parsed.request.model, deps, call.signal);
  if (resolved instanceof Response) return resolved;
  call.trace.model = `${resolved.providerId}/${resolved.model}`;
  return complete(resolved, translated.settings, deps, call);
}
