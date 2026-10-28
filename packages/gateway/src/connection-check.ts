/**
 * Connection tests and model listing, for the desktop app's Models page: a small real request
 * that tells whether a Connection works, with the Provider's own error text when it does not, and
 * the models a Connection offers. Both go through the same adapters, `fetch` wrapper and error
 * mapper as the Gateway's upstream calls, so a key never appears in what they report and a
 * passing test means the Gateway reaches the same place.
 */
import { APICallError, generateText } from 'ai';
import { createLanguageModel } from './adapters.js';
import { catalogueModels } from './catalogue.js';
import type { ModelInfo } from './catalogue.js';
import { isProviderFailure, providerError, providerTimeout } from './provider-errors.js';
import { findProvider } from './providers.js';
import { createUpstreamFetch } from './upstream-fetch.js';

/** How long a test or a listing waits for the Provider, in milliseconds: 15 s. */
export const CHECK_TIMEOUT_MS = 15_000;

/** The Connection a test or listing reaches. */
export interface CheckTarget {
  /** The Provider id; `openai-compatible:<name>` is served by the `openai-compatible` row. */
  providerId: string;
  apiKey?: string;
  /** Overrides the Provider's default base URL; required for `openai-compatible`. */
  baseUrl?: string;
  /** The `fetch` to call the Provider with: Node's, as the Gateway's upstream calls use. */
  fetch: typeof globalThis.fetch;
  /** Default {@link CHECK_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The models of a Connection, or why they could not be listed. */
export type ModelListResult =
  { ok: true; models: readonly ModelInfo[] } | { ok: false; detail: string };

/**
 * A test result: on success, the models the test found (absent when it listed none, an
 * OpenRouter key check whose listing failed say); on failure, the Provider's own error text.
 */
export type ConnectionTestOutcome =
  { ok: true; models?: readonly ModelInfo[] } | { ok: false; detail: string };

/**
 * The models a Connection offers: the catalogue for Anthropic and Google (no network call),
 * `GET {baseUrl}/models` for every Provider that lists its models (`data[].id`, with the key as a
 * Bearer token when there is one), and an empty list for the rest, where the User types a model
 * name.
 */
export async function listModels(target: CheckTarget): Promise<ModelListResult> {
  const catalogue = catalogueModels(target.providerId);
  if (catalogue !== undefined) return { ok: true, models: catalogue };
  const provider = findProvider(target.providerId);
  if (provider === undefined)
    return { ok: false, detail: `Unknown Provider ${target.providerId}.` };
  if (!provider.supportsModelList) return { ok: true, models: [] };
  const response = await get(target, 'models');
  if (!response.ok) return response;
  const models = modelIds(response.body);
  return models === undefined
    ? {
        ok: false,
        detail: 'The Provider answered GET /models with something other than a model list.',
      }
    : { ok: true, models: models.map((id) => ({ id })) };
}

/**
 * Tests a Connection with one small real request:
 *
 * - OpenRouter: `GET {baseUrl}/key`, which needs a valid key (its `/models` answers without one),
 *   then the listing, whose failure does not fail the test.
 * - Every other Provider that lists its models: `GET {baseUrl}/models`, whose list is returned.
 * - Anthropic and Google: a 1-token completion with the catalogue's test model (or `model`).
 * - The rest (Zhipu, MiniMax, Doubao): a 1-token completion with `model`, which the User names.
 */
export async function testConnection(
  target: CheckTarget & { model?: string },
): Promise<ConnectionTestOutcome> {
  const provider = findProvider(target.providerId);
  if (provider === undefined)
    return { ok: false, detail: `Unknown Provider ${target.providerId}.` };
  if (provider.id === 'openrouter') {
    const key = await get(target, 'key');
    if (!key.ok) return key;
    const listed = await listModels(target);
    return listed.ok ? listed : { ok: true };
  }
  if (provider.supportsModelList) return listModels(target);
  const catalogue = catalogueModels(target.providerId);
  const model = target.model ?? catalogue?.find((entry) => entry.test)?.id;
  if (model === undefined) return { ok: false, detail: 'Name a model to test this Provider with.' };
  const completed = await completeOneToken(target, model);
  if (!completed.ok) return completed;
  return catalogue === undefined ? { ok: true } : { ok: true, models: catalogue };
}

type GetResult = { ok: true; body: unknown } | { ok: false; detail: string };

/** `GET {baseUrl}/{path}` with the Gateway's timeouts, the key as a Bearer token when there is one. */
async function get(target: CheckTarget, path: string): Promise<GetResult> {
  const baseUrl = target.baseUrl ?? findProvider(target.providerId)?.baseUrl;
  if (baseUrl === undefined) return { ok: false, detail: 'The Connection has no base URL.' };
  const timeoutMs = target.timeoutMs ?? CHECK_TIMEOUT_MS;
  const upstream = createUpstreamFetch({ firstByteMs: timeoutMs, idleMs: timeoutMs }, target.fetch);
  const url = `${baseUrl.replace(/\/+$/, '')}/${path}`;
  try {
    const response = await upstream.fetch(url, {
      headers: {
        accept: 'application/json',
        ...(target.apiKey === undefined || target.apiKey === ''
          ? {}
          : { authorization: `Bearer ${target.apiKey}` }),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      // The Gateway's own mapper reads the error body, so the text is what a request would show.
      const error = new APICallError({
        message: `HTTP ${String(response.status)}`,
        url,
        requestBodyValues: {},
        statusCode: response.status,
        responseBody: text,
      });
      return {
        ok: false,
        detail: providerError(error, target.apiKey).fields.provider_message as string,
      };
    }
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return {
        ok: false,
        detail: `The Provider answered GET /${path} with something other than JSON.`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      detail: failureText(error, upstream.timedOut, upstream.status, timeoutMs, target.apiKey),
    };
  }
}

/** Sends a 1-token completion to `model`, through the Provider's adapter. */
async function completeOneToken(
  target: CheckTarget,
  model: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const timeoutMs = target.timeoutMs ?? CHECK_TIMEOUT_MS;
  const upstream = createUpstreamFetch({ firstByteMs: timeoutMs, idleMs: timeoutMs }, target.fetch);
  try {
    await generateText({
      model: createLanguageModel({
        providerId: target.providerId,
        model,
        connection: {
          ...(target.apiKey === undefined ? {} : { apiKey: target.apiKey }),
          ...(target.baseUrl === undefined ? {} : { baseUrl: target.baseUrl }),
        },
        fetch: upstream.fetch,
      }),
      prompt: 'Hi',
      maxOutputTokens: 1,
      maxRetries: 0,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: failureText(error, upstream.timedOut, upstream.status, timeoutMs, target.apiKey),
    };
  }
}

/**
 * What a failed call reports: the timeout, else the Provider's own message (as the Gateway maps
 * it), else the error's message, followed by each cause's message it does not already contain
 * (a bare "fetch failed" becomes "fetch failed: connect ECONNREFUSED 127.0.0.1:11434"). The key
 * is redacted throughout.
 */
function failureText(
  error: unknown,
  timedOut: boolean,
  status: number | undefined,
  timeoutMs: number,
  apiKey: string | undefined,
): string {
  if (timedOut) return providerTimeout(timeoutMs, status === undefined).message;
  let text = isProviderFailure(error)
    ? (providerError(error, apiKey).fields.provider_message as string)
    : error instanceof Error
      ? error.message
      : String(error);
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause instanceof Error && depth < 5; depth += 1) {
    if (cause.message !== '' && !text.includes(cause.message)) text = `${text}: ${cause.message}`;
    cause = cause.cause;
  }
  return redact(text === '' ? 'The Provider call failed.' : text, apiKey);
}

function redact(text: string, apiKey: string | undefined): string {
  return apiKey === undefined || apiKey === '' ? text : text.replaceAll(apiKey, '[redacted]');
}

/** The `data[].id` of an OpenAI-shaped model list, else undefined. */
function modelIds(body: unknown): string[] | undefined {
  if (typeof body !== 'object' || body === null || !('data' in body)) return undefined;
  const { data } = body;
  if (!Array.isArray(data)) return undefined;
  const ids = data
    .map((entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'id' in entry ? entry.id : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && id !== '');
  return [...new Set(ids)];
}
