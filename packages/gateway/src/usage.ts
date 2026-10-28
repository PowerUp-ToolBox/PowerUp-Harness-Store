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

/** The token counts a Provider reported, as both a Usage Record and wire `usage` carry them. */
export interface ReportedTokens {
  /** `null` when the Provider did not report it. */
  readonly promptTokens: number | null;
  /** `null` when the Provider did not report it. */
  readonly completionTokens: number | null;
  /** Present only when the Provider reported some. */
  readonly cachedPromptTokens?: number;
}

/**
 * The fields of the Provider's own usage object (`LanguageModelUsage.raw`) each count is read
 * from: OpenAI-style (`openai`, `openai-compatible`, `openrouter`), Anthropic, then Google.
 */
const RAW_PROMPT_FIELDS = ['prompt_tokens', 'input_tokens', 'promptTokenCount'];
const RAW_COMPLETION_FIELDS = [
  'completion_tokens',
  'output_tokens',
  'candidatesTokenCount',
  'thoughtsTokenCount',
];

/**
 * The counts the Provider actually reported in `usage`. The adapters fill a count missing from a
 * usage object the Provider did send with 0 (`usage: { prompt_tokens: 9 }` comes back with 0
 * output tokens), so when the raw usage object is known a count is kept only if one of its own
 * fields is a number. Cached prompt tokens are kept only when there were some, for the same reason.
 */
export function reportedTokens(usage: LanguageModelUsage | undefined): ReportedTokens {
  if (usage === undefined) return { promptTokens: null, completionTokens: null };
  const raw = usage.raw;
  const reported = (count: number | undefined, fields: readonly string[]): number | null => {
    if (count === undefined) return null;
    if (raw === undefined) return count;
    return fields.some((field) => typeof raw[field] === 'number') ? count : null;
  };
  const cached = usage.inputTokenDetails.cacheReadTokens;
  return {
    promptTokens: reported(usage.inputTokens, RAW_PROMPT_FIELDS),
    completionTokens: reported(usage.outputTokens, RAW_COMPLETION_FIELDS),
    ...(cached !== undefined && cached > 0 && { cachedPromptTokens: cached }),
  };
}

/**
 * The Usage Record of a request that ended at `endMark` (`performance.now()`), with the token
 * counts of `reportedTokens`.
 */
export function usageRecord(
  context: UsageContext,
  status: UsageStatus,
  usage: LanguageModelUsage | undefined,
  endMark: number,
): UsageRecord {
  return {
    timestamp: new Date(context.receivedAt.time).toISOString(),
    harnessId: context.harnessId,
    harnessVersion: context.harnessVersion,
    slot: context.slot,
    provider: context.provider,
    model: context.model,
    ...reportedTokens(usage),
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
