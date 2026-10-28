/**
 * Usage Records (gateway-protocol.md §7): exactly one for every request the Gateway attempted an
 * upstream call for, whatever its outcome, and none for a request that never got that far
 * (`invalid_token`, `invalid_request`, `unknown_slot`, `slot_unbound`, `provider_not_connected`).
 * Token counts are the Provider's own, `null` when it reported none; nothing is ever estimated.
 */
import type { LanguageModelUsage } from 'ai';
import type { UsageRecord } from './types.js';

export type UsageStatus = UsageRecord['status'];

/** When a request arrived, taken once by the first middleware. */
export interface ReceivedAt {
  /** Wall clock, epoch ms: the record's `timestamp`. */
  readonly time: number;
  /** Monotonic clock (`performance.now()`): the start of the record's `durationMs`. */
  readonly mark: number;
}

export function receivedNow(): ReceivedAt {
  return { time: Date.now(), mark: performance.now() };
}

/** What a Usage Record says about the request itself, known once its model resolved. */
export interface UsageContext {
  readonly receivedAt: ReceivedAt;
  readonly harnessId: string;
  readonly harnessVersion: string;
  /** The Model Slot asked for; `null` for an explicit `provider/model` id. */
  readonly slot: string | null;
  /** The full Provider id. */
  readonly provider: string;
  /** The model name without the Provider prefix. */
  readonly model: string;
}

/**
 * The Usage Record of a request that ended at `endMark` (`performance.now()`). Each token count
 * is the Provider's or `null`; cached prompt tokens appear only when there were some, as on the
 * wire (the `openai-compatible` adapter reports 0 when the Provider said nothing).
 */
export function usageRecord(
  context: UsageContext,
  status: UsageStatus,
  usage: LanguageModelUsage | undefined,
  endMark: number,
): UsageRecord {
  const cached = usage?.inputTokenDetails.cacheReadTokens;
  return {
    timestamp: new Date(context.receivedAt.time).toISOString(),
    harnessId: context.harnessId,
    harnessVersion: context.harnessVersion,
    slot: context.slot,
    provider: context.provider,
    model: context.model,
    promptTokens: usage?.inputTokens ?? null,
    completionTokens: usage?.outputTokens ?? null,
    ...(cached !== undefined && cached > 0 && { cachedPromptTokens: cached }),
    durationMs: Math.max(1, Math.round(endMark - context.receivedAt.mark)),
    status,
  };
}

/**
 * Meters one upstream call: keeps the usage the Provider reported and, when the request ends,
 * hands its Usage Record to `deliver`, at most once, and only if the call was attempted.
 */
export class UsageMeter {
  readonly #context: UsageContext;
  /** Whether the adapter has called the Provider; read when the request ends. */
  readonly #attempted: () => boolean;
  readonly #deliver: (record: UsageRecord) => void;
  #usage: LanguageModelUsage | undefined;
  #finished = false;

  constructor(
    context: UsageContext,
    attempted: () => boolean,
    deliver: (record: UsageRecord) => void,
  ) {
    this.#context = context;
    this.#attempted = attempted;
    this.#deliver = deliver;
  }

  /** The token counts the Provider reported for the call. */
  report(usage: LanguageModelUsage): void {
    this.#usage = usage;
  }

  /** Ends the request with `status`; every later call does nothing. */
  finish(status: UsageStatus): void {
    if (this.#finished) return;
    this.#finished = true;
    if (!this.#attempted()) return;
    this.#deliver(usageRecord(this.#context, status, this.#usage, performance.now()));
  }
}
