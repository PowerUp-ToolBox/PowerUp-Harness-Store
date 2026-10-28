/**
 * Ticket P0-11.2 over IPC: the Settings page's main side on the real Runtime bootstrap (SQLite in
 * a temporary userData, the real Model Gateway), with the Store faked at the HTTP seam. Every
 * setting persists across a restart (How to verify, step 1); Never makes no `latest_versions` call
 * over 30 simulated hours, the startup check included (step 2), while Check now still checks;
 * another interval reschedules the next check; a new Store URL signs the Publisher out of the old
 * Store before it is written, drops the Store home cache and is what the next Store read uses;
 * the folders open at the right paths; the diagnostics read the Model Gateway's status live (step
 * 4) and Copy diagnostics puts every listed field on the clipboard, and nothing secret.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, type Gateway } from '@harness-store/gateway';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startRuntime,
  type Runtime,
  type RuntimeOptions,
} from '../../src/main/runtime/bootstrap.js';
import { DEFAULT_STORE_BASE_URL } from '../../src/main/runtime/connectivity.js';
import { openDatabase } from '../../src/main/runtime/database.js';
import { probeGateway } from '../../src/main/runtime/diagnostics.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createInstallStore } from '../../src/main/runtime/install-store.js';
import { createSqliteSettingsStore } from '../../src/main/runtime/settings-store.js';
import type { StoreFetch } from '../../src/main/runtime/store-auth.js';
import { FIRST_UPDATE_CHECK_DELAY_MS } from '../../src/main/runtime/update-check.js';
import { createFakeCipher } from '../support/fake-cipher.js';
import {
  createFakeStoreAuth,
  FAKE_ANON_KEY,
  FAKE_STORE_URL,
  type FakeStoreAuth,
} from '../support/fake-store-auth.js';
import { manifestWith } from '../support/manifest.js';
import { offlineProviderFetch } from '../support/provider-fetch.js';
import { REFUSED_PORT } from '../support/refused-port.js';

const MAIN_WINDOW = {};
const HOUR = 60 * 60 * 1000;
const STAGING_URL = 'https://staging.store.test';
const HARNESS_ID = 'acme/hello';

let dataDir: string;
let started: Runtime[];
let auth: FakeStoreAuth;
/** `METHOD url` of every Store request, in order. */
let storeRequests: string[];
/** The Harness IDs of each `latest_versions` call. */
let latestCalls: string[][];
/** The URLs the connectivity check asked. */
let connectivityChecks: string[];
let opened: string[];
let clipboard: string[];

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-settings-')), 'userData');
  started = [];
  auth = createFakeStoreAuth();
  storeRequests = [];
  latestCalls = [];
  connectivityChecks = [];
  opened = [];
  clipboard = [];
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(started.map((runtime) => runtime.shutdown()));
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

/**
 * The Store at the HTTP seam, on any base URL: `latest_versions` (every Harness `not_found`) and
 * the Store home's reads (no Harnesses) everywhere; Auth and `profiles` on the fake Store only.
 */
const storeFetch: StoreFetch = async (url, init) => {
  storeRequests.push(`${init.method ?? 'GET'} ${url}`);
  const target = new URL(url);
  if (target.pathname === '/rest/v1/rpc/latest_versions') {
    const { harness_ids: ids } = JSON.parse(init.body as string) as { harness_ids: string[] };
    latestCalls.push(ids);
    return Response.json(
      ids.map((id) => ({
        harness_id: id,
        store_status: 'not_found',
        latest_version: null,
        manifest: null,
      })),
    );
  }
  if (target.pathname.startsWith('/rest/v1/') && target.pathname !== '/rest/v1/profiles') {
    return Response.json([]);
  }
  if (target.origin === FAKE_STORE_URL) return auth.fetch(url, init);
  return new Response('{}', { status: 404 });
};

/** Writes settings and an installed Store Harness into `dataDir` before the app starts. */
function seed({ storeBaseUrl, storeInstall }: { storeBaseUrl?: string; storeInstall?: boolean }) {
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, 'harness-store.sqlite'));
  try {
    if (storeBaseUrl !== undefined) {
      createSqliteSettingsStore(db).write('store_base_url', storeBaseUrl);
    }
    if (storeInstall === true) {
      const manifest = manifestWith({ default: {} });
      createInstallStore(db).put({
        harnessId: HARNESS_ID,
        version: manifest.version,
        manifest,
        installPath: join(dataDir, 'harnesses', HARNESS_ID, manifest.version),
        dataDir: join(dataDir, 'data', HARNESS_ID),
        installedAt: '2026-10-28T09:00:00.000Z',
        consentedPermissions: manifest.permissions,
        source: 'store',
      });
    }
  } finally {
    db.close();
  }
}

