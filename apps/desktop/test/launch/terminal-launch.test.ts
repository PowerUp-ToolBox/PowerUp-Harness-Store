import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createHarnessWindowHandlers } from '../../src/main/runtime/harness-window-handlers.js';
import { spawnNodePty, type PtySpawnOptions } from '../../src/main/runtime/pty.js';
import { terminalText } from '../../src/main/runtime/smoke.js';
import type { HarnessWindows } from '../../src/main/runtime/supervisor.js';
import type { HarnessWindowEventName } from '../../src/shared/harness-ipc.js';
import type { IpcEventName, IpcEvents, IpcResult, LaunchStatus } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';
import { removeFolder, WAIT_MS } from '../support/harness-processes.js';
import { createTerminalScreens } from '../support/terminal-screen.js';

/**
 * Ticket P0-05.2, launching a terminal Harness, through the Supervisor seam: the real Runtime with
 * its SQLite file in a temp app data root, the real Model Gateway, fixture Harnesses installed from
 * their folders and run for real in a pty (node-pty, under this test's Node), and the Harness
 * windows faked. The fake window's "page" talks to the Runtime over the real Harness window
 * handlers, and reports its terminal ready at once.
 *
 * The signal tests run on macOS and Linux only: Windows has no signals (the Supervisor uses
 * taskkill there, untested until CI runs on Windows).
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/harnesses');
const PLATFORM = `${process.platform}-${process.arch}`;
const MAIN_WINDOW = {};
const SIZE = { cols: 100, rows: 30 };

let root: string;
let userData: string;
let signalFile: string;
/** Where fixture-term writes the environment it got. */
let envFile: string;
let fake: FakeProvider;
let runtime: Runtime;
let windows: ReturnType<typeof createFakeWindows>;
let states: LaunchStatus[];
let spawned: PtySpawnOptions[];
/** When set, the pty spawn throws it, after the Runtime issued the launch's token. */
let spawnFailure: Error | undefined;
let opened: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-launch-'));
  userData = join(root, 'userData');
  signalFile = join(root, 'signals.txt');
  envFile = join(root, 'env.json');
  fake = await startFakeProvider({ aliases: { 'model-a': 'fake/echo' } });
  states = [];
  spawned = [];
  spawnFailure = undefined;
  opened = [];
  runtime = await start();
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
  removeFolder(root);
});

/** The Runtime on `userData`, its Harnesses inheriting a deliberately polluted environment. */
function start(): Promise<Runtime> {
  windows = createFakeWindows();
  return startRuntime({
    dataDir: userData,
    version: '1.0.0',
    osLocale: () => 'zh-CN',
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
      if (spawnFailure !== undefined) throw spawnFailure;
      return spawnNodePty(options);
    },
    harnessEnvironment: () => ({
      ...process.env,
      OPENAI_API_KEY: 'sk-parent-openai',
      OPENAI_ORG_ID: 'org-parent',
      ANTHROPIC_API_KEY: 'sk-ant-parent',
      GEMINI_API_KEY: 'parent-gemini',
      GOOGLE_API_KEY: 'parent-google',
      openrouter_api_key: 'parent-openrouter',
      HARNESS_WORKSPACE: '/parent/workspace',
      FIXTURE_SIGNAL_FILE: signalFile,
      FIXTURE_ENV_FILE: envFile,
    }),
    openPath: (path) => {
      opened.push(path);
      return Promise.resolve(true);
    },
  });
}

