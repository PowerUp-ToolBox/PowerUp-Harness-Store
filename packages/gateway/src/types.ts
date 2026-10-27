/**
 * The shapes the Model Gateway exchanges with its host (the Runtime in the desktop app, a test, or
 * later the cloud Gateway). All User data reaches the Gateway through the callbacks in
 * {@link GatewayOptions}; the Gateway itself keeps nothing but its Gateway Tokens.
 */
import type { Manifest } from '@harness-store/manifest';
import type { Logger } from './logging.js';
import type { TokenVerifier } from './tokens.js';

/** The Slot Binding a Model Slot resolved to, and which rule of the normative order chose it. */
export interface Binding {
  /** Provider id (gateway-protocol.md §6), e.g. `anthropic` or `openai-compatible:vllm`. */
  providerId: string;
  /** The model name at that Provider, without the Provider prefix. */
  model: string;
  source: 'override' | 'recommended' | 'default_same_name' | 'default';
}

/** A Connection's credentials, decrypted just in time for one upstream call. */
export interface ConnectionSecret {
  /** The API key; absent for Providers that need none (Ollama, LM Studio). */
  apiKey?: string;
  /** Overrides the Provider's default base URL; required for `openai-compatible:<name>`. */
  baseUrl?: string;
}

/** One request the Gateway forwarded to a Provider (gateway-protocol.md §7). */
export interface UsageRecord {
  /** When the request arrived, ISO-8601 UTC. */
  timestamp: string;
  harnessId: string;
  harnessVersion: string;
  /** The Model Slot asked for; `null` for an explicit `provider/model` id. */
  slot: string | null;
  /** The full Provider id, e.g. `openai-compatible:fake`. */
  provider: string;
  /** The model name without the Provider prefix. */
  model: string;
  /** As reported by the Provider; `null` when it reported none, never estimated. */
  promptTokens: number | null;
  completionTokens: number | null;
  /** Present only when the Provider reported it. */
  cachedPromptTokens?: number;
  /** From request receipt to the end of the response, whole milliseconds, at least 1. */
  durationMs: number;
  status: 'ok' | 'provider_error' | 'timeout' | 'aborted';
}

export interface GatewayOptions {
  /**
   * The Slot Binding for (Harness, Slot), following the normative order of gateway-protocol.md
   * §4; `null` when nothing is bound.
   */
  resolveBinding(ctx: { harnessId: string; slot: string }): Promise<Binding | null>;
  /** The Connection for a Provider id, decrypted just in time; `null` when there is none. */
  getConnection(providerId: string): Promise<ConnectionSecret | null>;
  /**
   * The installed Manifest of a Harness; `null` means a Harness with no Model Slots. Called on
   * every request that needs it, never cached.
   */
  getManifest(harnessId: string): Promise<Manifest | null>;
  /** Receives every Usage Record after its response ended. A rejection is logged and ignored. */
  onUsage(record: UsageRecord): Promise<void>;
  /** Default: in-memory per-launch tokens (`createInMemoryTokenVerifier()`). */
  tokenVerifier?: TokenVerifier;
  /** Default: debug logs dropped, errors to `console.error`. */
  logger?: Logger;
  /**
   * How long a Provider may take to send its response headers before the request fails with 504
   * `provider_timeout`, in milliseconds. Default 120 000.
   */
  firstByteTimeoutMs?: number;
  /**
   * The longest gap allowed between two chunks of a Provider's response body, streamed or not,
   * before the request fails with `provider_timeout`, in milliseconds. Default 120 000.
   */
  streamIdleTimeoutMs?: number;
}