/** One app launch on `dataDir`, with the Store online. */
async function launch(options: Partial<RuntimeOptions> = {}): Promise<Runtime> {
  const browser: { runtime?: Runtime } = {};
  const runtime = await startRuntime({
    dataDir,
    version: '1.2.3',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: (url) => {
      connectivityChecks.push(url);
      return Promise.resolve({ status: 200 });
    },
    providerFetch: offlineProviderFetch,
    secretCipher: createFakeCipher(),
    storeFetch,
    storeAnonKey: FAKE_ANON_KEY,
    openExternal: auth.browser((url) => browser.runtime?.auth.handleCallback(url) ?? false),
    openPath: (path) => {
      opened.push(path);
      return Promise.resolve(true);
    },
    writeClipboard: (text) => {
      clipboard.push(text);
      return Promise.resolve();
    },
    ...options,
  });
  browser.runtime = runtime;
  started.push(runtime);
  return runtime;
}

function call(runtime: Runtime, method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

describe('persistence (How to verify, step 1)', () => {
  it('every setting written with settings.set reads back the same after a restart', async () => {
    const first = await launch();
    const written = await call(first, 'settings.set', {
      locale: 'zh-CN',
      onboardingDone: true,
      updateCheckInterval: '24h',
      storeBaseUrl: STAGING_URL,
    });
    expect(written).toEqual({
      ok: true,
      data: {
        locale: 'zh-CN',
        resolvedLocale: 'zh-CN',
        onboardingDone: true,
        updateCheckInterval: '24h',
        storeBaseUrl: STAGING_URL,
        defaultStoreBaseUrl: DEFAULT_STORE_BASE_URL,
      },
    });
    await first.shutdown();

    const second = await launch();
    await expect(call(second, 'settings.get')).resolves.toEqual(written);
    expect(second.storeBaseUrl()).toBe(STAGING_URL);
  });

  it.each(['1h', '6h', '24h', 'never'])('keeps the update interval %s', async (interval) => {
    const first = await launch();
    await call(first, 'settings.set', { updateCheckInterval: interval });
    await first.shutdown();
    await expect(call(await launch(), 'settings.get')).resolves.toMatchObject({
      data: { updateCheckInterval: interval },
    });
  });

  it('a fresh profile checks every 6 hours on the default Store', async () => {
    const runtime = await launch();
    const result = await call(runtime, 'settings.get');
    expect(result).toMatchObject({
      ok: true,
      data: { updateCheckInterval: '6h', defaultStoreBaseUrl: DEFAULT_STORE_BASE_URL },
    });
    expect(result.ok && 'storeBaseUrl' in (result.data as object)).toBe(false);
  });
});

describe('update interval (How to verify, step 2)', () => {
  /** Fakes the timers only: SQLite, the Gateway's sockets and fetch run as they do. */
  function fakeClock() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  }

  /**
   * Launches with the clock faked, then lists the installs once, so the installer's startup
   * recovery and icon reads (real file I/O, which fake time does not wait for) are done before
   * the clock moves and a due check runs in microtasks alone.
   */
  async function launchOnFakeClock(): Promise<Runtime> {
    fakeClock();
    const runtime = await launch();
    await call(runtime, 'installs.list');
    return runtime;
  }

  it('Never makes no latest_versions call over 30 hours, not even 10 s after start', async () => {
    seed({ storeInstall: true });
    const first = await launch();
    await call(first, 'settings.set', { updateCheckInterval: 'never' });
    await first.shutdown();
    expect(latestCalls).toEqual([]);

    const second = await launchOnFakeClock();
    await vi.advanceTimersByTimeAsync(30 * HOUR);
    expect(latestCalls).toEqual([]);

    // Check now still checks.
    await expect(call(second, 'installs.checkUpdates')).resolves.toEqual({ ok: true, data: null });
    expect(latestCalls).toEqual([[HARNESS_ID]]);
  });

  it('with 1 hour, 30 hours make the startup check and one an hour after each', async () => {
    seed({ storeInstall: true });
    const first = await launch();
    await call(first, 'settings.set', { updateCheckInterval: '1h' });
    await first.shutdown();

    await launchOnFakeClock();
    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS);
    expect(latestCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30 * HOUR - FIRST_UPDATE_CHECK_DELAY_MS);
    expect(latestCalls).toHaveLength(30);
  });

  it('choosing Never while the app runs cancels the checks scheduled', async () => {
    seed({ storeInstall: true });
    const runtime = await launchOnFakeClock();
    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS);
    expect(latestCalls).toHaveLength(1);

    await call(runtime, 'settings.set', { updateCheckInterval: 'never' });
    await vi.advanceTimersByTimeAsync(30 * HOUR);
    expect(latestCalls).toHaveLength(1);
  });

  it('another interval schedules the next check a whole interval from now, with none now', async () => {
    seed({ storeInstall: true });
    const runtime = await launchOnFakeClock();
    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS + 2 * HOUR);
    expect(latestCalls).toHaveLength(1);

    await call(runtime, 'settings.set', { updateCheckInterval: '1h' });
    expect(latestCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(latestCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(latestCalls).toHaveLength(2);

    // The same value again changes nothing.
    await vi.advanceTimersByTimeAsync(HOUR / 2);
    await call(runtime, 'settings.set', { updateCheckInterval: '1h' });
    await vi.advanceTimersByTimeAsync(HOUR / 2);
    expect(latestCalls).toHaveLength(3);
  });

  it('Check now answers store_unreachable while the Store is offline', async () => {
    seed({ storeInstall: true });
    const runtime = await launch({ fetch: () => Promise.reject(new TypeError('fetch failed')) });
    await call(runtime, 'connectivity.check');
    await expect(call(runtime, 'installs.checkUpdates')).resolves.toMatchObject({
      ok: false,
      error: { code: 'store_unreachable' },
    });
    expect(latestCalls).toEqual([]);
  });
});