function call(method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

/** A call from the page of `launchId`'s window, as main routes it. */
function windowCall(launchId: string, method: string, input?: unknown) {
  return createDispatcher({
    handlers: createHarnessWindowHandlers(launchId, {
      supervisor: runtime.supervisor,
      bindings: runtime.services.bindings,
      clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
      openModels: () => undefined,
    }),
    isTrustedSender: () => true,
  })(launchId, { method, input });
}

/**
 * Harness windows without Electron: each open window's page reports its terminal ready at once,
 * and records what main sends it. `close` closes it as Electron does (its `closed` event).
 */
function createFakeWindows() {
  const open = new Map<string, () => void>();
  const sent: { launchId: string; event: HarnessWindowEventName; payload: unknown }[] = [];
  const opens: string[] = [];
  const focused: string[] = [];
  const screens = createTerminalScreens(SIZE);
  const fakes = {
    open,
    sent,
    opens,
    focused,
    screens,
    openTerminal(spec, onClosed) {
      opens.push(spec.launchId);
      open.set(spec.launchId, onClosed);
      queueMicrotask(() => void windowCall(spec.launchId, 'terminal.ready', SIZE));
    },
    // Web windows are covered by web-launch.test.ts.
    openWeb() {
      throw new Error('No web window in these tests');
    },
    showWeb: () => undefined,
    hideWeb: () => undefined,
    reloadWeb: () => undefined,
    layoutWeb: () => undefined,
    send(launchId, event, payload) {
      if (!open.has(launchId)) return;
      sent.push({ launchId, event, payload });
      if (event === 'terminal.data') screens.write(launchId, payload as string);
    },
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

/** Everything the pty of `launchId` printed so far. */
function output(launchId: string): string {
  return windows.sent
    .filter((each) => each.launchId === launchId && each.event === 'terminal.data')
    .map((each) => each.payload as string)
    .join('');
}

/**
 * The values of the fixture's `FIXTURE <kind> <json>` lines printed in full so far, read from its
 * window's terminal as xterm.js renders it (test/support/terminal-screen.ts): Windows' ConPTY draws
 * the screen with bytes of its own. A line still being printed does not parse yet.
 */
async function reports(launchId: string, kind: string): Promise<unknown[]> {
  return (await windows.screens.text(launchId))
    .split('\n')
    .filter((line) => line.startsWith(`FIXTURE ${kind} `))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice(`FIXTURE ${kind} `.length)) as unknown];
      } catch {
        return [];
      }
    });
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
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

