import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createGateway,
  type Gateway,
  type GatewayOptions,
  type UsageRecord,
} from '@harness-store/gateway';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startRuntime,
  type Runtime,
  type RuntimeOptions,
} from '../../src/main/runtime/bootstrap.js';
import { MIGRATIONS } from '../../src/main/runtime/database.js';
import { DEFAULT_STORE_BASE_URL } from '../../src/main/runtime/connectivity.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createFakeCipher } from '../support/fake-cipher.js';
import { offlineProviderFetch } from '../support/provider-fetch.js';

const MAIN_WINDOW = {};
/** What `settings.get` answers for the settings these tests leave alone. */
const SETTINGS_DEFAULTS = {
  updateCheckInterval: '6h',
  defaultStoreBaseUrl: DEFAULT_STORE_BASE_URL,
} as const;

let dataDir: string;
let started: Runtime[];
beforeEach(() => {
  // The data directory does not exist yet, as on a clean install.
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-runtime-')), 'userData');
  started = [];
});
afterEach(async () => {
  await Promise.all(started.map((runtime) => runtime.shutdown()));
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

/** One app launch against `dataDir`: the real bootstrap sequence, without Electron. */
async function launch(options: Partial<RuntimeOptions> = {}): Promise<Runtime> {
  const runtime = await startRuntime({
    dataDir,
    version: '1.2.3',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    // No network in these tests: the Store connectivity check sees a refused connection.
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    secretCipher: createFakeCipher(),
    providerFetch: offlineProviderFetch,
    ...options,
  });
  started.push(runtime);
  return runtime;
}

/** Calls one IPC method on the Runtime's handlers, as the renderer would. */
function call(runtime: Runtime, method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

function gatewayPort(runtime: Runtime): number {
  const port = runtime.gatewayPort();
  if (port === null) throw new Error('The Model Gateway is not running');
  return port;
}

/** Resolves true when a TCP connection to 127.0.0.1:`port` opens, false when it is refused. */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
}

function tables(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    return rows.map((row) => row.name).sort();
  } finally {
    db.close();
  }
}

const USAGE_RECORD: UsageRecord = {
  timestamp: '2026-10-27T09:30:00.000Z',
  harnessId: 'acme/code-reviewer',
  harnessVersion: '1.2.0',
  slot: 'default',
  provider: 'ollama',
  model: 'llama3.2',
  promptTokens: 10,
  completionTokens: 20,
  durationMs: 42,
  status: 'ok',
};

/** The rows of usage_records in the Runtime's database, read after it has shut down. */
function usageRows(runtime: Runtime): unknown[] {
  const db = new DatabaseSync(runtime.databasePath, { readOnly: true });
  try {
    return db.prepare('SELECT harness_id, provider, model, status FROM usage_records').all();
  } finally {
    db.close();
  }
}

/** A Model Gateway factory whose `listen` rejects as a port that cannot be bound would. */
function failingToBind(): (options: GatewayOptions) => Gateway {
  return (options) => {
    const gateway = createGateway(options);
    gateway.listen = () =>
      Promise.reject(
        Object.assign(new Error('listen EADDRINUSE: address already in use'), {
          code: 'EADDRINUSE',
        }),
      );
    return gateway;
  };
}

describe('startRuntime on a clean install', () => {
  it('creates the SQLite file in the data directory with the tables of every migration', async () => {
    const runtime = await launch();
    expect(runtime.status).toEqual({ state: 'ready' });
    const { databasePath } = runtime;
    expect(databasePath).toBe(join(dataDir, 'harness-store.sqlite'));
    expect(existsSync(databasePath)).toBe(true);
    await runtime.shutdown();
    expect(tables(databasePath)).toEqual([
      'connections',
      'installs',
      'launches',
      'secrets',
      'settings',
      'slot_bindings',
      'usage_records',
    ]);
  });

  it('starts the Model Gateway on loopback; a TCP connection to its port succeeds', async () => {
    const runtime = await launch();
    await expect(call(runtime, 'diagnostics.get')).resolves.toEqual({
      ok: true,
      data: {
        version: '1.2.3',
        // The real probe reached it.
        gateway: { running: true, port: expect.any(Number) as number, reachable: true },
        nodeVersion: process.versions.node,
        dataRoot: dataDir,
        databasePath: join(dataDir, 'harness-store.sqlite'),
      },
    });
    const port = gatewayPort(runtime);
    expect(port).toBeGreaterThan(0);
    await expect(canConnect(port)).resolves.toBe(true);
  });

  it('lets the OS pick the port, so two Runtimes never collide', async () => {
    const first = await launch();
    const second = await launch({ dataDir: join(dataDir, 'second') });
    expect(gatewayPort(first)).not.toBe(gatewayPort(second));
  });

  it('asks the Model Gateway to listen on 127.0.0.1 with port 0, never a fixed port', async () => {
    const listen = vi.fn<(host?: string, port?: number) => void>();
    await launch({
      createGateway: (options) => {
        const gateway = createGateway(options);
        const real = gateway.listen.bind(gateway);
        gateway.listen = (host, port) => {
          listen(host, port);
          return real(host, port);
        };
        return gateway;
      },
    });
    expect(listen).toHaveBeenCalledExactlyOnceWith('127.0.0.1', 0);
  });
});

describe('Runtime.shutdown', () => {
  it('stops the listening socket: the port refuses connections right after', async () => {
    const runtime = await launch();
    const port = gatewayPort(runtime);
    await runtime.shutdown();
    await expect(canConnect(port)).resolves.toBe(false);
    expect(runtime.gatewayPort()).toBeNull();
  });

  it('is idempotent and stops saving the window state once it began', async () => {
    const first = await launch();
    const saved = { x: 10, y: 20, width: 1000, height: 700, isMaximized: false };
    first.windowState.save(saved);
    const shutdown = first.shutdown();
    expect(first.shutdown()).toBe(shutdown);
    // While the Gateway stops (the database is still open) and after the database has closed.
    first.windowState.save({ x: 1, y: 2, width: 1100, height: 800, isMaximized: true });
    await shutdown;
    expect(() => {
      first.windowState.save({ x: 3, y: 4, width: 1200, height: 900, isMaximized: true });
    }).not.toThrow();

    const second = await launch();
    expect(second.windowState.read()).toEqual(saved);
  });

  it('writes the Usage Records the Model Gateway hands over into usage_records', async () => {
    let onUsage: GatewayOptions['onUsage'] | undefined;
    const runtime = await launch({
      createGateway: (options) => {
        onUsage = (record) => options.onUsage(record);
        return createGateway(options);
      },
    });
    await onUsage?.(USAGE_RECORD);
    await runtime.shutdown();
    expect(usageRows(runtime)).toEqual([
      { harness_id: 'acme/code-reviewer', provider: 'ollama', model: 'llama3.2', status: 'ok' },
    ]);
  });

  it('stops the Model Gateway before closing the database, so its last Usage Records are kept', async () => {
    const runtime = await launch({
      createGateway: (options) => {
        const gateway = createGateway(options);
        const close = gateway.close.bind(gateway);
        // A request ended by close() hands over its Usage Record on a later turn, as the
        // Gateway's deferred delivery does; close() resolves only once it is through onUsage.
        gateway.close = async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await options.onUsage(USAGE_RECORD);
          return close();
        };
        return gateway;
      },
    });
    await runtime.shutdown();
    expect(usageRows(runtime)).toEqual([
      { harness_id: 'acme/code-reviewer', provider: 'ollama', model: 'llama3.2', status: 'ok' },
    ]);
  });
});