describe('Store URL (acceptance: the next Store read uses the new URL)', () => {
  it('signs out of the old Store first, then switches every Store read to the new one', async () => {
    seed({ storeBaseUrl: FAKE_STORE_URL });
    const runtime = await launch();
    await expect(call(runtime, 'auth.signIn')).resolves.toMatchObject({
      data: { signedIn: true },
    });
    expect(auth.liveRefreshTokens()).toBe(1);
    await call(runtime, 'store.home');
    storeRequests = [];
    connectivityChecks = [];

    await expect(
      call(runtime, 'settings.set', { storeBaseUrl: `${STAGING_URL}/` }),
    ).resolves.toMatchObject({ ok: true, data: { storeBaseUrl: STAGING_URL } });
    // The session was revoked at the old Store, and nothing went to the new one with it.
    expect(auth.liveRefreshTokens()).toBe(0);
    expect(storeRequests).toEqual([`POST ${FAKE_STORE_URL}/auth/v1/logout?scope=local`]);
    await expect(call(runtime, 'auth.whoami')).resolves.toEqual({
      ok: true,
      data: { signedIn: false },
    });
    expect(connectivityChecks).toEqual([STAGING_URL]);

    storeRequests = [];
    await call(runtime, 'store.home');
    await call(runtime, 'installs.checkUpdates');
    expect(storeRequests.length).toBeGreaterThan(0);
    expect(storeRequests.every((request) => request.includes(` ${STAGING_URL}/`))).toBe(true);
  });

  it('drops the Store home cache: back on the first Store, its home is read again', async () => {
    const runtime = await launch();
    await call(runtime, 'store.home');
    await call(runtime, 'settings.set', { storeBaseUrl: STAGING_URL });
    await call(runtime, 'settings.set', { storeBaseUrl: null });
    storeRequests = [];
    await call(runtime, 'store.home');
    expect(storeRequests).toHaveLength(3);
    expect(storeRequests.every((request) => request.includes(` ${DEFAULT_STORE_BASE_URL}/`))).toBe(
      true,
    );
  });

  it('the default URL itself removes the setting; the same URL again signs nobody out', async () => {
    const runtime = await launch();
    await call(runtime, 'settings.set', { storeBaseUrl: STAGING_URL });
    connectivityChecks = [];
    await call(runtime, 'settings.set', { storeBaseUrl: STAGING_URL });
    expect(connectivityChecks).toEqual([]);

    const result = await call(runtime, 'settings.set', { storeBaseUrl: DEFAULT_STORE_BASE_URL });
    expect(result.ok && 'storeBaseUrl' in (result.data as object)).toBe(false);
    expect(runtime.storeBaseUrl()).toBe(DEFAULT_STORE_BASE_URL);
    expect(connectivityChecks).toEqual([DEFAULT_STORE_BASE_URL]);
  });

  it.each([
    ['upper case and a trailing slash', 'HTTPS://Staging.Store.TEST/', STAGING_URL],
    ['a path', 'http://localhost:54321/store/', 'http://localhost:54321/store'],
  ])('stores %s normalized', async (_case, input, stored) => {
    const runtime = await launch();
    await expect(call(runtime, 'settings.set', { storeBaseUrl: input })).resolves.toMatchObject({
      ok: true,
      data: { storeBaseUrl: stored },
    });
  });

  it.each([
    '',
    'staging.store.test',
    '/relative',
    'ftp://store.test',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:secret@store.test',
    'https://store.test/?apikey=1',
    'https://store.test/#top',
    ' https://store.test',
    `https://store.test/${'a'.repeat(2048)}`,
    42,
  ])('refuses the Store URL %j as invalid_input, changing nothing', async (storeBaseUrl) => {
    const runtime = await launch();
    await expect(call(runtime, 'settings.set', { storeBaseUrl })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method: 'settings.set' } },
    });
    expect(runtime.storeBaseUrl()).toBe(DEFAULT_STORE_BASE_URL);
  });

  it.each([{ updateCheckInterval: '12h' }, { updateCheckInterval: null }, { theme: 'dark' }])(
    'refuses %j as invalid_input',
    async (input) => {
      const runtime = await launch();
      await expect(call(runtime, 'settings.set', input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    },
  );
});

