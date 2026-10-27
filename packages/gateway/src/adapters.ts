/**
 * Provider adapters: a Provider id, a model name and the Connection's secret in, a Vercel AI SDK
 * language model out. Every adapter makes its HTTP calls through the Gateway's own `fetch`
 * ({@link createUpstreamFetch}), which enforces the timeouts.
 *
 * Only the `openai-compatible` adapter exists so far (`openai-compatible` and
 * `openai-compatible:<name>`); the other Provider ids and the preset table arrive with P0-02.6.
 *
 * @see createUpstreamFetch
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ConnectionSecret } from './types.js';

export interface AdapterInput {
  providerId: string;
  /** The model name at the Provider, without the Provider prefix. */
  model: string;
  connection: ConnectionSecret;
  fetch: typeof globalThis.fetch;
}

/**
 * Image URLs the Provider downloads itself. Without this the AI SDK would download every http(s)
 * image in the Gateway process and inline it.
 */
const PROVIDER_FETCHES_IMAGES = { 'image/*': [/^https?:\/\//i] };

/**
 * The language model for one upstream call. Throws (a 500 `internal_error` for the request) for a
 * Provider without an adapter yet, or a Connection that lacks what its Provider needs.
 */
export function createLanguageModel({
  providerId,
  model,
  connection,
  fetch,
}: AdapterInput): Exclude<LanguageModel, string> {
  const adapter = providerId.split(':')[0];
  if (adapter !== 'openai-compatible') {
    throw new Error(`No Provider adapter for ${providerId} yet.`);
  }
  if (connection.baseUrl === undefined || connection.baseUrl === '') {
    throw new Error(`The Connection for ${providerId} has no base URL.`);
  }
  return createOpenAICompatible({
    name: 'openai-compatible',
    baseURL: connection.baseUrl,
    ...(connection.apiKey !== undefined &&
      connection.apiKey !== '' && { apiKey: connection.apiKey }),
    fetch,
    // Always ask for usage; whether it reaches the Harness is the Gateway's decision.
    includeUsage: true,
    // Send `json_schema` response formats as such (best effort, gateway-protocol.md §3).
    supportsStructuredOutputs: true,
    supportedUrls: () => PROVIDER_FETCHES_IMAGES,
  }).chatModel(model);
}
