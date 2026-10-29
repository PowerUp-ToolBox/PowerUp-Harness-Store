import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startRuntime,
  type Runtime,
  type RuntimeOptions,
} from '../../src/main/runtime/bootstrap.js';
import { DEFAULT_STORE_BASE_URL, type FetchLike } from '../../src/main/runtime/connectivity.js';
import { openDatabase } from '../../src/main/runtime/database.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createSqliteSettingsStore } from '../../src/main/runtime/settings-store.js';
import { createFakeCipher } from '../support/fake-cipher.js';
import { offlineProviderFetch } from '../support/provider-fetch.js';

const MAIN_WINDOW = {};

let dataDir: string;
let started: Runtime[];
beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-connectivity-')), 'userData');
  started = [];
});
afterEach(async () => {
  await Promise.all(started.map((runtime) => runtime.shutdown()));
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

const refused = () => vi.fn<FetchLike>(() => Promise.reject(new TypeError('fetch failed')));

async function launch(options: Partial<RuntimeOptions> & Pick<RuntimeOptions, 'fetch'>) {
  const runtime = await startRuntime({
    dataDir,
    version: '1.2.3',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    secretCipher: createFakeCipher(),
    providerFetch: offlineProviderFetch,
    ...options,
  });
  started.push(runtime);
  return runtime;
}

function call(runtime: Runtime, method: string) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method });
}

/** Stores `store_base_url` in the profile's database, as P0-11's Settings screen will. */
function setStoreBaseUrl(url: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, 'harness-store.sqlite'));
  try {
    createSqliteSettingsStore(db).write('store_base_url', url);
  } finally {
    db.close();
  }
}

describe('the Runtime and the Store connectivity', () => {
  it('checks the default Store base URL at startup and pushes the result to the window', async () => {
    const fetch = refused();
    const emit = vi.fn();
    const runtime = await launch({ fetch, emit });
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledWith('connectivity.changed', { state: 'offline' });
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(DEFAULT_STORE_BASE_URL, expect.anything());
    await expect(call(runtime, 'connectivity.get')).resolves.toEqual({
      ok: true,
      data: { state: 'offline' },
    });
  });

  it('uses the store_base_url setting, and Retry succeeds once the Store answers', async () => {
    setStoreBaseUrl('http://127.0.0.1:9');
    let reachable = false;
    const fetch = vi.fn<FetchLike>(() =>
      reachable
        ? Promise.resolve({ status: 200 })
        : Promise.reject(new TypeError('connect ECONNREFUSED')),
    );
    const runtime = await launch({ fetch });
    await vi.waitFor(() => {
      expect(runtime.services.connectivity.get()).toEqual({ state: 'offline' });
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9');

    reachable = true;
    await expect(call(runtime, 'connectivity.check')).resolves.toEqual({
      ok: true,
      data: { state: 'online' },
    });
  });

  it('does not check the Store when the Runtime failed to start', async () => {
    // A folder where the SQLite file should be.
    mkdirSync(join(dataDir, 'harness-store.sqlite'), { recursive: true });
    const fetch = refused();
    const runtime = await launch({ fetch });
    expect(runtime.status).toMatchObject({ state: 'failed', stage: 'database' });
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.services.connectivity.get()).toEqual({ state: 'unknown' });
  });

  it('stops checking on shutdown: a check still in flight then reports nothing', async () => {
    let refuse: (error: Error) => void = () => undefined;
    const fetch = vi.fn<FetchLike>(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const emit = vi.fn();
    const runtime = await launch({ fetch, emit });
    const startupCheck = runtime.services.connectivity.check();
    await runtime.shutdown();
    refuse(new TypeError('fetch failed'));
    await startupCheck;
    expect(fetch).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });
});
