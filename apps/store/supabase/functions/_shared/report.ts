/**
 * The request rules of the `report` Edge Function that need no network: the request body, the
 * caller's IP address and the per-IP counter, and the errors the submit_report SQL function
 * raises. Plain TypeScript with relative imports only (see storage-paths.ts).
 */
import { invalidRequest, isStorable, isText } from './http.ts';
import type { ApiError } from './http.ts';
import { MAX_LOOKUP_LENGTH, NOT_FOUND } from './unpublish.ts';

/** The reasons of a Report: the `report_reason` enum of docs/tech/data-model.md. */
export const REPORT_REASONS = [
  'malware',
  'bypasses_gateway',
  'broken',
  'inappropriate',
  'spam',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

/** The longest `details` (`reports.details`). */
export const MAX_DETAILS_LENGTH = 2000;

/** The longest value of a `client_info` field. */
export const MAX_CLIENT_INFO_LENGTH = 64;

/** Reports per hour from one IP address, and from one install (`client_info.install_id`). */
export const REPORTS_PER_HOUR = 5;

/** The `client_info` fields the Store keeps; anything else the client sends is dropped. */
const CLIENT_INFO_FIELDS = ['install_id', 'app_version', 'platform'] as const;

export type ClientInfo = Partial<Record<(typeof CLIENT_INFO_FIELDS)[number], string>>;

/** A valid `report` request body (docs/tech/api.md). */
export interface ReportRequest {
  harness_id: string;
  /** Undefined: the Report is about the Harness, not one version. */
  version?: string;
  reason: ReportReason;
  details: string;
  client_info: ClientInfo;
}

export const REPORT_NOT_FOUND: ApiError = { ...NOT_FOUND, message: 'No such Harness or version.' };

export const RATE_LIMITED: ApiError = {
  status: 429,
  code: 'rate_limited',
  message: `At most ${String(REPORTS_PER_HOUR)} Reports an hour can be sent. Try again later.`,
};

/** What submit_report raises (SQLSTATE `PT<status>`, the code as message). */
export const REPORT_ERRORS: readonly ApiError[] = [REPORT_NOT_FOUND, RATE_LIMITED];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The request, or the 400 that refuses it: `harness_id` a non-empty string; `version` absent,
 * null or a non-empty string; `reason` one of {@link REPORT_REASONS}; `details` absent, null or a
 * string of at most {@link MAX_DETAILS_LENGTH} characters; `client_info` absent, null or an object
 * whose `install_id`, `app_version` and `platform`, each optional, are non-empty strings of at
 * most {@link MAX_CLIENT_INFO_LENGTH} characters (its other fields are dropped). No string may
 * hold a NUL character or a lone UTF-16 surrogate (see isStorable). Other fields are ignored.
 */
export function reportRequest(body: unknown): ReportRequest | ApiError {
  if (!isObject(body)) return invalidRequest('The body must be a JSON object.');
  const { harness_id, version, reason, details, client_info } = body;
  if (!isText(harness_id, MAX_LOOKUP_LENGTH)) {
    return invalidRequest('"harness_id" must be a Harness ID.');
  }
  if (version !== undefined && version !== null && !isText(version, MAX_LOOKUP_LENGTH)) {
    return invalidRequest('"version" must be a version, or left out for the whole Harness.');
  }
  if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) {
    return invalidRequest(`"reason" must be one of ${REPORT_REASONS.join(', ')}.`);
  }
  if (
    details !== undefined &&
    details !== null &&
    (!isStorable(details) || details.length > MAX_DETAILS_LENGTH)
  ) {
    return invalidRequest(
      `"details" must be a string of at most ${String(MAX_DETAILS_LENGTH)} characters, with no NUL character or lone surrogate.`,
    );
  }
  if (client_info !== undefined && client_info !== null && !isObject(client_info)) {
    return invalidRequest('"client_info" must be an object.');
  }
  const info: ClientInfo = {};
  for (const field of CLIENT_INFO_FIELDS) {
    const value = client_info?.[field];
    if (value === undefined || value === null) continue;
    if (!isText(value, MAX_CLIENT_INFO_LENGTH)) {
      return invalidRequest(
        `"client_info.${field}" must be a string of 1 to ${String(MAX_CLIENT_INFO_LENGTH)} characters.`,
      );
    }
    info[field] = value;
  }
  return {
    harness_id,
    ...(typeof version === 'string' ? { version } : {}),
    reason: reason as ReportReason,
    details: typeof details === 'string' ? details : '',
    client_info: info,
  };
}

/**
 * The caller's IP address: the first address of `X-Forwarded-For`, which the gateway extends with
 * what it saw. A client can put anything first, so this is a best-effort key, never stored.
 */
export function clientIp(forwardedFor: string | null): string | undefined {
  const first = forwardedFor?.split(',')[0]?.trim();
  return first === undefined || first === '' ? undefined : first;
}

/**
 * At most `limit` Reports per `windowMs` per key (an IP address), counted in memory. Each worker
 * of the function has its own counter, which is lost when the worker stops: a deterrent, not a
 * guarantee (submit_report's per-install check is the exact one). At most `maxKeys` keys are
 * kept; past that the oldest is forgotten.
 */
export class ReportCounter {
  private readonly sent = new Map<string, number[]>();

  constructor(
    private readonly limit = REPORTS_PER_HOUR,
    private readonly windowMs = 60 * 60 * 1000,
    private readonly maxKeys = 10_000,
  ) {}

  /** Whether `key` may send one more Report at `now` (milliseconds). */
  allows(key: string, now: number): boolean {
    return this.recent(key, now).length < this.limit;
  }

  /** Counts one Report from `key` at `now`. */
  record(key: string, now: number): void {
    const times = this.recent(key, now);
    this.sent.delete(key);
    if (this.sent.size >= this.maxKeys) {
      const oldest = this.sent.keys().next().value;
      if (oldest !== undefined) this.sent.delete(oldest);
    }
    this.sent.set(key, [...times, now]);
  }

  private recent(key: string, now: number): number[] {
    return (this.sent.get(key) ?? []).filter((time) => time > now - this.windowMs);
  }
}