async function install(fixture: string, folder = join(FIXTURES, fixture)) {
  await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({ ok: true });
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

function launchRows() {
  const db = new DatabaseSync(join(userData, 'harness-store.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM launches').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function gatewayUrl(): string {
  const port = runtime.gatewayPort();
  if (port === null) throw new Error('The Model Gateway is not running');
  return `http://127.0.0.1:${String(port)}/v1`;
}

/** `GET /v1/harness/context` with `token`: its status and body. */
async function context(token: string) {
  const response = await fetch(`${gatewayUrl()}/harness/context`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The Gateway Token the Runtime handed the launch it spawned `index`-th. */
function spawnedToken(index = 0): string {
  const token = spawned[index]?.env.HARNESS_GATEWAY_TOKEN;
  if (token === undefined || token === '') throw new Error('No Gateway Token was spawned');
  return token;
}

/** Expects `token` rejected by the Gateway and its launch's row ended with the token revoked. */
async function expectRevoked(token: string, launchId: string) {
  const rejected = await context(token);
  expect(rejected.status).toBe(401);
  expect(rejected.body).toMatchObject({ error: { code: 'invalid_token' } });
  const row = launchRows().find((each) => each.launch_id === launchId);
  expect(row?.ended_at).toEqual(expect.any(String));
  expect(row?.token_revoked_at).toBe(row?.ended_at);
}

/** The environment fixture-term got, which it wrote before it printed `start`. */
function startedEnv(): Record<string, string> {
  return JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
}

/** Whether the process `pid` still runs (or has exited and is not reaped yet). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const logPath = (slug: string, launchId: string) =>
  join(userData, 'logs', 'acme', slug, `${launchId}.log`);

describe('launching fixture-term', () => {
  it('runs it in a pty with the launch contract environment, in its Data Directory', async () => {
    await install('fixture-term');
    const launchId = await launch('acme/fixture-term');
    const [started] = (await waitFor(async () => {
      const found = await reports(launchId, 'start');
      return found.length > 0 ? found : undefined;
    })) as [{ cwd: string; size: number[] }];
    const env = startedEnv();
    const dataDir = join(userData, 'data', 'acme', 'fixture-term');

    expect(env.HARNESS_GATEWAY_URL).toBe(gatewayUrl());
    expect(env.HARNESS_GATEWAY_TOKEN).toMatch(/^[\w-]{20,}$/);
    expect(env.OPENAI_BASE_URL).toBe(gatewayUrl());
    expect(env.OPENAI_API_KEY).toBe(env.HARNESS_GATEWAY_TOKEN);
    expect(env.HARNESS_ID).toBe('acme/fixture-term');
    expect(env.HARNESS_VERSION).toBe('1.0.0');
    expect(env.HARNESS_DATA_DIR).toBe(dataDir);
    expect(env.HARNESS_LOCALE).toBe('zh-CN');
    expect(env.HARNESS_PLATFORM).toBe(PLATFORM);
    // Nothing of the User's own credentials, nor a HARNESS_ variable the Runtime did not set.
    for (const name of [
      'OPENAI_ORG_ID',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'openrouter_api_key',
      'HARNESS_WORKSPACE',
      'HARNESS_PORT',
    ]) {
      expect(env, name).not.toHaveProperty(name);
    }
    // The rest is inherited; the Runtime's Node and a terminal xterm.js understands.
    expect(env.FIXTURE_SIGNAL_FILE).toBe(signalFile);
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env.TERM).toBe('xterm-256color');
    expect(realpathSync(started.cwd)).toBe(realpathSync(dataDir));
    expect(started.size).toEqual([SIZE.cols, SIZE.rows]);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      file: process.execPath,
      args: [join(userData, 'harnesses', 'acme', 'fixture-term', '1.0.0', 'index.mjs')],
      cwd: dataDir,
    });
    expect(states.map((each) => each.state)).toEqual(['preparing', 'spawning', 'ready']);

    // The Gateway knows the token as this launch's, in the app's language.
    const known = await context(env.HARNESS_GATEWAY_TOKEN ?? '');
    expect(known.status).toBe(200);
    expect(known.body).toMatchObject({
      harnessId: 'acme/fixture-term',
      version: '1.0.0',
      locale: 'zh-CN',
    });
    await expect(call('installs.list')).resolves.toMatchObject({
      ok: true,
      data: [{ harnessId: 'acme/fixture-term', lastLaunchedAt: lastState(launchId)?.startedAt }],
    });
  });

  it('a second launch while it runs focuses its window and starts nothing', async () => {
    await install('fixture-term');
    const launchId = await launch('acme/fixture-term');
    await waitForState(launchId, 'ready');

    await expect(call('launch.start', { harnessId: 'acme/fixture-term' })).resolves.toEqual({
      ok: true,
      data: { outcome: 'focused', launchId },
    });
    expect(windows.focused).toEqual([launchId]);
    expect(windows.opens).toEqual([launchId]);
    expect(spawned).toHaveLength(1);
    await expect(call('launch.status')).resolves.toMatchObject({
      ok: true,
      data: [{ harnessId: 'acme/fixture-term', launchId, state: 'ready' }],
    });
  });

  it('passes what the User types and the terminal size to the pty', async () => {
    await install('fixture-term');
    const launchId = await launch('acme/fixture-term');
    await waitFor(async () => ((await reports(launchId, 'start')).length > 0 ? true : undefined));

    await windowCall(launchId, 'terminal.input', 'hello\r');
    await expect(
      waitFor(async () => (await reports(launchId, 'input'))[0] as string | undefined),
    ).resolves.toBe('hello\n');
    await windowCall(launchId, 'terminal.resize', { cols: 120, rows: 40 });
    await expect(waitFor(async () => (await reports(launchId, 'resize'))[0])).resolves.toEqual([
      120, 40,
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'closing its window sends SIGTERM; the launch ends stopped, its token rejected and recorded',
    async () => {
      await install('fixture-term');
      const launchId = await launch('acme/fixture-term');
      await waitFor(async () => ((await reports(launchId, 'start')).length > 0 ? true : undefined));
      const token = startedEnv().HARNESS_GATEWAY_TOKEN ?? '';

      windows.close(launchId);
      await waitForState(launchId, 'stopped');
      expect(states.map((each) => each.state)).toEqual([
        'preparing',
        'spawning',
        'ready',
        'stopping',
        'stopped',
      ]);
      expect(lastState(launchId)).toMatchObject({ exitCode: 0 });
      expect(readFileSync(signalFile, 'utf8')).toBe('SIGTERM\n');

      const rejected = await context(token);
      expect(rejected.status).toBe(401);
      expect(rejected.body).toMatchObject({ error: { code: 'invalid_token' } });

      const [row] = launchRows();
      expect(row).toMatchObject({
        launch_id: launchId,
        harness_id: 'acme/fixture-term',
        version: '1.0.0',
        started_at: lastState(launchId)?.startedAt,
        exit_code: 0,
      });
      expect(row?.ended_at).toEqual(expect.any(String));
      expect(row?.token_revoked_at).toEqual(expect.any(String));

      // stdout and stderr, as the pty interleaved them, and the Runtime's own lines.
      const log = readFileSync(logPath('fixture-term', launchId), 'utf8');
      const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[(pty|runtime)\] /;
      expect(
        log
          .split('\n')
          .filter(Boolean)
          .every((line) => stamp.test(line)),
      ).toBe(true);
      expect(log).toMatch(/\[pty\] fixture-term: started\n/);
      expect(log).toMatch(/\[pty\] FIXTURE start \{/);
      expect(log).toMatch(/\[runtime\] Started .+ \(pid \d+\)\n/);
      expect(log).toMatch(/\[runtime\] Sent SIGTERM to \d+ and its children\n/);
      expect(log).toMatch(/\[runtime\] Exited with code 0\n/);
      expect(log).not.toContain('SIGKILL');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'quitting the app stops it first, with the shutdown sequence',
    async () => {
      await install('fixture-term');
      const launchId = await launch('acme/fixture-term');
      // Once it listens for SIGTERM.
      await waitFor(async () => ((await reports(launchId, 'start')).length > 0 ? true : undefined));
      await runtime.shutdown();

      expect(lastState(launchId)).toMatchObject({ state: 'stopped', exitCode: 0 });
      expect(readFileSync(signalFile, 'utf8')).toBe('SIGTERM\n');
      expect(launchRows()).toMatchObject([{ launch_id: launchId, exit_code: 0 }]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'once stopping everything for quitting, it launches nothing more',
    async () => {
      await install('fixture-term');
      const launchId = await launch('acme/fixture-term');
      await waitFor(async () => ((await reports(launchId, 'start')).length > 0 ? true : undefined));
      // The Supervisor's step of quitting alone: the database is still open, so only the
      // refusal of launches from then on can answer.
      await runtime.supervisor.stopAll();
      expect(lastState(launchId)).toMatchObject({ state: 'stopped' });

      const launched = states.length;
      await expect(call('launch.start', { harnessId: 'acme/fixture-term' })).resolves.toMatchObject(
        { ok: false, error: { code: 'internal_error' } },
      );
      expect(states).toHaveLength(launched);
      expect(windows.opens).toEqual([launchId]);
      expect(spawned).toHaveLength(1);
      expect(launchRows()).toHaveLength(1);
    },
  );
});

describe('the shutdown sequence', () => {
  it.skipIf(process.platform === 'win32')(
    'a Harness that ignores SIGTERM gets SIGKILL 5 seconds later',
    { timeout: 15_000 },
    async () => {
      await install('fixture-hang-on-sigterm');
      const launchId = await launch('acme/fixture-hang-on-sigterm');
      await waitFor(() => (output(launchId).includes('FIXTURE start') ? true : undefined));

      const closedAt = Date.now();
      windows.close(launchId);
      await waitForState(launchId, 'stopping');
      await waitFor(() => (existsSync(signalFile) ? true : undefined));
      expect(readFileSync(signalFile, 'utf8')).toBe('SIGTERM\n');
      const stopped = await waitForState(launchId, 'stopped', 10_000);
      const elapsed = Date.now() - closedAt;
      expect(elapsed).toBeGreaterThanOrEqual(4900);
      expect(elapsed).toBeLessThan(8000);
      // Killed by signal 9: 128 + 9.
      expect(stopped.exitCode).toBe(137);
      expect(launchRows()).toMatchObject([{ launch_id: launchId, exit_code: 137 }]);
      const log = readFileSync(logPath('fixture-hang-on-sigterm', launchId), 'utf8');
      expect(log).toMatch(/\[runtime\] Sent SIGTERM .*\n.*\[runtime\] Sent SIGKILL /);
    },
  );
});

describe('the shutdown sequence, for the processes a Harness started', () => {
  it.skipIf(process.platform === 'win32')(
    'one that ignores SIGTERM gets SIGKILL 5 seconds later, although the Harness exited at once',
    { timeout: 15_000 },
    async () => {
      await install('fixture-leaves-helper');
      const launchId = await launch('acme/fixture-leaves-helper');
      const [{ helperPid }] = (await waitFor(async () => {
        const found = await reports(launchId, 'start');
        return found.length > 0 ? found : undefined;
      })) as [{ helperPid: number }];
      try {
        expect(isAlive(helperPid)).toBe(true);

        const closedAt = Date.now();
        windows.close(launchId);
        const stopped = await waitForState(launchId, 'stopped', 10_000);
        const elapsed = Date.now() - closedAt;
        // The Harness itself exited on SIGTERM; its helper held the stop for the grace period.
        expect(stopped.exitCode).toBe(0);
        expect(elapsed).toBeGreaterThanOrEqual(4900);
        expect(elapsed).toBeLessThan(8000);
        await waitFor(() => (isAlive(helperPid) ? undefined : true), 2000);
        const log = readFileSync(logPath('fixture-leaves-helper', launchId), 'utf8');
        expect(log).toMatch(
          /\[runtime\] Sent SIGTERM .*\n(.*\n)*.*\[runtime\] Exited with code 0\n.*\[runtime\] Sent SIGKILL /,
        );
      } finally {
        if (isAlive(helperPid)) process.kill(helperPid, 'SIGKILL');
      }
    },
  );
});

describe('a Harness that exits on its own', () => {
  it('fixture-crash ends failed(exit_nonzero) with code 3; its window stays, with View logs', async () => {
    await install('fixture-crash');
    const launchId = await launch('acme/fixture-crash');
    const failed = await waitForState(launchId, 'failed');
    expect(failed).toMatchObject({ reason: 'exit_nonzero', exitCode: 3 });
    // A failed launch's token is revoked as a stopped one's is.
    await expectRevoked(spawnedToken(), launchId);

    // The window learns it, and stays open, readable, with the exit code.
    expect(windows.sent).toContainEqual({
      launchId,
      event: 'window.state',
      payload: expect.objectContaining({ state: 'failed', exitCode: 3 }) as unknown,
    });
    expect(windows.open.has(launchId)).toBe(true);
    await expect(windowCall(launchId, 'window.info')).resolves.toMatchObject({
      ok: true,
      data: {
        harnessId: 'acme/fixture-crash',
        name: 'Fixture Crash',
        uiKind: 'terminal',
        readyTimeoutSeconds: null,
        locale: 'zh-CN',
        iconDataUrl: expect.stringMatching(/^data:image\/png;base64,/) as unknown,
        status: { state: 'failed', reason: 'exit_nonzero', exitCode: 3 },
      },
    });
    expect(launchRows()).toMatchObject([{ launch_id: launchId, exit_code: 3 }]);

    // View logs opens this launch's log, which holds what it printed.
    await expect(windowCall(launchId, 'window.openLogs')).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(opened).toEqual([logPath('fixture-crash', launchId)]);
    // Read without the terminal's control sequences, which ConPTY adds around what it printed.
    expect(terminalText(readFileSync(logPath('fixture-crash', launchId), 'utf8'))).toMatch(
      /\[pty\] fixture-crash: failing on purpose\n[^\n]*\[runtime\] Exited with code 3\n/,
    );

    // Relaunch: the old window closes and the new launch opens its own.
    await expect(windowCall(launchId, 'window.relaunch')).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(windows.open.has(launchId)).toBe(false);
    await waitFor(() => (windows.opens.length === 2 ? true : undefined));
    expect(lastState(launchId)?.state).toBe('failed');
  });
});

describe('refused and failed launches', () => {
  it('refuses a Harness that is not installed, or whose default Slot no model fills', async () => {
    await expect(call('launch.start', { harnessId: 'acme/fixture-term' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_installed' },
    });

    await install('fixture-term');
    await call('bindings.setGlobal', { slot: 'default', target: null });
    await expect(call('launch.start', { harnessId: 'acme/fixture-term' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'slot_unbound', params: { slot: 'default' } },
    });
    expect(states).toEqual([]);
    expect(launchRows()).toEqual([]);
  });

  it('a platform the Harness does not declare fails before any token, row or window', async () => {
    const folder = join(root, 'other-platform');
    cpSync(join(FIXTURES, 'fixture-term'), folder, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
      platforms: string[];
    };
    manifest.platforms = manifest.platforms.filter((platform) => platform !== PLATFORM);
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest));
    await install('fixture-term', folder);

    const launchId = await launch('acme/fixture-term');
    await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
      reason: 'platform_unsupported',
    });
    expect(windows.opens).toEqual([]);
    expect(spawned).toEqual([]);
    expect(launchRows()).toEqual([]);
  });

  it('an Entry that is missing fails spawn_error before any token', async () => {
    await install('fixture-term');
    rmSync(join(userData, 'harnesses', 'acme', 'fixture-term', '1.0.0', 'index.mjs'));
    const launchId = await launch('acme/fixture-term');
    await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
      reason: 'spawn_error',
    });
    expect(launchRows()).toEqual([]);
  });

  it('a pty that cannot start fails spawn_error after the token, and revokes it', async () => {
    await install('fixture-term');
    spawnFailure = new Error('posix_spawnp failed.');
    const launchId = await launch('acme/fixture-term');
    await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
      reason: 'spawn_error',
    });
    expect(spawned).toHaveLength(1);
    expect(launchRows()).toMatchObject([{ launch_id: launchId, exit_code: null }]);
    await expectRevoked(spawnedToken(), launchId);
    expect(readFileSync(logPath('fixture-term', launchId), 'utf8')).toMatch(
      /\[runtime\] Could not start .+: posix_spawnp failed\.\n/,
    );
  });

  it('refuses to install over a Harness while it runs', async () => {
    await install('fixture-term');
    const launchId = await launch('acme/fixture-term');
    await waitForState(launchId, 'ready');
    await expect(
      call('installs.installFromFolder', join(FIXTURES, 'fixture-term')),
    ).resolves.toMatchObject({ ok: false, error: { code: 'harness_running' } });
  });
});

describe('launch records and logs', () => {
  it('closes the launches a crash of the app left open at the next start', async () => {
    await runtime.shutdown();
    const db = new DatabaseSync(join(userData, 'harness-store.sqlite'));
    db.prepare(
      `INSERT INTO launches (launch_id, harness_id, version, started_at)
       VALUES ('crashed', 'acme/fixture-term', '1.0.0', '2026-10-27T09:00:00.000Z')`,
    ).run();
    db.close();

    runtime = await start();
    expect(launchRows()).toMatchObject([
      { launch_id: 'crashed', exit_code: null, ended_at: expect.any(String) as unknown },
    ]);
    const [row] = launchRows();
    expect(row?.token_revoked_at).toBe(row?.ended_at);
  });

  // On Windows node-pty reports each exit a second after it, once it flushed ConPTY's output.
  it('keeps the 20 newest launch logs of a Harness', async () => {
    await install('fixture-crash');
    const logs = join(userData, 'logs', 'acme', 'fixture-crash');
    for (let index = 0; index < 21; index += 1) {
      const launchId = await launch('acme/fixture-crash');
      await waitForState(launchId, 'failed');
    }
    expect(readdirSync(logs)).toHaveLength(20);
  }, 60_000);
});
