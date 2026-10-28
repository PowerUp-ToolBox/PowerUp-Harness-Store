import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
import type { HarnessWindows } from '../../src/main/runtime/supervisor.js';
import type { IpcEventName, IpcEvents, IpcResult, LaunchStatus } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';

/**
 * Ticket P0-05.4, the Workspace, through the Supervisor seam: the real Runtime with its SQLite
 * file in a temp app data root and the real Model Gateway, the three fixture Harnesses that differ
 * only in their Manifest's `workspace` installed from their folders and run for real in a pty, the
 * Harness windows faked. The folder picker is faked too: it records the folder it opens at and
 * answers the folder the test chose, or null for Cancel. The Workspace the User chose (or not)
 * reaches `launch.start` as its `workspace`, as the main window's Workspace sheet sends it.
 */

const FIXTURES = join(import.meta.dirname, '../fixtures/harnesses');
const PLATFORM = `${process.platform}-${process.arch}`;
const MAIN_WINDOW = {};
const SIZE = { cols: 100, rows: 30 };

let root: string;
let userData: string;
let project: string;
let fake: FakeProvider;
let runtime: Runtime;
let windows: ReturnType<typeof createFakeWindows>;
let states: LaunchStatus[];
let spawned: PtySpawnOptions[];
/** The folder each opening of the picker started at. */
let pickerOpenedAt: (string | null | undefined)[];
/** What the picker answers: a folder, or null for Cancel. */
let picked: string | null;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-workspace-'));
  userData = join(root, 'userData');
  project = join(root, 'project');
  mkdirSync(project);
  fake = await startFakeProvider({ aliases: { 'model-a': 'fake/echo' } });
  states = [];
  spawned = [];
  pickerOpenedAt = [];
  picked = null;
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
    // A Workspace of the parent never reaches a Harness.
    harnessEnvironment: () => ({ ...process.env, HARNESS_WORKSPACE: '/parent/workspace' }),
    pickFolder: (defaultPath) => {
      pickerOpenedAt.push(defaultPath);
      return Promise.resolve(picked);
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

/** Terminal windows whose page reports its size at once, recording what main sends them. */
function createFakeWindows() {
  const open = new Map<string, () => void>();
  const sent: { launchId: string; event: string; payload: unknown }[] = [];
  const opens: string[] = [];
  const fakes = {
    sent,
    opens,
    openTerminal(spec, onClosed) {
      opens.push(spec.launchId);
      open.set(spec.launchId, onClosed);
      queueMicrotask(() => void windowCall(spec.launchId, 'terminal.ready', SIZE));
    },
    openWeb() {
      throw new Error('No web window in these tests');
    },
    showWeb: () => undefined,
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

interface WorkspaceReport {
  readonly cwd: string;
  readonly hasWorkspace: boolean;
  readonly workspace: string | null;
}

/** What the fixture of `launchId` printed about its working directory and Workspace. */
function report(launchId: string): Promise<WorkspaceReport> {
  return waitFor(() => {
    const line = windows.sent
      .filter((each) => each.launchId === launchId && each.event === 'terminal.data')
      .map((each) => each.payload as string)
      .join('')
      .split('\n')
      .slice(0, -1)
      .map((each) => each.replace(/\r$/, ''))
      .find((each) => each.startsWith('FIXTURE workspace '));
    return line === undefined
      ? undefined
      : (JSON.parse(line.slice('FIXTURE workspace '.length)) as WorkspaceReport);
  });
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
const waitForState = (launchId: string, state: LaunchStatus['state']) =>
  waitFor(() => {
    const last = lastState(launchId);
    return last?.state === state ? last : undefined;
  });

async function install(kind: 'required' | 'optional' | 'none'): Promise<string> {
  await expect(
    call('installs.installFromFolder', join(FIXTURES, `fixture-workspace-${kind}`)),
  ).resolves.toMatchObject({ ok: true });
  return `acme/fixture-workspace-${kind}`;
}

/** `launch.start` as the Workspace sheet sends it; the launch's id. */
async function launch(harnessId: string, workspace?: string | null): Promise<string> {
  const result = (await call(
    'launch.start',
    workspace === undefined ? { harnessId } : { harnessId, workspace },
  )) as IpcResult<{ outcome: string; launchId: string }>;
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.outcome).toBe('started');
  return result.data.launchId;
}

const dataDir = (harnessId: string) => join(userData, 'data', ...harnessId.split('/'));

function launchRows() {
  const db = new DatabaseSync(join(userData, 'harness-store.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM launches').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** `GET /v1/harness/context` with the Gateway Token the launch spawned `index`-th got. */
async function context(index = 0) {
  const port = runtime.gatewayPort();
  if (port === null) throw new Error('The Model Gateway is not running');
  const response = await fetch(`http://127.0.0.1:${String(port)}/v1/harness/context`, {
    headers: { authorization: `Bearer ${spawned[index]?.env.HARNESS_GATEWAY_TOKEN ?? ''}` },
  });
  return (await response.json()) as Record<string, unknown>;
}

describe('a Harness that requires a Workspace', () => {
  it('fails workspace_cancelled without one: no process, window, token or launches row', async () => {
    const harnessId = await install('required');
    // Cancel in the picker: the folder the sheet sends is null.
    await expect(call('launch.chooseWorkspace', harnessId)).resolves.toEqual({
      ok: true,
      data: null,
    });
    const cancelled = await launch(harnessId, null);
    await expect(waitForState(cancelled, 'failed')).resolves.toMatchObject({
      reason: 'workspace_cancelled',
    });
    const absent = await launch(harnessId);
    await expect(waitForState(absent, 'failed')).resolves.toMatchObject({
      reason: 'workspace_cancelled',
    });

    expect(states.map((each) => each.state)).toEqual([
      'preparing',
      'failed',
      'preparing',
      'failed',
    ]);
    expect(spawned).toEqual([]);
    expect(windows.opens).toEqual([]);
    expect(launchRows()).toEqual([]);
    await expect(call('launch.lastWorkspace', harnessId)).resolves.toEqual({
      ok: true,
      data: null,
    });
  });

  it('runs in the chosen folder, with HARNESS_WORKSPACE and the token bound to it', async () => {
    const harnessId = await install('required');
    picked = project;
    await expect(call('launch.chooseWorkspace', harnessId)).resolves.toEqual({
      ok: true,
      data: project,
    });
    // The first time, the picker opens wherever the OS likes.
    expect(pickerOpenedAt).toEqual([null]);

    const launchId = await launch(harnessId, project);
    const reported = await report(launchId);
    expect(reported).toEqual({
      cwd: expect.any(String) as unknown,
      hasWorkspace: true,
      workspace: project,
    });
    expect(realpathSync(reported.cwd)).toBe(realpathSync(project));
    expect(spawned[0]).toMatchObject({ cwd: project, env: { HARNESS_WORKSPACE: project } });
    expect(spawned[0]?.env.HARNESS_DATA_DIR).toBe(dataDir(harnessId));
    await expect(context()).resolves.toMatchObject({ harnessId, workspace: project });
    await expect(call('launch.lastWorkspace', harnessId)).resolves.toEqual({
      ok: true,
      data: { path: project, exists: true },
    });
  });

  it('offers the last folder again on the next launch, and Relaunch reuses it', async () => {
    const harnessId = await install('required');
    const first = await launch(harnessId, project);
    await report(first);
    windows.close(first);
    await waitForState(first, 'stopped');

    // The next launch: the sheet shows the last folder, and the picker opens there.
    await expect(call('launch.lastWorkspace', harnessId)).resolves.toEqual({
      ok: true,
      data: { path: project, exists: true },
    });
    await call('launch.chooseWorkspace', harnessId);
    expect(pickerOpenedAt).toEqual([project]);

    // Relaunch from the Harness window asks nothing and keeps the Workspace.
    await expect(windowCall(first, 'window.relaunch')).resolves.toEqual({ ok: true, data: null });
    const second = await waitFor(() => states.find((each) => each.launchId !== first)?.launchId);
    await expect(report(second)).resolves.toMatchObject({ hasWorkspace: true, workspace: project });
    expect(pickerOpenedAt).toEqual([project]);
  });

  it('says when the last folder is gone, and the picker then opens wherever the OS likes', async () => {
    const harnessId = await install('required');
    const launchId = await launch(harnessId, project);
    await report(launchId);
    windows.close(launchId);
    await waitForState(launchId, 'stopped');
    rmSync(project, { recursive: true });

    await expect(call('launch.lastWorkspace', harnessId)).resolves.toEqual({
      ok: true,
      data: { path: project, exists: false },
    });
    await call('launch.chooseWorkspace', harnessId);
    expect(pickerOpenedAt).toEqual([null]);
    // A folder that is gone is refused before anything starts, and so is Relaunch with it.
    await expect(call('launch.start', { harnessId, workspace: project })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method: 'launch.start' } },
    });
    await expect(windowCall(launchId, 'window.relaunch')).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method: 'launch.start' } },
    });
    expect(spawned).toHaveLength(1);
  });

  it('runs once when two launches with a folder arrive together: the second focuses it', async () => {
    const harnessId = await install('required');
    const results = await Promise.all([
      call('launch.start', { harnessId, workspace: project }),
      call('launch.start', { harnessId, workspace: project }),
    ]);
    const [first, second] = results as IpcResult<{ outcome: string; launchId: string }>[];
    if (!first?.ok || !second?.ok) throw new Error('A launch was refused');
    expect([first.data.outcome, second.data.outcome].sort()).toEqual(['focused', 'started']);
    expect(second.data.launchId).toBe(first.data.launchId);
    await report(first.data.launchId);
    expect(spawned).toHaveLength(1);
  });

  it('while it runs, is focused even when the folder it was sent is gone', async () => {
    const harnessId = await install('required');
    const launchId = await launch(harnessId, project);
    await report(launchId);
    await expect(
      call('launch.start', { harnessId, workspace: join(root, 'gone') }),
    ).resolves.toEqual({ ok: true, data: { outcome: 'focused', launchId } });
    expect(spawned).toHaveLength(1);
  });
});

