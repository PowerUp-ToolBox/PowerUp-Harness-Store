import { randomUUID } from 'node:crypto';
import type { IpcResult, ReportInfo, ReportRequest } from '../../shared/ipc.js';
import {
  REPORT_WINDOW_MS,
  REPORTS_PER_HARNESS,
  isContactEmail,
  isReportReason,
  REPORT_DETAILS_MAX_LENGTH,
  reportDetails,
} from '../../shared/report.js';
import { isHarnessIdInput } from './bindings.js';
import { fail, ok } from './ipc-result.js';
import type { SettingsStore } from './settings-store.js';
import type { StoreFetch } from './store-auth.js';

/** A Report gives up after this long. */
const REPORT_TIMEOUT_MS = 15_000;

/** What `install_id` holds: a UUID, as {@link randomUUID} makes it. */
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StoreReporterOptions {
  /** Makes the Store call (Electron's `net.fetch`). */
  readonly fetch: StoreFetch;
  /** The Store base URL, read on every request (the `store_base_url` setting). */
  readonly storeBaseUrl: () => string;
  /** The Store's anon key: a Report is anonymous, whoever is signed in. */
  readonly anonKey: string;
  /** Where `install_id` and `report_history` are kept (the SQLite `settings` table). */
  readonly settings: SettingsStore;
  /** This machine's platform, `<process.platform>-<process.arch>`, whatever a Manifest names. */
  readonly platform: string;
  /** The desktop app's version. */
  readonly appVersion: string;
  /** Told when the Store did not answer at all, so connectivity is checked again. */
  readonly onStoreUnreachable?: () => void;
  /** The clock of the rate limit. Default: the system clock. */
  readonly now?: () => Date;
  /** Makes the install ID the first time one is needed. Default: {@link randomUUID}. */
  readonly newInstallId?: () => string;
  /** How long the call, its answer included, may take. Default: 15 seconds. */
  readonly timeoutMs?: number;
}

/** Reports a Harness to the Store (`store.reportInfo`, `store.report`). */
export interface StoreReporter {
  /** What a Report of this Harness sends besides what the User types, and whether it may. */
  info(harnessId: string): ReportInfo;
  /** Sends a Report that {@link parseReportRequest} accepted. */
  report(request: ReportRequest): Promise<IpcResult<null>>;
}

/** Harness ID → when this install's Reports of it that the Store took were sent (ISO-8601). */
type ReportHistory = Record<string, string[]>;

/**
 * Sends Reports to the Store's `report` function (docs/tech/api.md) with the anon key, as the
 * catalogue reads do, so a Report is anonymous whoever is signed in. The request carries the
 * User's reason, version and details and a `client_info` main builds itself: the install ID, the
 * platform and the app version, never a path, a machine identifier or anything else.
 *
 * The install ID is a random UUID made the first time a Report needs it and kept in the
 * `install_id` setting; the Store uses it only for its per-install rate limit. The client-side
 * limit (at most {@link REPORTS_PER_HARNESS} Reports of one Harness in 24 hours) is kept in the
 * `report_history` setting, which counts only the Reports the Store took and drops entries older
 * than 24 hours on every write; Reports still being sent count too, so a double click cannot slip
 * a fourth one through.
 */
