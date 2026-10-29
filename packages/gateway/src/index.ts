/**
 * @harness-store/gateway: the Model Gateway, the only path from a running Harness to any model.
 * A loopback HTTP server speaking OpenAI Chat Completions, authenticated by per-launch Gateway
 * Tokens. Normative wire behaviour: docs/tech/gateway-protocol.md.
 *
 * The fake Provider for tests is a separate entry point:
 * `@harness-store/gateway/testing/fake-provider`.
 */
export { createGateway } from './gateway.js';
export type { Gateway, GatewayEvents, ListenResult } from './gateway.js';
export type { Binding, ConnectionSecret, GatewayOptions, UsageRecord } from './types.js';
export { createInMemoryTokenVerifier } from './tokens.js';
export type { GatewayTokenClaims, TokenVerifier } from './tokens.js';
export type { Logger } from './logging.js';
export type { HarnessContext } from './app.js';
export type { ModelList, SlotModel, SlotUnboundEvent } from './slots.js';
export { GATEWAY_ERROR_STATUS } from './errors.js';
export type { GatewayErrorBody, GatewayErrorCode, GatewayErrorType } from './errors.js';
export { MAX_BODY_BYTES } from './body.js';
export { PROVIDERS, PROVIDER_IDS, findProvider, isModelName, isProviderId } from './providers.js';
export type { AdapterKind, ProviderId, ProviderInfo } from './providers.js';
export {
  MODEL_CATALOGUE,
  catalogueModels,
  catalogueTestModel,
  needsTestModel,
} from './catalogue.js';
export type { CatalogueModel, CatalogueProviderId, ModelInfo } from './catalogue.js';
export { CHECK_TIMEOUT_MS, listModels, testConnection } from './connection-check.js';
export type {
  CheckFailure,
  CheckTarget,
  ConnectionTestOutcome,
  ModelListResult,
} from './connection-check.js';
export type { ChatCompletion } from './openai/translate.js';
export type { ChatCompletionChunk } from './openai/stream.js';