describe('app.openFolder (acceptance: each opens the correct path)', () => {
  it('opens the logs folder, creating it, and the data root', async () => {
    const runtime = await launch();
    const logs = join(dataDir, 'logs');
    rmSync(logs, { recursive: true, force: true });
    await expect(call(runtime, 'app.openFolder', 'logs')).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(existsSync(logs)).toBe(true);
    await expect(call(runtime, 'app.openFolder', 'dataRoot')).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(opened).toEqual([logs, dataDir]);
  });

  it('answers open_failed with the path when the OS could not open it', async () => {
    const runtime = await launch({ openPath: () => Promise.resolve(false) });
    await expect(call(runtime, 'app.openFolder', 'dataRoot')).resolves.toMatchObject({
      ok: false,
      error: { code: 'open_failed', params: { path: dataDir } },
    });
  });
});

describe('diagnostics (How to verify, step 4)', () => {
  it('shows the Model Gateway reachable, then not reachable once it stops answering', async () => {
    let gateway: Gateway | undefined;
    const runtime = await launch({
      createGateway: (options) => {
        gateway = createGateway(options);
        return gateway;
      },
    });
    const port = runtime.gatewayPort();
    await expect(call(runtime, 'diagnostics.get')).resolves.toEqual({
      ok: true,
      data: {
        version: '1.2.3',
        gateway: { running: true, port, reachable: true },
        nodeVersion: process.versions.node,
        dataRoot: dataDir,
        databasePath: join(dataDir, 'harness-store.sqlite'),
      },
    });

    // The Gateway stops listening behind the Runtime's back: no cached answer is shown.
    await gateway?.close();
    await expect(call(runtime, 'diagnostics.get')).resolves.toMatchObject({
      ok: true,
      data: { gateway: { running: true, port, reachable: false } },
    });
  });

  it('probeGateway is false for a port that refuses connections', async () => {
    await expect(probeGateway(REFUSED_PORT)).resolves.toBe(false);
  });

  it('Copy diagnostics puts every listed field on the clipboard, read fresh, nothing secret', async () => {
    seed({ storeBaseUrl: FAKE_STORE_URL });
    let reachable = true;
    const runtime = await launch({ probeGateway: () => Promise.resolve(reachable) });
    await call(runtime, 'auth.signIn');
    const port = runtime.gatewayPort();
    reachable = false;

    await expect(call(runtime, 'diagnostics.copy')).resolves.toEqual({ ok: true, data: null });
    expect(clipboard).toEqual([
      [
        'Harness Store diagnostics',
        'Version: 1.2.3',
        `Model Gateway: running on port ${String(port)}, not reachable`,
        `Node: ${process.versions.node}`,
        `Data root: ${dataDir}`,
        `Database: ${join(dataDir, 'harness-store.sqlite')}`,
        `Store URL: ${FAKE_STORE_URL} (custom)`,
      ].join('\n'),
    ]);
    expect(clipboard[0]).not.toMatch(/access-|refresh-|anon|key|token/i);
  });

  it('a Runtime whose Gateway did not start says it is not running', async () => {
    const runtime = await launch({
      createGateway: (options) => {
        const gateway = createGateway(options);
        gateway.listen = () => Promise.reject(new Error('listen EADDRINUSE'));
        return gateway;
      },
    });
    await expect(call(runtime, 'diagnostics.get')).resolves.toMatchObject({
      ok: true,
      data: { gateway: { running: false } },
    });
    await call(runtime, 'diagnostics.copy');
    expect(clipboard[0]).toContain('Model Gateway: not running');
    expect(clipboard[0]).toContain(`Store URL: ${DEFAULT_STORE_BASE_URL}\n`.trimEnd());
  });
});
