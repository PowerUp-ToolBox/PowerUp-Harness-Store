import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createHarnessWindowHandlers } from '../../src/main/runtime/harness-window-handlers.js';
import { spawnPiped } from '../../src/main/runtime/piped-process.js';
import type { HarnessWindows, WebWindowSpec } from '../../src/main/runtime/supervisor.js';
import { freePort } from '../../src/main/runtime/web-port.js';
import type { WebContentArea } from '../../src/shared/harness-ipc.js';
import type { IpcEventName, IpcEvents, IpcResult, LaunchStatus } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';
import { removeFolder, WAIT_MS } from '../support/harness-processes.js';

/**
 * Ticket P0-05.3, launching a web Harness, through the Supervisor seam: the real Runtime with its
 * SQLite file in a temp app data root, the real Model Gateway, fixture Harnesses installed from
 * their folders and run for real with their output piped (under this test's Node), the readiness
 * probe for real, and the Harness windows faked. The fake records when the Harness's page would be
 * shown in its window; that the page then reaches neither Node nor Electron IPC is a property of
 * the window options (main-window.test.ts) and was checked by hand in Electron.
 *
 * The signal tests run on macOS and Linux only: Windows has no signals (the Supervisor uses
 * taskkill there; the stop and launch tests run on windows-latest in CI).
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/harnesses');
const PLATFORM = `${process.platform}-${process.arch}`;
const MAIN_WINDOW = {};

let root: string;
let userData: string;
let signalFile: string;
let fake: FakeProvider;
let runtime: Runtime;
let windows: ReturnType<typeof createFakeWindows>;
/** Every launch state, with when it was emitted. */
let states: (LaunchStatus & { at: number })[];
/** Variables the next Harnesses inherit on top of this process's. */
let extraEnv: Record<string, string>;
let opened: string[];
/** When set, starting the process fails with it, after the Runtime issued the launch's token. */
let spawnFailure: Error | undefined;
/** When the Runtime began starting each process: none of a Harness's own timers runs before. */
let spawnedAt: number[];
/** Whether the Harness's port accepted a connection right when its launch reported `ready`. */
let acceptedWhenReady: Promise<boolean>[];
/** When set, the OS's answers when the Runtime asks for a free port; the real ones otherwise. */
let askPort: (() => Promise<number>) | undefined;
/** When set, showing a Harness's page in its window throws it. */
let showWebFailure: Error | undefined;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-web-'));
  userData = join(root, 'userData');
  signalFile = join(root, 'signals.txt');
  fake = await startFakeProvider({ aliases: { 'model-a': 'fake/echo' } });
  states = [];
  extraEnv = {};
  opened = [];
  spawnFailure = undefined;
  spawnedAt = [];
  acceptedWhenReady = [];
  askPort = undefined;
  showWebFailure = undefined;
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
      if (event !== 'launch.state') return;
      const status = payload as LaunchStatus;
      states.push({ ...status, at: Date.now() });
      if (status.state === 'ready') {
        const port = windows.shown.get(status.launchId)?.port;
        acceptedWhenReady.push(port === undefined ? Promise.resolve(false) : accepts(port));
      }
    },
    harnessWindows: windows,
    spawnPty: () => {
      throw new Error('No pty in these tests');
    },
    spawnProcess: (options) => {
      spawnedAt.push(Date.now());
      return spawnFailure === undefined ? spawnPiped(options) : Promise.reject(spawnFailure);
    },
    freePort: () => (askPort ?? freePort)(),
    harnessEnvironment: () => ({
      ...process.env,
      OPENAI_API_KEY: 'sk-parent-openai',
      ANTHROPIC_API_KEY: 'sk-ant-parent',
      HARNESS_PORT: '1',
      FIXTURE_SIGNAL_FILE: signalFile,
      ...extraEnv,
    }),
    openPath: (path) => {
      opened.push(path);
      return Promise.resolve(true);
    },
  });
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
 * Harness windows without Electron: records the web windows opened, the Harness pages shown in
 * them (with when), and what main asks of those pages. `close` closes a window as Electron does
 * (its `closed` event).
 */
