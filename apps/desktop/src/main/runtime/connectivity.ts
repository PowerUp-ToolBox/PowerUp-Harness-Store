import type { Connectivity, ConnectivityState } from '../../shared/ipc.js';

/**
 * The Store's base URL when the `store_base_url` setting is absent: the Supabase local stack
 * (`supabase start`). P0-07 and P0-11 replace it with the public Store URL.
 */
export const DEFAULT_STORE_BASE_URL = 'http://127.0.0.1:54321';

/**
 * The anon key of the Supabase local stack: the same on every machine, and public by design (it
 * only identifies the project; RLS decides what it may do). A build for another Store sets
 * `HARNESS_STORE_ANON_KEY`, which electron.vite.config.ts writes into the main bundle.
 */
export const LOCAL_STORE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/** The Store's anon key: the build's `HARNESS_STORE_ANON_KEY`, else {@link LOCAL_STORE_ANON_KEY}. */
export function storeAnonKey(): string {
  const configured = process.env.HARNESS_STORE_ANON_KEY;
  return configured === undefined || configured === '' ? LOCAL_STORE_ANON_KEY : configured;
}

/** A check that has no answer after this long counts as offline. */
export const CHECK_TIMEOUT_MS = 5_000;

/**
 * While offline, the next automatic check waits this long after the last one ended: 15 s, 30 s,
 * 60 s, then every 5 minutes. So a machine that stays offline gets at most 4 checks a minute, and
 * after the first few minutes one every 5. While online there are no automatic checks.
 */
export const OFFLINE_RECHECK_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000, 300_000];

/**
 * The part of `fetch` a check needs. The app passes Electron's `net.fetch`, so the OS proxy
 * settings apply; tests pass a fake.
 */
export type FetchLike = (
  url: string,
  init: { readonly method: 'HEAD'; readonly signal: AbortSignal },
) => Promise<{ readonly status: number }>;

export interface ConnectivityOptions {
  readonly fetch: FetchLike;
  /** The Store base URL, read at every check so a changed setting applies on the next one. */
  readonly storeBaseUrl: () => string;
  /** Called on every change of state (never twice in a row with the same state). */
  readonly onChange?: (connectivity: Connectivity) => void;
}

/** Whether the Store answers, as the Runtime last saw it. */
export interface ConnectivityService {
  get(): Connectivity;
  /** Checks now; joins the check in flight if there is one. Never rejects. */
  check(): Promise<Connectivity>;
  /**
   * For the Store client (P0-09): a Store request failed at the network level. Checks now unless
   * the Store is already known to be offline, when the scheduled re-check is left to run.
   */
  reportFailure(): void;
  /**
   * Cancels the scheduled re-check and aborts the check in flight; nothing is checked or reported
   * after this, and later calls to `check` resolve with the last state without a request.
   */
  stop(): void;
}

/**
 * Tracks whether the Store is reachable with `HEAD <storeBaseUrl>`: any answer below 500 means
 * online (the Store answers, even if not at that path); a network error, a timeout or a 5xx means
 * offline. It checks only when asked (startup, Retry, a reported failure) and, while offline, on
 * the backoff schedule of {@link OFFLINE_RECHECK_DELAYS_MS}.
 */
export function createConnectivityService(options: ConnectivityOptions): ConnectivityService {
  const { fetch, storeBaseUrl, onChange } = options;
  let state: ConnectivityState = 'unknown';
  let inFlight: Promise<Connectivity> | null = null;
  /** Aborts the request of the check in flight, if there is one. */
  let abortInFlight: AbortController | null = null;
  let recheck: ReturnType<typeof setTimeout> | null = null;
  /** Offline results in a row; picks the delay of the next automatic check. */
  let offlineResults = 0;
  let stopped = false;

  const cancelRecheck = () => {
    if (recheck !== null) clearTimeout(recheck);
    recheck = null;
  };

  const settle = (next: Exclude<ConnectivityState, 'unknown'>) => {
    if (stopped) return;
    cancelRecheck();
    if (next === 'online') {
      offlineResults = 0;
    } else {
      const delays = OFFLINE_RECHECK_DELAYS_MS;
      const delay = delays[Math.min(offlineResults, delays.length - 1)];
      offlineResults += 1;
      recheck = setTimeout(() => {
        recheck = null;
        void check();
      }, delay);
    }
    if (next !== state) {
      state = next;
      onChange?.({ state });
    }
  };

  const check = (): Promise<Connectivity> => {
    if (stopped) return Promise.resolve({ state });
    if (inFlight === null) {
      const controller = new AbortController();
      abortInFlight = controller;
      inFlight = isReachable(fetch, storeBaseUrl, controller).then((reachable) => {
        inFlight = null;
        abortInFlight = null;
        settle(reachable ? 'online' : 'offline');
        return { state };
      });
    }
    return inFlight;
  };

  return {
    get: () => ({ state }),
    check,
    reportFailure() {
      if (state !== 'offline') void check();
    },
    stop() {
      stopped = true;
      cancelRecheck();
      abortInFlight?.abort();
    },
  };
}

/**
 * One `HEAD` request to the Store base URL; resolves false on any failure, on the timeout or once
 * `controller` aborts, and never rejects.
 */
async function isReachable(
  fetch: FetchLike,
  storeBaseUrl: () => string,
  controller: AbortController,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // The race ends the check on time, or at once on abort, even if `fetch` ignores the signal.
  const timedOut = new Promise<false>((resolve) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        resolve(false);
      },
      { once: true },
    );
    timeout = setTimeout(() => {
      controller.abort();
    }, CHECK_TIMEOUT_MS);
  });
  const answered = Promise.resolve()
    .then(() => fetch(storeBaseUrl(), { method: 'HEAD', signal: controller.signal }))
    .then(
      (response) => response.status < 500,
      () => false,
    );
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timeout);
  }
}

/** The Store base URL a `store_base_url` setting holds: an http(s) URL, else the default. */
export function storeBaseUrlFrom(setting: unknown): string {
  if (typeof setting !== 'string') return DEFAULT_STORE_BASE_URL;
  try {
    const { protocol } = new URL(setting);
    return protocol === 'http:' || protocol === 'https:' ? setting : DEFAULT_STORE_BASE_URL;
  } catch {
    return DEFAULT_STORE_BASE_URL;
  }
}