describe('relaunch after a clean quit', () => {
  it('reuses the same database: settings and window state survive, no migration runs twice', async () => {
    const first = await launch();
    await call(first, 'settings.set', { locale: 'zh-CN' });
    const windowState = { x: 40, y: 60, width: 1100, height: 720, isMaximized: true };
    first.windowState.save(windowState);
    await first.shutdown();

    const second = await launch();
    expect(second.status).toEqual({ state: 'ready' });
    await expect(call(second, 'settings.get')).resolves.toEqual({
      ok: true,
      data: {
        locale: 'zh-CN',
        resolvedLocale: 'zh-CN',
        onboardingDone: false,
        ...SETTINGS_DEFAULTS,
      },
    });
    expect(second.windowState.read()).toEqual(windowState);
    await second.shutdown();

    const db = new DatabaseSync(join(dataDir, 'harness-store.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length });
      expect(db.prepare('SELECT COUNT(*) AS count FROM settings').get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });
});

describe('startup failures', () => {
  it('reports a Model Gateway that cannot bind its port as a failed gateway step', async () => {
    const logError = vi.fn();
    const runtime = await launch({ createGateway: failingToBind(), logError });
    expect(runtime.status).toEqual({
      state: 'failed',
      stage: 'gateway',
      detail: 'listen EADDRINUSE: address already in use',
    });
    await expect(call(runtime, 'app.status')).resolves.toEqual({
      ok: true,
      data: runtime.status,
    });
    expect(runtime.gatewayPort()).toBeNull();
    expect(logError).toHaveBeenCalledOnce();
  });

  it('reports a database that cannot be opened as a failed database step, without a Gateway', async () => {
    // A folder where the SQLite file should be.
    mkdirSync(join(dataDir, 'harness-store.sqlite'), { recursive: true });
    const createGatewaySpy = vi.fn(createGateway);
    const runtime = await launch({ createGateway: createGatewaySpy, osLocale: () => 'zh-TW' });
    expect(runtime.status).toMatchObject({ state: 'failed', stage: 'database' });
    expect(createGatewaySpy).not.toHaveBeenCalled();
    // Without the database the UI still follows the OS locale, for the error screen.
    await expect(call(runtime, 'settings.get')).resolves.toEqual({
      ok: true,
      data: { resolvedLocale: 'zh-CN', onboardingDone: false, ...SETTINGS_DEFAULTS },
    });
    expect(runtime.windowState.read()).toBeNull();
  });

  it('reports a current schema version with unexpected tables as a failed database step', async () => {
    // A file whose user_version says every migration ran, but without their tables (a tampered
    // file, or one left by a pre-release build): no migration runs, so opening it succeeds.
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, 'harness-store.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${String(MIGRATIONS.length)}`);
    db.close();
    const createGatewaySpy = vi.fn(createGateway);

    const runtime = await launch({ createGateway: createGatewaySpy });
    expect(runtime.status).toMatchObject({
      state: 'failed',
      stage: 'database',
      detail: expect.stringContaining('no such table') as string,
    });
    expect(createGatewaySpy).not.toHaveBeenCalled();
    await expect(call(runtime, 'settings.get')).resolves.toEqual({
      ok: true,
      data: { resolvedLocale: 'en', onboardingDone: false, ...SETTINGS_DEFAULTS },
    });
    expect(runtime.windowState.read()).toBeNull();
  });
});