function createFakeWindows() {
  const open = new Map<string, () => void>();
  const specs: WebWindowSpec[] = [];
  const shown = new Map<string, { url: string; port: number; at: number }>();
  const hidden: string[] = [];
  const reloaded: string[] = [];
  const layouts: { launchId: string; area: WebContentArea }[] = [];
  const focused: string[] = [];
  const fakes = {
    open,
    specs,
    shown,
    hidden,
    reloaded,
    layouts,
    focused,
    openTerminal() {
      throw new Error('No terminal window in these tests');
    },
    openWeb(spec, onClosed) {
      specs.push(spec);
      open.set(spec.launchId, onClosed);
    },
    showWeb(launchId, url) {
      if (showWebFailure !== undefined) throw showWebFailure;
      shown.set(launchId, { url, port: Number(new URL(url).port), at: Date.now() });
    },
    hideWeb(launchId) {
      hidden.push(launchId);
    },
    reloadWeb(launchId) {
      reloaded.push(launchId);
    },
    layoutWeb(launchId, area) {
      layouts.push({ launchId, area });
    },
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

/** Whether 127.0.0.1:<port> accepts a TCP connection now. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const statesOf = (launchId: string) => states.filter((each) => each.launchId === launchId);
const lastState = (launchId: string) => statesOf(launchId).at(-1);
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

/** The port of the page shown for `launchId`. */
function portOf(launchId: string): number {
  const shown = windows.shown.get(launchId);
  if (shown === undefined) throw new Error('No page was shown');
  return shown.port;
}

/** What fixture-web serves at `path` for `launchId`. */
async function served(launchId: string, path: string) {
  const response = await fetch(`http://127.0.0.1:${String(portOf(launchId))}${path}`);
  return (await response.json()) as Record<string, unknown>;
}

const logPath = (slug: string, launchId: string) =>
  join(userData, 'logs', 'acme', slug, `${launchId}.log`);

describe('launching fixture-web', () => {
  it('runs it on a free port with the launch contract, and shows its page once it listens', async () => {
    await install('fixture-web');
    const launchId = await launch('acme/fixture-web');
    await waitForState(launchId, 'ready');

    // Its window opened at once, at the Manifest's size hints, on the Starting state.
    expect(windows.specs).toEqual([
      {
        launchId,
        harnessId: 'acme/fixture-web',
        name: 'Fixture Web',
        size: { width: 900, height: 600 },
      },
    ]);
    expect(statesOf(launchId).map((each) => each.state)).toEqual([
      'preparing',
      'spawning',
      'waiting-ready',
      'ready',
    ]);
    // The page was shown once the port accepted connections, and before `ready` was reported.
    const port = portOf(launchId);
    expect(windows.shown.get(launchId)?.url).toBe(`http://127.0.0.1:${String(port)}/`);
    await expect(acceptedWhenReady[0]).resolves.toBe(true);

    const { env, cwd } = (await served(launchId, '/env')) as {
      env: Record<string, string>;
      cwd: string;
    };
    const dataDir = join(userData, 'data', 'acme', 'fixture-web');
    expect(env.HARNESS_PORT).toBe(String(port));
    expect(env.HARNESS_GATEWAY_URL).toBe(gatewayUrl());
    expect(env.OPENAI_BASE_URL).toBe(gatewayUrl());
    expect(env.OPENAI_API_KEY).toBe(env.HARNESS_GATEWAY_TOKEN);
    expect(env.HARNESS_ID).toBe('acme/fixture-web');
    expect(env.HARNESS_VERSION).toBe('1.0.0');
    expect(env.HARNESS_DATA_DIR).toBe(dataDir);
    expect(env.HARNESS_LOCALE).toBe('en');
    expect(env.HARNESS_PLATFORM).toBe(PLATFORM);
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('HARNESS_WORKSPACE');
    expect(realpathSync(cwd)).toBe(realpathSync(dataDir));

    // The Gateway HTTP seam: the Harness gets a completion with its Gateway Token.
    await expect(served(launchId, '/complete')).resolves.toMatchObject({
      status: 200,
      body: { choices: [{ message: { content: 'ping' } }] },
    });

    await expect(windowCall(launchId, 'window.info')).resolves.toMatchObject({
      ok: true,
      data: { uiKind: 'web', readyTimeoutSeconds: 10, status: { state: 'ready' } },
    });
  });

  it('gives Harnesses running at once different ports', async () => {
    await install('fixture-web');
    await install('fixture-slow-ready');
    const web = await launch('acme/fixture-web');
    const slow = await launch('acme/fixture-slow-ready');
    await waitForState(web, 'ready');
    await waitForState(slow, 'ready', 8000);
    const { env } = (await served(web, '/env')) as { env: Record<string, string> };
    expect(env.HARNESS_PORT).toBe(String(portOf(web)));
    expect(portOf(slow)).not.toBe(portOf(web));
  }, 10_000);

  it('never gives two web launches preparing at once one port, though the OS offers it to both', async () => {
    await install('fixture-web');
    await install('fixture-slow-ready');
    const same = await freePort();
    let other = await freePort();
    while (other === same) other = await freePort();
    // Both launches ask before the OS answers either, and it answers both with `same`.
    const offered = [same, same, other];
    const held: (() => void)[] = [];
    askPort = () => {
      const port = offered.shift();
      if (port === undefined) return freePort();
      if (offered.length === 0) return Promise.resolve(port);
      return new Promise((resolve) => {
        held.push(() => {
          resolve(port);
        });
        if (held.length === 2) for (const answer of held) answer();
      });
    };

    const web = await launch('acme/fixture-web');
    const slow = await launch('acme/fixture-slow-ready');
    await waitForState(web, 'ready');
    await waitForState(slow, 'ready', 8000);
    expect(new Set([portOf(web), portOf(slow)])).toEqual(new Set([same, other]));
    const { env } = (await served(web, '/env')) as { env: Record<string, string> };
    expect(env.HARNESS_PORT).toBe(String(portOf(web)));
  }, 10_000);

  it('a second launch while it starts or runs focuses its window and starts nothing', async () => {
    await install('fixture-web');
    const launchId = await launch('acme/fixture-web');
    await expect(call('launch.start', { harnessId: 'acme/fixture-web' })).resolves.toEqual({
      ok: true,
      data: { outcome: 'focused', launchId },
    });
    await waitForState(launchId, 'ready');
    expect(windows.specs).toHaveLength(1);
    expect(windows.focused).toEqual([launchId]);
  });

  it('Reload reloads the page in place; the process keeps running', async () => {
    await install('fixture-web');
    const launchId = await launch('acme/fixture-web');
    await waitForState(launchId, 'ready');
    const before = (await served(launchId, '/env')) as { env: Record<string, string> };

    await expect(windowCall(launchId, 'web.reload')).resolves.toEqual({ ok: true, data: null });
    expect(windows.reloaded).toEqual([launchId]);
    expect(lastState(launchId)?.state).toBe('ready');
    // The same process, with the same Gateway Token, still answers.
    const after = (await served(launchId, '/env')) as { env: Record<string, string> };
    expect(after.env.HARNESS_GATEWAY_TOKEN).toBe(before.env.HARNESS_GATEWAY_TOKEN);
    expect(
      readFileSync(logPath('fixture-web', launchId), 'utf8').match(/\[runtime\] Started /g),
    ).toHaveLength(1);

    // Where its page goes is passed on to the window.
    const area = { x: 0, y: 44, width: 900, height: 600 };
    await windowCall(launchId, 'web.layout', area);
    expect(windows.layouts).toEqual([{ launchId, area }]);
  });

  it.skipIf(process.platform === 'win32')(
    'closing its window sends SIGTERM; it ends stopped, its token revoked, its output logged',
    async () => {
      await install('fixture-web');
      const launchId = await launch('acme/fixture-web');
      await waitForState(launchId, 'ready');
      const { env } = (await served(launchId, '/env')) as { env: Record<string, string> };

      windows.close(launchId);
      await waitForState(launchId, 'stopped');
      expect(statesOf(launchId).map((each) => each.state)).toEqual([
        'preparing',
        'spawning',
        'waiting-ready',
        'ready',
        'stopping',
        'stopped',
      ]);
      expect(lastState(launchId)).toMatchObject({ exitCode: 0 });
      expect(readFileSync(signalFile, 'utf8')).toBe('SIGTERM\n');
      const rejected = await fetch(`${gatewayUrl()}/harness/context`, {
        headers: { authorization: `Bearer ${env.HARNESS_GATEWAY_TOKEN ?? ''}` },
      });
      expect(rejected.status).toBe(401);
      expect(launchRows()).toMatchObject([{ launch_id: launchId, exit_code: 0 }]);

      const log = readFileSync(logPath('fixture-web', launchId), 'utf8');
      const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[(out|err|runtime)\] /;
      expect(
        log
          .split('\n')
          .filter(Boolean)
          .every((line) => stamp.test(line)),
      ).toBe(true);
      expect(log).toMatch(/\[runtime\] Started .+ \(pid \d+\), port \d+\n/);
      expect(log).toMatch(/\[out\] fixture-web: listening on 127\.0\.0\.1:\d+\n/);
      expect(log).toMatch(/\[runtime\] Accepting connections on 127\.0\.0\.1:\d+\n/);
      expect(log).toMatch(/\[runtime\] Exited with code 0\n/);
      expect(log).not.toContain(env.HARNESS_GATEWAY_TOKEN ?? 'no token');
    },
  );

  it('a Harness that exits on its own once ready shows Crashed: its page is taken away', async () => {
    await install('fixture-web');
    const launchId = await launch('acme/fixture-web');
    await waitForState(launchId, 'ready');
    await fetch(`http://127.0.0.1:${String(portOf(launchId))}/exit/3`);

    await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
      reason: 'exit_nonzero',
      exitCode: 3,
    });
    expect(windows.hidden).toEqual([launchId]);
    // The window stays, for its Crashed state; Show logs opens this launch's log.
    expect(windows.open.has(launchId)).toBe(true);
    await windowCall(launchId, 'window.openLogs');
    expect(opened).toEqual([logPath('fixture-web', launchId)]);
    // Reload no longer applies.
    await windowCall(launchId, 'web.reload');
    expect(windows.reloaded).toEqual([]);
  });

  it('a Harness that exits with code 0 on its own once ready ends stopped, not failed', async () => {
    await install('fixture-web');
    const launchId = await launch('acme/fixture-web');
    await waitForState(launchId, 'ready');
    await fetch(`http://127.0.0.1:${String(portOf(launchId))}/exit/0`);

    const stopped = await waitForState(launchId, 'stopped');
    expect(stopped).toMatchObject({ exitCode: 0 });
    expect(stopped).not.toHaveProperty('reason');
    expect(statesOf(launchId).map((each) => each.state)).toEqual([
      'preparing',
      'spawning',
      'waiting-ready',
      'ready',
      'stopped',
    ]);
    // Its page is taken away; the window stays on its exit code (the page says it exited).
    expect(windows.hidden).toEqual([launchId]);
    expect(windows.open.has(launchId)).toBe(true);
    expect(launchRows()).toMatchObject([{ launch_id: launchId, exit_code: 0 }]);
  });

  it.skipIf(process.platform === 'win32')(
    'a Harness that exits on its own leaving a process it started running gets that one stopped',
    async () => {
      await install('fixture-web');
      const launchId = await launch('acme/fixture-web');
      await waitForState(launchId, 'ready');
      const port = portOf(launchId);
      await fetch(`http://127.0.0.1:${String(port)}/handoff/3`);
      const helperPid = await waitFor(() => {
        const found = /FIXTURE helper (\d+)/.exec(
          readFileSync(logPath('fixture-web', launchId), 'utf8'),
        );
        return found === null ? undefined : Number(found[1]);
      });
      try {
        // The helper ends by SIGTERM; the launch keeps the end its own exit gave it.
        await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
          reason: 'exit_nonzero',
          exitCode: 3,
        });
        expect(statesOf(launchId).map((each) => each.state)).toEqual([
          'preparing',
          'spawning',
          'waiting-ready',
          'ready',
          'stopping',
          'failed',
        ]);
        expect(isAlive(helperPid)).toBe(false);
        await expect(accepts(port)).resolves.toBe(false);
        const log = readFileSync(logPath('fixture-web', launchId), 'utf8');
        expect(log).toMatch(
          /\[runtime\] Exited with code 3\n.*\[runtime\] Processes it started are still running\n.*\[runtime\] Sent SIGTERM to \d+ and its children\n/,
        );
        expect(launchRows()).toMatchObject([{ launch_id: launchId, exit_code: 3 }]);
        expect(windows.open.has(launchId)).toBe(true);
      } finally {
        if (isAlive(helperPid)) process.kill(helperPid, 'SIGKILL');
      }
    },
  );
});