describe('a Harness whose Workspace is optional', () => {
  it('runs in the chosen folder with HARNESS_WORKSPACE', async () => {
    const harnessId = await install('optional');
    const reported = await report(await launch(harnessId, project));
    expect(reported).toMatchObject({ hasWorkspace: true, workspace: project });
    expect(realpathSync(reported.cwd)).toBe(realpathSync(project));
  });

  it('skipped, runs in its Data Directory without HARNESS_WORKSPACE, keeping the last folder', async () => {
    const harnessId = await install('optional');
    const first = await launch(harnessId, project);
    await report(first);
    windows.close(first);
    await waitForState(first, 'stopped');

    // Continue without a folder.
    const skipped = await launch(harnessId, null);
    const reported = await report(skipped);
    expect(reported).toEqual({
      cwd: expect.any(String) as unknown,
      hasWorkspace: false,
      workspace: null,
    });
    expect(realpathSync(reported.cwd)).toBe(realpathSync(dataDir(harnessId)));
    expect(spawned[1]?.cwd).toBe(dataDir(harnessId));
    expect(spawned[1]?.env).not.toHaveProperty('HARNESS_WORKSPACE');
    expect(await context(1)).not.toHaveProperty('workspace');
    await expect(call('launch.lastWorkspace', harnessId)).resolves.toMatchObject({
      data: { path: project },
    });
  });
});

