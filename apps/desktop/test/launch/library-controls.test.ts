import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createHarnessWindowHandlers } from '../../src/main/runtime/harness-window-handlers.js';
import { spawnNodePty, type PtySpawnOptions } from '../../src/main/runtime/pty.js';
import type { HarnessWindows } from '../../src/main/runtime/supervisor.js';
import type { IpcEventName, IpcEvents, IpcResult, LaunchStatus } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';

/**
 * Ticket P0-05.6, the Library's running controls as main serves them: the real Runtime with its
 * SQLite file in a temp app data root, the real Model Gateway, fixture Harnesses installed from
 * their folders and run for real in a pty, the Harness windows faked (each reports its terminal
 * ready at once) and `shell.openPath` recorded. The Library card follows the `launch.state`
 * events these tests read; test/renderer/launch-library-controls.test.tsx drives the card itself.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/harnesses');
const PLATFORM = `${process.platform}-${process.arch}`;
const MAIN_WINDOW = {};
const SIZE = { cols: 100, rows: 30 };

let root: string;
let userData: string;
let fake: FakeProvider;
let runtime: Runtime;
let windows: ReturnType<typeof createFakeWindows>;
let states: LaunchStatus[];
let spawned: PtySpawnOptions[];
let opened: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-library-'));
  userData = join(root, 'userData');
  fake = await startFakeProvider({ aliases: { 'model-a': 'fake/echo' } });
  states = [];
  spawned = [];
  opened = [];
  windows = createFakeWindows();
  runtime = await startRuntime({
    dataDir: userData,
    version: '1.0.0',
    osLocale: () => 'en',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    providerFetch: globalThis.fetch,
    secretCipher: createFakeCipher(),
    platform: PLATFORM,
    emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => {
      if (event === 'launch.state') states.push(payload as LaunchStatus);
    },
    harnessWindows: windows,
    spawnPty: (options) => {
      spawned.push(options);
      return spawnNodePty(options);
    },
    openPath: (path) => {
      opened.push(path);
      return Promise.resolve();
    },
  });
  // A model for the `default` Slot: a launch without one is refused.
  await expect(
    call('connections.add', { providerId: 'ollama', baseUrl: fake.url }),
  ).resolves.toMatchObject({ ok: true });
  await expect(
    call('bindings.setGlobal', {
      slot: 'default',
      target: { connectionId: 'ollama', model: 'model-a' },
    }),
  ).resolves.toMatchObject({ ok: true });
});
afterEach(async () => {
  await runtime.shutdown();
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

/** Harness windows without Electron; `close` closes one as the User does (its `closed` event). */
function createFakeWindows() {
  const open = new Map<string, () => void>();
  const opens: string[] = [];
  const focused: string[] = [];
  const fakes = {
    open,
    opens,
    focused,
    openTerminal(spec, onClosed) {
      opens.push(spec.launchId);
      open.set(spec.launchId, onClosed);
      queueMicrotask(() => {
        void createDispatcher({
          handlers: createHarnessWindowHandlers(spec.launchId, {
            supervisor: runtime.supervisor,
            bindings: runtime.services.bindings,
            clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
            openModels: () => undefined,
          }),
          isTrustedSender: () => true,
        })(spec.launchId, { method: 'terminal.ready', input: SIZE });
      });
    },
    openWeb() {
      throw new Error('No web window in these tests');
    },
    showWeb: () => undefined,
    hideWeb: () => undefined,
    reloadWeb: () => undefined,
    layoutWeb: () => undefined,
    send: () => undefined,
    focus(launchId) {
      focused.push(launchId);
      return open.has(launchId);
    },
    close(launchId) {
      const onClosed = open.get(launchId);
      if (onClosed === undefined) return;
      open.delete(launchId);
      onClosed();
    },
  } satisfies HarnessWindows & Record<string, unknown>;
  return fakes;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const lastState = (launchId: string) => states.filter((each) => each.launchId === launchId).at(-1);
const waitForState = (launchId: string, state: LaunchStatus['state'], timeoutMs?: number) =>
  waitFor(() => {
    const last = lastState(launchId);
    return last?.state === state ? last : undefined;
  }, timeoutMs);

async function install(fixture: string) {
  await expect(call('installs.installFromFolder', join(FIXTURES, fixture))).resolves.toMatchObject({
    ok: true,
  });
}

async function launch(harnessId: string): Promise<string> {
  const result = (await call('launch.start', { harnessId })) as IpcResult<{
    outcome: string;
    launchId: string;
  }>;
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.outcome).toBe('started');
  return result.data.launchId;
}