/** Whether a process with this pid still runs (signal 0 only checks). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('waiting for the port', () => {
  it('fixture-slow-ready, listening after 2 s, gets ready within its 5 s', async () => {
    await install('fixture-slow-ready');
    const launchId = await launch('acme/fixture-slow-ready');
    const ready = await waitForState(launchId, 'ready', 8000);
    // Measured from the spawn, not from `waiting-ready`: the process runs, and its 2 s timer
    // counts, from the spawn, while `waiting-ready` comes only once the Runtime's event loop has
    // taken the spawn event, which a busy machine delays by hundreds of milliseconds.
    expect(ready.at - (spawnedAt[0] ?? Infinity)).toBeGreaterThanOrEqual(2000);
    expect(statesOf(launchId).map((each) => each.state)).not.toContain('failed');

    // Ready, and its page shown, only after the Harness began accepting connections.
    const listening = await waitFor(() => {
      const found = /FIXTURE listening (\d+)/.exec(
        readFileSync(logPath('fixture-slow-ready', launchId), 'utf8'),
      );
      return found === null ? undefined : Number(found[1]);
    });
    expect(windows.shown.get(launchId)?.at).toBeGreaterThanOrEqual(listening);
    expect(ready.at).toBeGreaterThanOrEqual(listening);
    await expect(acceptedWhenReady[0]).resolves.toBe(true);
  }, 10_000);

  it.skipIf(process.platform === 'win32')(
    'fixture-hang, which never listens, fails ready_timeout at its 5 s with its last 50 log lines',
    async () => {
      await install('fixture-hang');
      const launchId = await launch('acme/fixture-hang');
      const failed = await waitForState(launchId, 'failed', 10_000);
      const waiting = statesOf(launchId).find((each) => each.state === 'waiting-ready');
      const stopping = statesOf(launchId).find((each) => each.state === 'stopping');
      // The timeout runs from `waiting-ready`, by the same clock; polling every 250 ms adds a little.
      const timedOutAfter = (stopping?.at ?? 0) - (waiting?.at ?? 0);
      expect(timedOutAfter).toBeGreaterThanOrEqual(4900);
      expect(timedOutAfter).toBeLessThan(5600);
      // It exits on SIGTERM: the shutdown sequence stops it at once.
      expect(failed.at - (stopping?.at ?? 0)).toBeLessThan(1000);

      expect(failed).toMatchObject({ reason: 'ready_timeout', exitCode: 143 });
      const tail = failed.logTail ?? [];
      expect(tail).toHaveLength(50);
      expect(tail).toContainEqual(expect.stringMatching(/ \[out\] fixture-hang: line 60$/));
      expect(tail).toContainEqual(
        expect.stringMatching(/ \[err\] fixture-hang: not listening on purpose$/),
      );
      expect(tail).toContainEqual(
        expect.stringMatching(
          / \[runtime\] Did not accept connections on 127\.0\.0\.1:\d+ within 5 s$/,
        ),
      );
      expect(tail.at(-1)).toMatch(/ \[runtime\] Ended by signal 15 \(code 143\)$/);
      // The window never showed a page, and stays on the Timed-out state; the window learns it
      // with launch.status too.
      expect(windows.shown.has(launchId)).toBe(false);
      expect(windows.open.has(launchId)).toBe(true);
      await expect(windowCall(launchId, 'window.info')).resolves.toMatchObject({
        ok: true,
        data: { status: { state: 'failed', reason: 'ready_timeout', logTail: tail } },
      });
      const [row] = launchRows();
      expect(row).toMatchObject({ launch_id: launchId, exit_code: 143 });
      expect(row?.token_revoked_at).toBe(row?.ended_at);
    },
    12_000,
  );

  it.skipIf(process.platform === 'win32')(
    'Cancel while it starts (closing the window) ends it stopped, not failed',
    async () => {
      await install('fixture-hang');
      const launchId = await launch('acme/fixture-hang');
      await waitForState(launchId, 'waiting-ready');
      windows.close(launchId);
      await waitForState(launchId, 'stopped');
      expect(statesOf(launchId).map((each) => each.state)).toEqual([
        'preparing',
        'spawning',
        'waiting-ready',
        'stopping',
        'stopped',
      ]);
      expect(windows.shown.has(launchId)).toBe(false);
      expect(launchRows()).toMatchObject([{ launch_id: launchId, exit_code: 143 }]);
    },
  );

  it('a Harness that exits before it listens shows Crashed with its exit code', async () => {
    extraEnv = { FIXTURE_EXIT_CODE: '3' };
    await install('fixture-hang');
    const launchId = await launch('acme/fixture-hang');
    await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
      reason: 'exit_nonzero',
      exitCode: 3,
    });
    expect(lastState(launchId)).not.toHaveProperty('logTail');
    expect(windows.shown.has(launchId)).toBe(false);
    expect(windows.open.has(launchId)).toBe(true);
    expect(readFileSync(logPath('fixture-hang', launchId), 'utf8')).toMatch(
      /\[err\] fixture-hang: not listening on purpose\n(.*\n)*.*\[runtime\] Exited with code 3\n/,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'an error once its process started stops the process before the launch ends spawn_error',
    async () => {
      await install('fixture-web');
      showWebFailure = new Error('The page could not be shown');
      const launchId = await launch('acme/fixture-web');
      await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
        reason: 'spawn_error',
        exitCode: 0,
      });
      expect(statesOf(launchId).map((each) => each.state)).toEqual([
        'preparing',
        'spawning',
        'waiting-ready',
        'stopping',
        'failed',
      ]);
      // The shutdown sequence ran: nothing keeps the port, and a new launch may start.
      expect(readFileSync(signalFile, 'utf8')).toBe('SIGTERM\n');
      const log = readFileSync(logPath('fixture-web', launchId), 'utf8');
      expect(log).toMatch(/\[runtime\] Could not start: The page could not be shown\n/);
      const port = Number(/\(pid \d+\), port (\d+)\n/.exec(log)?.[1]);
      await expect(accepts(port)).resolves.toBe(false);
      expect(runtime.supervisor.isRunning('acme/fixture-web')).toBe(false);
      expect(launchRows()).toMatchObject([{ launch_id: launchId, exit_code: 0 }]);
      expect(windows.open.has(launchId)).toBe(false);
    },
  );

  it('a process that cannot be started fails spawn_error and revokes its token', async () => {
    await install('fixture-web');
    spawnFailure = new Error('spawn EACCES');
    const launchId = await launch('acme/fixture-web');
    await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
      reason: 'spawn_error',
    });
    expect(lastState(launchId)).not.toHaveProperty('exitCode');
    const [row] = launchRows();
    expect(row).toMatchObject({ launch_id: launchId, exit_code: null });
    expect(row?.token_revoked_at).toBe(row?.ended_at);
    expect(readFileSync(logPath('fixture-web', launchId), 'utf8')).toMatch(
      /\[runtime\] Could not start .+: spawn EACCES\n/,
    );
    // Its window stays on Could not start.
    expect(windows.open.has(launchId)).toBe(true);
  });
});
