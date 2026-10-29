/**
 * Provider adapters: a Provider id, a model name and the Connection's secret in, a Vercel AI SDK
 * language model out. Which adapter serves a Provider, and where it sends requests by default,
 * comes from the Provider table ({@link PROVIDERS}); an OpenAI-compatible preset is a row there
 * and nothing here. Every adapter makes its HTTP calls through the Gateway's own `fetch`
 * ({@link createUpstreamFetch}), which enforces the timeouts.
 *
 * @see createUpstreamFetch
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { wrapLanguageModel } from 'ai';
import type { LanguageModel } from 'ai';
import { PROVIDERS, findProvider } from './providers.js';
import type { AdapterKind, ProviderInfo } from './providers.js';
import type { ConnectionSecret } from './types.js';

type Model = Exclude<LanguageModel, string>;

export interface AdapterInput {
  providerId: string;
  /** The model name at the Provider, without the Provider prefix. */
  model: string;
  connection: ConnectionSecret;
  fetch: typeof globalThis.fetch;
  /**
   * The `strict` of the request's `json_schema` response format, `false` when absent (OpenAI's
   * default). The OpenAI-wire SDKs would otherwise always send `strict: true`.
   */
  strictJsonSchema?: boolean;
}

/**
 * What an adapter is built from. The key and base URL are always passed explicitly, so an SDK
 * never falls back to its environment variables (`OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`, ...).
 */
interface AdapterSettings {
  model: string;
  baseUrl: string;
  apiKey: string | undefined;
  fetch: typeof globalThis.fetch;
  strictJsonSchema: boolean;
}

const ADAPTERS: Record<AdapterKind, (settings: AdapterSettings) => Model> = {
  anthropic: ({ model, baseUrl, apiKey, fetch }) =>
    createAnthropic({ baseURL: baseUrl, ...(apiKey !== undefined && { apiKey }), fetch })(model),
  // Chat Completions, not the Responses API, so OpenAI speaks the same wire format as the rest.
  openai: ({ model, baseUrl, apiKey, fetch }) =>
    createOpenAI({ baseURL: baseUrl, ...(apiKey !== undefined && { apiKey }), fetch }).chat(model),
  google: ({ model, baseUrl, apiKey, fetch }) =>
    createGoogleGenerativeAI({ baseURL: baseUrl, ...(apiKey !== undefined && { apiKey }), fetch })(
      model,
    ),
  // The model name is OpenRouter's own (`anthropic/claude-sonnet-5-5`), passed through as is.
  // `compatibility: 'strict'` asks for usage on streams (`stream_options.include_usage`).
  openrouter: ({ model, baseUrl, apiKey, fetch, strictJsonSchema }) =>
    createOpenRouter({
      baseURL: baseUrl,
      ...(apiKey !== undefined && { apiKey }),
      fetch,
      compatibility: 'strict',
    }).chat(model, { structuredOutputs: { strict: strictJsonSchema } }),
  'openai-compatible': ({ model, baseUrl, apiKey, fetch }) =>
    createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: baseUrl,
      ...(apiKey !== undefined && { apiKey }),
      fetch,
      // Always ask for usage; whether it reaches the Harness is the Gateway's decision.
      includeUsage: true,
      // Send `json_schema` response formats as such (best effort, gateway-protocol.md §3).
      supportsStructuredOutputs: true,
    }).chatModel(model),
};

/**
 * Image URLs the Provider downloads itself, whatever its SDK would otherwise do: without this the
 * AI SDK downloads every http(s) image an adapter does not claim in the Gateway process and
 * inlines it. A Provider that cannot fetch the URL answers a `provider_error`.
 */
const PROVIDER_FETCHES_IMAGES = /^https?:\/\//i;

async function withProviderFetchedImages(model: Model): Promise<Record<string, RegExp[]>> {
  const own = await model.supportedUrls;
  return { ...own, 'image/*': [...(own['image/*'] ?? []), PROVIDER_FETCHES_IMAGES] };
}

const nonEmpty = (value: string | undefined) => (value === '' ? undefined : value);

/**
 * The language model for one upstream call. The Connection's base URL, when it has one, overrides
 * the Provider's default. Throws (a 500 `internal_error` for the request) for a Provider id no row
 * of `providers` serves, or a Connection that lacks what its Provider needs (a base URL for
 * `openai-compatible`, a key where `requiresKey`). `providers` is the Provider table; tests pass
 * their own.
 */
export function createLanguageModel(
  { providerId, model, connection, fetch, strictJsonSchema = false }: AdapterInput,
  providers: readonly ProviderInfo[] = PROVIDERS,
): Model {
  const provider = findProvider(providerId, providers);
  if (provider === undefined) throw new Error(`No Provider adapter for ${providerId}.`);
  const baseUrl = nonEmpty(connection.baseUrl) ?? provider.baseUrl;
  if (baseUrl === undefined) throw new Error(`The Connection for ${providerId} has no base URL.`);
  const apiKey = nonEmpty(connection.apiKey);
  if (provider.requiresKey && apiKey === undefined) {
    throw new Error(`The Connection for ${providerId} has no API key.`);
  }
  return wrapLanguageModel({
    model: ADAPTERS[provider.adapter]({ model, baseUrl, apiKey, fetch, strictJsonSchema }),
    middleware: {
      overrideSupportedUrls: ({ model }) => withProviderFetchedImages(model),
      // The call-time setting of the `openai` and `openai-compatible` adapters; others ignore it.
      transformParams: ({ params }) =>
        Promise.resolve({
          ...params,
          providerOptions: {
            ...params.providerOptions,
            openai: { ...params.providerOptions?.openai, strictJsonSchema },
            openaiCompatible: { ...params.providerOptions?.openaiCompatible, strictJsonSchema },
          },
        }),
    },
  });
}