const logsDir = (slug: string) => join(userData, 'logs', 'acme', slug);
const dataDir = (slug: string) => join(userData, 'data', 'acme', slug);

describe('running and stopping from the Library', () => {
  it('Launch runs it; Launch again focuses its window; closing the window stops it', async () => {
    await install('fixture-term');
    const launchId = await launch('acme/fixture-term');
    await waitForState(launchId, 'ready');
    expect(states.filter((each) => each.launchId === launchId).map((each) => each.state)).toEqual([
      'preparing',
      'spawning',
      'ready',
    ]);

    // Running… and Show window: the card launches again, which only brings its window up.
    for (let click = 0; click < 2; click += 1) {
      await expect(call('launch.start', { harnessId: 'acme/fixture-term' })).resolves.toEqual({
        ok: true,
        data: { outcome: 'focused', launchId },
      });
    }
    expect(windows.focused).toEqual([launchId, launchId]);
    expect(windows.opens).toEqual([launchId]);
    expect(spawned).toHaveLength(1);

    // There is no Stop on the card: closing the Harness's window stops it.
    windows.close(launchId);
    await waitForState(launchId, 'stopped');
    expect(states.filter((each) => each.launchId === launchId).map((each) => each.state)).toEqual([
      'preparing',
      'spawning',
      'ready',
      'stopping',
      'stopped',
    ]);
    await expect(call('launch.status')).resolves.toMatchObject({
      ok: true,
      data: [{ harnessId: 'acme/fixture-term', launchId, state: 'stopped' }],
    });

    // Back on Launch, which starts a new process.
    const next = await launch('acme/fixture-term');
    await waitForState(next, 'ready');
    expect(spawned).toHaveLength(2);
  });
});

describe('Show logs', () => {
  it("opens a failed launch's log, which holds what the Harness printed", async () => {
    await install('fixture-crash');
    const launchId = await launch('acme/fixture-crash');
    await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
      reason: 'exit_nonzero',
      exitCode: 3,
    });

    await expect(call('launch.openLogs', 'acme/fixture-crash')).resolves.toEqual({
      ok: true,
      data: null,
    });
    const log = join(logsDir('fixture-crash'), `${launchId}.log`);
    expect(opened).toEqual([log]);
    expect(readFileSync(log, 'utf8')).toMatch(
      /\[pty\] fixture-crash: failing on purpose\n[^\n]*\[runtime\] Exited with code 3\n/,
    );
  });

  it("opens its latest launch's log, though another log of the folder is newer", async () => {
    await install('fixture-crash');
    const launchId = await launch('acme/fixture-crash');
    await waitForState(launchId, 'failed');
    const stray = join(logsDir('fixture-crash'), 'zz-other.log');
    writeFileSync(stray, 'not this launch\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(stray, future, future);

    await call('launch.openLogs', 'acme/fixture-crash');
    expect(opened).toEqual([join(logsDir('fixture-crash'), `${launchId}.log`)]);
  });

  it('without a launch since the app started, opens the most recently written log', async () => {
    await install('fixture-crash');
    const folder = logsDir('fixture-crash');
    await call('launch.openLogs', 'acme/fixture-crash');
    // No log yet: the logs folder, created.
    expect(opened).toEqual([folder]);
    expect(statSync(folder).isDirectory()).toBe(true);

    const older = join(folder, 'older.log');
    const newer = join(folder, 'newer.log');
    writeFileSync(older, 'older\n');
    writeFileSync(newer, 'newer\n');
    utimesSync(older, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
    utimesSync(newer, new Date('2026-10-02T00:00:00Z'), new Date('2026-10-02T00:00:00Z'));
    await call('launch.openLogs', 'acme/fixture-crash');
    expect(opened.at(-1)).toBe(newer);
  });
});

describe('Open data folder', () => {
  it("opens the Harness's Data Directory, creating it when it is missing", async () => {
    await install('fixture-term');
    const folder = dataDir('fixture-term');
    rmSync(folder, { recursive: true, force: true });

    await expect(call('launch.openDataFolder', 'acme/fixture-term')).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(opened).toEqual([folder]);
    expect(existsSync(folder)).toBe(true);
  });
});

it('Show logs and Open data folder answer not_installed for a Harness that is not', async () => {
  for (const method of ['launch.openLogs', 'launch.openDataFolder']) {
    await expect(call(method, 'acme/fixture-term')).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_installed' },
    });
  }
  expect(opened).toEqual([]);
});