export function createStoreReporter(options: StoreReporterOptions): StoreReporter {
  const now = options.now ?? (() => new Date());
  const newInstallId = options.newInstallId ?? randomUUID;
  const timeoutMs = options.timeoutMs ?? REPORT_TIMEOUT_MS;
  /** Harness ID → Reports of it being sent now. */
  const pending = new Map<string, number>();

  const installId = (): string => {
    const stored = options.settings.read('install_id');
    if (typeof stored === 'string' && INSTALL_ID.test(stored)) return stored;
    const created = newInstallId();
    options.settings.write('install_id', created);
    return created;
  };

  /** The stored history without the entries older than 24 hours (or in the future, or garbled). */
  const recentHistory = (): ReportHistory => {
    const stored = options.settings.read('report_history');
    const at = now().getTime();
    const recent: ReportHistory = {};
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return recent;
    for (const [harnessId, times] of Object.entries(stored as Record<string, unknown>)) {
      if (!Array.isArray(times)) continue;
      const kept = times.filter((time): time is string => {
        if (typeof time !== 'string') return false;
        const age = at - Date.parse(time);
        return age >= 0 && age < REPORT_WINDOW_MS;
      });
      if (kept.length > 0) recent[harnessId] = kept;
    }
    return recent;
  };

  const sent = (harnessId: string): number =>
    (recentHistory()[harnessId]?.length ?? 0) + (pending.get(harnessId) ?? 0);

  const record = (harnessId: string) => {
    const history = recentHistory();
    history[harnessId] = [...(history[harnessId] ?? []), now().toISOString()];
    options.settings.write('report_history', history);
  };

  const send = async (request: ReportRequest): Promise<IpcResult<null>> => {
    const details = reportDetails(request.details, request.contactEmail);
    const body = {
      harness_id: request.harnessId,
      ...(request.version === null ? {} : { version: request.version }),
      reason: request.reason,
      ...(details === '' ? {} : { details }),
      client_info: {
        install_id: installId(),
        app_version: options.appVersion,
        platform: options.platform,
      },
    };
    const base = options.storeBaseUrl().replace(/\/+$/, '');
    let response: Response;
    try {
      response = await options.fetch(`${base}/functions/v1/report`, {
        method: 'POST',
        headers: {
          apikey: options.anonKey,
          authorization: `Bearer ${options.anonKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Read whole within the timeout, so a stalled answer is no answer.
      await response.text();
    } catch {
      options.onStoreUnreachable?.();
      return fail('store_unreachable');
    }
    switch (response.status) {
      case 201:
        record(request.harnessId);
        return ok(null);
      case 400:
        return fail('invalid_input', { method: 'store.report' });
      case 404:
        return fail('not_found');
      case 429:
        return fail('rate_limited');
      default:
        return fail('store_error');
    }
  };

  return {
    info(harnessId) {
      return {
        installId: installId(),
        platform: options.platform,
        appVersion: options.appVersion,
        rateLimited: sent(harnessId) >= REPORTS_PER_HARNESS,
      };
    },
    async report(request) {
      const { harnessId } = request;
      if (sent(harnessId) >= REPORTS_PER_HARNESS) return fail('rate_limited');
      pending.set(harnessId, (pending.get(harnessId) ?? 0) + 1);
      try {
        return await send(request);
      } finally {
        const left = (pending.get(harnessId) ?? 1) - 1;
        if (left > 0) pending.set(harnessId, left);
        else pending.delete(harnessId);
      }
    },
  };
}

/**
 * `{ harnessId, version, reason, details, contactEmail }`, nothing else: a `<publisher>/<slug>`
 * ID, a version or null, one of the `report_reason` values, details and a contact email that is
 * empty or like `x@y`, which together (as `details` sends them) are at most 2000 characters.
 */
export function parseReportRequest(input: unknown): ReportRequest | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const { harnessId, version, reason, details, contactEmail, ...rest } = input as Record<
    string,
    unknown
  >;
  if (Object.keys(rest).length > 0) return null;
  if (!isHarnessIdInput(harnessId) || !harnessId.includes('/')) return null;
  if (version !== null && (typeof version !== 'string' || version === '' || version.length > 256)) {
    return null;
  }
  if (!isReportReason(reason) || typeof details !== 'string') return null;
  if (typeof contactEmail !== 'string' || !isContactEmail(contactEmail)) return null;
  if (reportDetails(details, contactEmail).length > REPORT_DETAILS_MAX_LENGTH) return null;
  return { harnessId, version, reason, details, contactEmail };
}
