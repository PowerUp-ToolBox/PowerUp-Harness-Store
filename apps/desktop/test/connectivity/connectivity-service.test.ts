import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_TIMEOUT_MS,
  createConnectivityService,
  DEFAULT_STORE_BASE_URL,
  OFFLINE_RECHECK_DELAYS_MS,
  storeBaseUrlFrom,
  type ConnectivityService,
  type FetchLike,
} from '../../src/main/runtime/connectivity.js';
import type { Connectivity } from '../../src/shared/ipc.js';

const STORE_URL = 'https://store.example.test';
const MINUTE = 60_000;

/** How the fake Store answers the next `HEAD`: a status, a refused connection, or never. */
type Answer = number | 'refused' | 'hang';

let services: ConnectivityService[];
beforeEach(() => {
  vi.useFakeTimers();
  // `sentAt` reads as milliseconds since the test began.
  vi.setSystemTime(0);
  services = [];
});
afterEach(() => {
  for (const service of services) service.stop();
  vi.useRealTimers();
});

/** A connectivity service against a fake Store that answers `answer` until told otherwise. */
function serviceAnswering(initial: Answer, storeBaseUrl = () => STORE_URL) {
  let answer = initial;
  /** When each `HEAD` was sent, in fake-clock milliseconds. */
  const sentAt: number[] = [];
  const fetch = vi.fn<FetchLike>((_url, init) => {
    sentAt.push(Date.now());
    if (answer === 'refused') return Promise.reject(new TypeError('fetch failed'));
    if (answer === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    return Promise.resolve({ status: answer });
  });
  const changes: Connectivity[] = [];
  const service = createConnectivityService({
    fetch,
    storeBaseUrl,
    onChange: (connectivity) => changes.push(connectivity),
  });
  services.push(service);
  return {
    service,
    fetch,
    sentAt,
    changes,
    answer: (next: Answer) => {
      answer = next;
    },
  };
}

describe('a connectivity check', () => {
  it('starts unknown, before any check has ended', () => {
    const { service } = serviceAnswering(200);
    expect(service.get()).toEqual({ state: 'unknown' });
  });

  it('sends HEAD to the Store base URL', async () => {
    const { service, fetch } = serviceAnswering(200);
    await service.check();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(STORE_URL, {
      method: 'HEAD',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it.each([200, 204, 301, 404, 499])(
    'counts HTTP %i as online: the Store answers',
    async (status) => {
      const { service } = serviceAnswering(status);
      await expect(service.check()).resolves.toEqual({ state: 'online' });
      expect(service.get()).toEqual({ state: 'online' });
    },
  );

  it.each([500, 502, 503])('counts HTTP %i as offline: the Store is down', async (status) => {
    const { service } = serviceAnswering(status);
    await expect(service.check()).resolves.toEqual({ state: 'offline' });
  });

  it('counts a refused connection as offline', async () => {
    const { service } = serviceAnswering('refused');
    await expect(service.check()).resolves.toEqual({ state: 'offline' });
  });

  it('counts no answer within 5 s as offline, and aborts the request', async () => {
    const { service, fetch } = serviceAnswering('hang');
    const check = service.check();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 1);
    expect(service.get()).toEqual({ state: 'unknown' });
    await vi.advanceTimersByTimeAsync(1);
    await expect(check).resolves.toEqual({ state: 'offline' });
    expect(fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it('ends on time even when fetch ignores the abort signal', async () => {
    const fetch = vi.fn<FetchLike>(() => new Promise(() => undefined));
    const service = createConnectivityService({ fetch, storeBaseUrl: () => STORE_URL });
    services.push(service);
    const check = service.check();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    await expect(check).resolves.toEqual({ state: 'offline' });
  });

  it('counts a fetch that throws synchronously as offline, without rejecting', async () => {
    const service = createConnectivityService({
      fetch: () => {
        throw new TypeError('Invalid URL');
      },
      storeBaseUrl: () => STORE_URL,
    });
    services.push(service);
    await expect(service.check()).resolves.toEqual({ state: 'offline' });
  });

  it('reads the Store base URL at every check, so a changed setting applies on Retry', async () => {
    let url = 'http://127.0.0.1:9';
    const { service, fetch } = serviceAnswering(200, () => url);
    await service.check();
    url = STORE_URL;
    await service.check();
    expect(fetch.mock.calls.map(([sent]) => sent)).toEqual(['http://127.0.0.1:9', STORE_URL]);
  });

  it('shares one request between checks that overlap (debounce)', async () => {
    const { service, fetch } = serviceAnswering('hang');
    const checks = [service.check(), service.check(), service.check()];
    expect(checks[1]).toBe(checks[0]);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    await Promise.all(checks);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('reports each change of state once, and nothing when the state stays the same', async () => {
    const { service, changes, answer } = serviceAnswering(200);
    await service.check();
    await service.check();
    answer('refused');
    await service.check();
    await service.check();
    answer(204);
    await service.check();
    expect(changes).toEqual([{ state: 'online' }, { state: 'offline' }, { state: 'online' }]);
  });
});

describe('re-checks while offline (backoff)', () => {
  it('re-checks after 15 s, 30 s, 60 s, then every 5 minutes', async () => {
    const { service, sentAt } = serviceAnswering('refused');
    await service.check();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    const gaps = sentAt.slice(1).map((at, index) => at - (sentAt[index] ?? 0));
    expect(gaps.slice(0, 5)).toEqual([15_000, 30_000, 60_000, 300_000, 300_000]);
    expect(new Set(gaps.slice(3))).toEqual(new Set([300_000]));
    expect(OFFLINE_RECHECK_DELAYS_MS).toEqual([15_000, 30_000, 60_000, 300_000]);
  });

  it('never checks more than 4 times in any minute while the machine stays offline', async () => {
    const { service, sentAt } = serviceAnswering('refused');
    await service.check();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    for (const start of sentAt) {
      const inWindow = sentAt.filter((at) => at >= start && at < start + MINUTE);
      expect(inWindow.length).toBeLessThanOrEqual(4);
    }
    // One startup check, three in the first minutes of backoff, then one every 5 minutes.
    expect(sentAt.length).toBeLessThanOrEqual(1 + 3 + 12);
  });

  it('spaces re-checks from the end of the last check, so a timing-out Store is not hammered', async () => {
    const { service, sentAt } = serviceAnswering('hang');
    void service.check();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    const gaps = sentAt.slice(1).map((at, index) => at - (sentAt[index] ?? 0));
    expect(gaps.slice(0, 3)).toEqual([
      CHECK_TIMEOUT_MS + 15_000,
      CHECK_TIMEOUT_MS + 30_000,
      CHECK_TIMEOUT_MS + 60_000,
    ]);
  });

  it('goes online by itself when a scheduled re-check reaches the Store, then stops checking', async () => {
    const { service, sentAt, changes, answer } = serviceAnswering('refused');
    await service.check();
    answer(200);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(service.get()).toEqual({ state: 'online' });
    expect(changes).toEqual([{ state: 'offline' }, { state: 'online' }]);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(sentAt).toHaveLength(2);
  });

  it('starts the backoff over after a spell online', async () => {
    const { service, sentAt, answer } = serviceAnswering('refused');
    await service.check();
    await vi.advanceTimersByTimeAsync(15_000 + 30_000);
    answer(200);
    await service.check();
    answer('refused');
    await service.check();
    const before = sentAt.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sentAt).toHaveLength(before + 1);
  });

  it('a Retry while offline replaces the scheduled re-check instead of adding one', async () => {
    const { service, sentAt } = serviceAnswering('refused');
    await service.check();
    await vi.advanceTimersByTimeAsync(10_000);
    await service.check(); // Retry, 5 s before the scheduled re-check
    await vi.advanceTimersByTimeAsync(10_000);
    // The re-check that was due at 15 s did not run; the next one waits 30 s after the Retry.
    expect(sentAt).toEqual([0, 10_000]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sentAt).toEqual([0, 10_000, 40_000]);
  });
});

describe('Retry after connectivity returns', () => {
  it('succeeds at once, without waiting for the backoff', async () => {
    const { service, answer } = serviceAnswering('refused');
    await service.check();
    await vi.advanceTimersByTimeAsync(15_000 + 30_000 + 60_000);
    expect(service.get()).toEqual({ state: 'offline' });
    answer(200);
    await expect(service.check()).resolves.toEqual({ state: 'online' });
  });
});

describe('no checks while online', () => {
  it('checks only when asked once the Store has answered', async () => {
    const { service, fetch } = serviceAnswering(200);
    await service.check();
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('reportFailure', () => {
  it('checks at once while the Store was thought online', async () => {
    const { service, fetch, answer } = serviceAnswering(200);
    await service.check();
    answer('refused');
    service.reportFailure();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.get()).toEqual({ state: 'offline' });
  });

  it('adds no check while the Store is known to be offline: the backoff runs', async () => {
    const { service, fetch } = serviceAnswering('refused');
    await service.check();
    for (let i = 0; i < 10; i += 1) service.reportFailure();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('joins a check in flight instead of starting another', async () => {
    const { service, fetch } = serviceAnswering('hang');
    void service.check();
    service.reportFailure();
    service.reportFailure();
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('stop', () => {
  it('cancels the scheduled re-check and reports nothing more', async () => {
    const { service, fetch, changes } = serviceAnswering('hang');
    const check = service.check();
    service.stop();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    await check;
    expect(fetch).toHaveBeenCalledOnce();
    expect(changes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts the request in flight and ends its check at once', async () => {
    const { service, fetch } = serviceAnswering('hang');
    const check = service.check();
    await vi.advanceTimersByTimeAsync(0);
    service.stop();
    expect(fetch.mock.calls[0]?.[1].signal.aborted).toBe(true);
    await expect(check).resolves.toEqual({ state: 'unknown' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a check in flight at once even when fetch ignores the abort signal', async () => {
    const fetch = vi.fn<FetchLike>(() => new Promise(() => undefined));
    const service = createConnectivityService({ fetch, storeBaseUrl: () => STORE_URL });
    services.push(service);
    const check = service.check();
    await vi.advanceTimersByTimeAsync(0);
    service.stop();
    await vi.advanceTimersByTimeAsync(0);
    await expect(check).resolves.toEqual({ state: 'unknown' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends no request and reads no setting for a check or reported failure after it', async () => {
    const storeBaseUrl = vi.fn(() => STORE_URL);
    const { service, fetch, changes, answer } = serviceAnswering(200, storeBaseUrl);
    await service.check();
    service.stop();
    answer('refused');
    await expect(service.check()).resolves.toEqual({ state: 'online' });
    service.reportFailure();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fetch).toHaveBeenCalledOnce();
    expect(storeBaseUrl).toHaveBeenCalledOnce();
    expect(changes).toEqual([{ state: 'online' }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('storeBaseUrlFrom', () => {
  it('uses an http or https URL from the store_base_url setting', () => {
    expect(storeBaseUrlFrom('https://store.example.test')).toBe('https://store.example.test');
    expect(storeBaseUrlFrom('http://127.0.0.1:9')).toBe('http://127.0.0.1:9');
  });

  it.each([undefined, null, 42, '', 'not a url', 'file:///etc/passwd', 'ftp://store.test'])(
    'falls back to the Supabase local stack for %j',
    (setting) => {
      expect(storeBaseUrlFrom(setting)).toBe(DEFAULT_STORE_BASE_URL);
    },
  );

  it('defaults to the Supabase local stack', () => {
    expect(DEFAULT_STORE_BASE_URL).toBe('http://127.0.0.1:54321');
  });
});
