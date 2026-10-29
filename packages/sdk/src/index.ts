/**
 * @harness-store/sdk: the SDK for Node Harnesses. A Harness never holds model credentials; the
 * Runtime launches it with the Model Gateway's address and a Gateway Token in its environment
 * (docs/tech/architecture.md §4). This package turns that environment into a few typed helpers
 * and talks to the Gateway over HTTP only, like any third-party Harness: it has no dependency on
 * Electron or on `@harness-store/gateway`.
 *
 * Deliberately small: no agent loop, no prompt helpers (ADR-0001, ADR-0004).
 */
export { getContext, LOCALES, NotInHarnessStoreError } from './context.js';
export type { HarnessContext, Locale } from './context.js';
export { createOpenAIClient, gatewayFetch, getGatewayContext, listSlots } from './gateway.js';
export type {
  GatewayContext,
  ModelRequirements,
  OpenAIClientOptions,
  SlotInfo,
} from './gateway.js';
export { GatewayError, isSlotUnbound, SlotUnboundError } from './errors.js';
export { createServer } from './server.js';

/**
 * Common Model Slot names. Convenience only: any Slot name the Manifest declares is valid as
 * `model`.
 */
export const Slots = { default: 'default', fast: 'fast', smart: 'smart' } as const;
