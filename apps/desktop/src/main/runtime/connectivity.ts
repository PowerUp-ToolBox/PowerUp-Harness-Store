import type { Connectivity, ConnectivityState } from '../../shared/ipc.js';

/**
 * The Store's base URL when the `store_base_url` setting is absent: the Supabase local stack
 * (`supabase start`). P0-07 and P0-11 replace it with the public Store URL.
 */
export const DEFAULT_STORE_BASE_URL = 'http://127.0.0.1:54321';

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
  /** Cancels the scheduled re-check; nothing is checked or reported after this. */
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
    inFlight ??= isReachable(fetch, storeBaseUrl).then((reachable) => {
      inFlight = null;
      settle(reachable ? 'online' : 'offline');
      return { state };
    });
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
    },
  };
}

/** One `HEAD` request to the Store base URL; resolves false on any failure, never rejects. */
async function isReachable(fetch: FetchLike, storeBaseUrl: () => string): Promise<boolean> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // The race ends the check on time even if `fetch` ignores the abort signal.
  const timedOut = new Promise<false>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(false);
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
