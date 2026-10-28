import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
import { spawnPiped, type PipedSpawnOptions } from '../../src/main/runtime/piped-process.js';
import { spawnNodePty, type PtySpawnOptions } from '../../src/main/runtime/pty.js';
import type { HarnessWindows, WebWindowSpec } from '../../src/main/runtime/supervisor.js';
import type { HarnessWindowEventName } from '../../src/shared/harness-ipc.js';
import type { IpcEventName, IpcEvents, IpcResult, LaunchStatus } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';

/**
 * Ticket P0-05.5, the binary runtime kind, through the Supervisor seam: the real Runtime with its
 * SQLite file in a temp app data root, the real Model Gateway, and the binary fixture Harnesses
 * installed from a copy of their folders whose Entry lacks the executable bit, then run for real
 * (terminal ones in a pty, web ones with piped output and the real readiness probe), with the
 * Harness windows faked as in terminal-launch.test.ts and web-launch.test.ts.
 *
 * A fixture's Entry is a POSIX `sh` script standing in for a native executable, which `exec`s this
 * test's Node on the matching Node fixture's script; so the Runtime runs the Entry itself, and what
 * the script reports is what the "binary" got. Windows has no executable bit and no `sh`: these
 * tests run on macOS and Linux only.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/harnesses');
const PLATFORM = `${process.platform}-${process.arch}`;
const MAIN_WINDOW = {};
const SIZE = { cols: 100, rows: 30 };

let root: string;
let userData: string;
let signalFile: string;
let fake: FakeProvider;
let runtime: Runtime;
let windows: ReturnType<typeof createFakeWindows>;
let states: LaunchStatus[];
let spawned: (PtySpawnOptions | PipedSpawnOptions)[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-binary-'));
  userData = join(root, 'userData');
  signalFile = join(root, 'signals.txt');
  fake = await startFakeProvider({ aliases: { 'model-a': 'fake/echo' } });
  states = [];
  spawned = [];
  windows = createFakeWindows();
  // The parent's environment, without a variable that would make this test's Node act otherwise.
  const inherited: Record<string, string | undefined> = { ...process.env };
  delete inherited.ELECTRON_RUN_AS_NODE;
  runtime = await startRuntime({
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
      return spawnNodePty(options);
    },
    spawnProcess: (options) => {
      spawned.push(options);
      return spawnPiped(options);
    },
    harnessEnvironment: () => ({
      ...inherited,
      OPENAI_API_KEY: 'sk-parent-openai',
      ANTHROPIC_API_KEY: 'sk-ant-parent',
      GEMINI_API_KEY: 'parent-gemini',
      HARNESS_WORKSPACE: '/parent/workspace',
      HARNESS_PORT: '1',
      FIXTURE_SIGNAL_FILE: signalFile,
      FIXTURE_NODE: process.execPath,
      FIXTURE_HARNESSES: FIXTURES,
    }),
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
  rmSync(root, { recursive: true, force: true });
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
 * Harness windows of both UI Kinds without Electron: a terminal window's page reports its terminal
 * ready at once; a web window records the Harness page shown in it. `close` closes a window as
 * Electron does (its `closed` event).
 */
