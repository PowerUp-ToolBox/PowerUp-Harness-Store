/**
 * Provider ids (gateway-protocol.md §6) and the explicit `provider/model` ids a Harness may send
 * as `model` instead of a Slot name.
 */

/** Every Provider id of gateway-protocol.md §6, in the order of its table. */
export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ollama',
  'lmstudio',
  'deepseek',
  'qwen',
  'moonshot',
  'zhipu',
  'minimax',
  'doubao',
  'groq',
  'openai-compatible',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** A named `openai-compatible` endpoint: `openai-compatible:<name>`. */
const NAMED_OPENAI_COMPATIBLE = /^openai-compatible:[a-z0-9][a-z0-9-]*$/;

/**
 * Whether `id` names a Provider: one of {@link PROVIDER_IDS}, or `openai-compatible:<name>` with
 * a lower-case slug name.
 */
export function isProviderId(id: string): boolean {
  return (PROVIDER_IDS as readonly string[]).includes(id) || NAMED_OPENAI_COMPATIBLE.test(id);
}

/** What a request's `model` asks for. */
export type ModelRef =
  /** An explicit `provider/model` id. */
  | { kind: 'explicit'; providerId: string; model: string }
  /** A Model Slot name, resolved through the Harness's Slot Bindings. */
  | { kind: 'slot'; slot: string };

/**
 * Reads a request's `model`. A value containing `/` is an explicit id, split at the first `/`:
 * the Provider part must be a Provider id and the model part non-empty without whitespace
 * (`openrouter/anthropic/claude-sonnet-4-5` keeps `anthropic/claude-sonnet-4-5` as the model).
 * Anything else is a Slot name; Slot names never contain `/`, so the two forms cannot overlap.
 * Returns `null` for a malformed explicit id.
 */
export function parseModelRef(model: string): ModelRef | null {
  const slash = model.indexOf('/');
  if (slash === -1) return { kind: 'slot', slot: model };
  const providerId = model.slice(0, slash);
  const name = model.slice(slash + 1);
  if (!isProviderId(providerId) || !/^\S+$/.test(name)) return null;
  return { kind: 'explicit', providerId, model: name };
}