describe('a Harness without a Workspace', () => {
  it('never gets one: Data Directory as cwd, no HARNESS_WORKSPACE, nothing remembered', async () => {
    const harnessId = await install('none');
    // Even a folder sent along is ignored.
    const launchId = await launch(harnessId, project);
    const reported = await report(launchId);
    expect(reported).toMatchObject({ hasWorkspace: false, workspace: null });
    expect(realpathSync(reported.cwd)).toBe(realpathSync(dataDir(harnessId)));
    expect(spawned[0]?.env).not.toHaveProperty('HARNESS_WORKSPACE');
    expect(pickerOpenedAt).toEqual([]);
    await expect(call('launch.lastWorkspace', harnessId)).resolves.toEqual({
      ok: true,
      data: null,
    });
  });

  it('ignores a folder sent for it without checking it: one that is gone still launches', async () => {
    const harnessId = await install('none');
    const launchId = await launch(harnessId, join(root, 'gone'));
    const reported = await report(launchId);
    expect(reported).toMatchObject({ hasWorkspace: false, workspace: null });
    expect(realpathSync(reported.cwd)).toBe(realpathSync(dataDir(harnessId)));
    expect(spawned[0]?.env).not.toHaveProperty('HARNESS_WORKSPACE');
  });
});

describe('the Workspace calls', () => {
  it('answer not_installed for a Harness that is not installed', async () => {
    for (const method of ['launch.chooseWorkspace', 'launch.lastWorkspace']) {
      await expect(call(method, 'acme/missing')).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_installed' },
      });
    }
    expect(pickerOpenedAt).toEqual([]);
  });
});