function createFakeWindows() {
  const open = new Map<string, () => void>();
  const sent: { launchId: string; event: HarnessWindowEventName; payload: unknown }[] = [];
  const terminals: string[] = [];
  const webs: WebWindowSpec[] = [];
  const shown = new Map<string, string>();
  const fakes = {
    sent,
    terminals,
    webs,
    shown,
    openTerminal(spec, onClosed) {
      terminals.push(spec.launchId);
      open.set(spec.launchId, onClosed);
      queueMicrotask(() => void windowCall(spec.launchId, 'terminal.ready', SIZE));
    },
    openWeb(spec, onClosed) {
      webs.push(spec);
      open.set(spec.launchId, onClosed);
    },
    showWeb(launchId, url) {
      shown.set(launchId, url);
    },
    hideWeb: () => undefined,
    reloadWeb: () => undefined,
    layoutWeb: () => undefined,
    send(launchId, event, payload) {
      if (open.has(launchId)) sent.push({ launchId, event, payload });
    },
    focus: (launchId) => open.has(launchId),
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

const statesOf = (launchId: string) => states.filter((each) => each.launchId === launchId);
const waitForState = (launchId: string, state: LaunchStatus['state'], timeoutMs?: number) =>
  waitFor(() => {
    const last = statesOf(launchId).at(-1);
    return last?.state === state ? last : undefined;
  }, timeoutMs);

/**
 * A copy of the fixture's folder under the temp root, its Entry without the executable bit (as a
 * package zipped on Windows has it), its Manifest changed by `edit` when given.
 */
function fixtureCopy(fixture: string, edit?: (manifest: Record<string, unknown>) => void) {
  const folder = join(root, 'packages', fixture);
  cpSync(join(FIXTURES, fixture), folder, { recursive: true });
  chmodSync(join(folder, 'bin', fixture), 0o644);
  if (edit !== undefined) {
    const path = join(folder, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    edit(manifest);
    writeFileSync(path, JSON.stringify(manifest));
  }
  return folder;
}

async function install(folder: string) {
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
  const { gateway } = runtime.services.diagnostics.get();
  if (!gateway.running) throw new Error('The Model Gateway is not running');
  return `http://127.0.0.1:${String(gateway.port)}/v1`;
}

/** `GET /v1/harness/context` with `token`: its status and body. */
async function context(token: string) {
  const response = await fetch(`${gatewayUrl()}/harness/context`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The values of fixture-term's `FIXTURE <kind> <json>` lines printed in full so far. */
function reports(launchId: string, kind: string): unknown[] {
  return windows.sent
    .filter((each) => each.launchId === launchId && each.event === 'terminal.data')
    .map((each) => each.payload as string)
    .join('')
    .split('\n')
    .slice(0, -1)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith(`FIXTURE ${kind} `))
    .map((line) => JSON.parse(line.slice(`FIXTURE ${kind} `.length)) as unknown);
}

/**
 * Expects `env` to be exactly the launch contract's for `harnessId` (docs/tech/architecture.md
 * §4), as P0-05.2's tests check it for a Node Harness, but without `ELECTRON_RUN_AS_NODE`: nothing
 * of the User's own credentials, nor a `HARNESS_` variable the Runtime did not set.
 */
function expectContract(env: Record<string, string>, harnessId: string) {
  const dataDir = join(userData, 'data', ...harnessId.split('/'));
  expect(env.HARNESS_GATEWAY_URL).toBe(gatewayUrl());
  expect(env.HARNESS_GATEWAY_TOKEN).toMatch(/^[\w-]{20,}$/);
  expect(env.OPENAI_BASE_URL).toBe(gatewayUrl());
  expect(env.OPENAI_API_KEY).toBe(env.HARNESS_GATEWAY_TOKEN);
  expect(env.HARNESS_ID).toBe(harnessId);
  expect(env.HARNESS_VERSION).toBe('1.0.0');
  expect(env.HARNESS_DATA_DIR).toBe(dataDir);
  expect(env.HARNESS_LOCALE).toBe('zh-CN');
  expect(env.HARNESS_PLATFORM).toBe(PLATFORM);
  for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HARNESS_WORKSPACE']) {
    expect(env, name).not.toHaveProperty(name);
  }
  // A binary Harness is not run on the Runtime's Node, so it is not told to act as Node.
  expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  expect(env.FIXTURE_SIGNAL_FILE).toBe(signalFile);
}

describe.skipIf(process.platform === 'win32')('launching a binary Harness', () => {
  it('fixture-binary-term: its Entry made executable at install, run directly in a pty with the launch contract', async () => {
    await install(fixtureCopy('fixture-binary-term'));
    const installed = join(userData, 'harnesses', 'acme', 'fixture-binary-term', '1.0.0');
    const entry = join(installed, 'bin', 'fixture-binary-term');
    expect(statSync(entry).mode & 0o777).toBe(0o755);

    const launchId = await launch('acme/fixture-binary-term');
    const [started] = (await waitFor(() => {
      const found = reports(launchId, 'start');
      return found.length > 0 ? found : undefined;
    })) as [{ env: Record<string, string>; cwd: string; size: number[] }];
    const dataDir = join(userData, 'data', 'acme', 'fixture-binary-term');
    expectContract(started.env, 'acme/fixture-binary-term');
    expect(started.env).not.toHaveProperty('HARNESS_PORT');
    expect(started.env.TERM).toBe('xterm-256color');
    expect(realpathSync(started.cwd)).toBe(realpathSync(dataDir));
    expect(started.size).toEqual([SIZE.cols, SIZE.rows]);

    // The Entry itself, with no Node in front of it.
    expect(spawned).toEqual([expect.objectContaining({ file: entry, args: [], cwd: dataDir })]);
    expect(windows.terminals).toEqual([launchId]);
    expect(statesOf(launchId).map((each) => each.state)).toEqual([
      'preparing',
      'spawning',
      'ready',
    ]);
    const token = started.env.HARNESS_GATEWAY_TOKEN ?? '';
    await expect(context(token)).resolves.toMatchObject({
      status: 200,
      body: { harnessId: 'acme/fixture-binary-term', version: '1.0.0', locale: 'zh-CN' },
    });

    // The same shutdown sequence: SIGTERM reaches the program the Entry became.
    windows.close(launchId);
    await expect(waitForState(launchId, 'stopped')).resolves.toMatchObject({ exitCode: 0 });
    expect(readFileSync(signalFile, 'utf8')).toBe('SIGTERM\n');
    await expect(context(token)).resolves.toMatchObject({ status: 401 });
    expect(launchRows()).toMatchObject([
      { launch_id: launchId, harness_id: 'acme/fixture-binary-term', exit_code: 0 },
    ]);
  });

  it('fixture-binary-web: run directly with its output piped, its page shown once its port is ready', async () => {
    await install(fixtureCopy('fixture-binary-web'));
    const entry = join(
      userData,
      'harnesses',
      'acme',
      'fixture-binary-web',
      '1.0.0',
      'bin',
      'fixture-binary-web',
    );
    expect(statSync(entry).mode & 0o777).toBe(0o755);

    const launchId = await launch('acme/fixture-binary-web');
    await waitForState(launchId, 'ready');
    expect(statesOf(launchId).map((each) => each.state)).toEqual([
      'preparing',
      'spawning',
      'waiting-ready',
      'ready',
    ]);
    expect(windows.webs).toMatchObject([{ launchId, size: { width: 900, height: 600 } }]);
    const url = windows.shown.get(launchId) ?? '';
    const port = Number(new URL(url).port);
    expect(url).toBe(`http://127.0.0.1:${String(port)}/`);

    const response = await fetch(new URL('/env', url));
    const { env, cwd } = (await response.json()) as { env: Record<string, string>; cwd: string };
    const dataDir = join(userData, 'data', 'acme', 'fixture-binary-web');
    expectContract(env, 'acme/fixture-binary-web');
    expect(env.HARNESS_PORT).toBe(String(port));
    expect(realpathSync(cwd)).toBe(realpathSync(dataDir));
    expect(spawned).toEqual([expect.objectContaining({ file: entry, args: [], cwd: dataDir })]);

    windows.close(launchId);
    await expect(waitForState(launchId, 'stopped')).resolves.toMatchObject({ exitCode: 0 });
    expect(readFileSync(signalFile, 'utf8')).toBe('SIGTERM\n');
  });

  it('an Entry with no key for this platform fails platform_unsupported, spawning nothing', async () => {
    // Another platform only: it installs (its card says it is not available here) but never runs.
    const other = PLATFORM === 'linux-x64' ? 'darwin-arm64' : 'linux-x64';
    await install(
      fixtureCopy('fixture-binary-term', (manifest) => {
        manifest.platforms = [other];
        manifest.entry = { [other]: 'bin/fixture-binary-term' };
      }),
    );
    await expect(call('installs.list')).resolves.toMatchObject({
      ok: true,
      data: [{ harnessId: 'acme/fixture-binary-term', platformSupported: false }],
    });

    const launchId = await launch('acme/fixture-binary-term');
    await expect(waitForState(launchId, 'failed')).resolves.toMatchObject({
      reason: 'platform_unsupported',
    });
    expect(spawned).toEqual([]);
    expect(windows.terminals).toEqual([]);
    expect(launchRows()).toEqual([]);
  });
});
