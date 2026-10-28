import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createHarnessWindowHandlers } from '../../src/main/runtime/harness-window-handlers.js';
import { spawnNodePty } from '../../src/main/runtime/pty.js';
import type { HarnessWindows } from '../../src/main/runtime/supervisor.js';
import type { HarnessWindowEventName } from '../../src/shared/harness-ipc.js';
import type { IpcEventName, IpcEvents, IpcResult, LaunchStatus } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';

/**
 * Ticket P0-06.2, the reference Harnesses end to end through the Supervisor seam: the real Runtime
 * with its SQLite file in a temp app data root and the real Model Gateway, its `default` Slot bound
 * (as the Default Model) to the `ollama` Connection pointing at the fake Provider (`model-a`, which
 * echoes the last user message word by word). Each example's built Harness folder, out/, is
 * installed through the installer and run for real in a pty (node-pty, under this test's Node);
 * the test types into it as the Harness window's terminal would. Only the windows are faked.
 *
 * The examples are built by the root `pnpm build`; without out/ these tests fail, never skip.
 */

const HELLO_TERM = join(import.meta.dirname, '../../../../examples/hello-term/out');
const PLATFORM = `${process.platform}-${process.arch}`;
const MAIN_WINDOW = {};
const SIZE = { cols: 100, rows: 30 };

let root: string;
let userData: string;
let fake: FakeProvider;
let runtime: Runtime | undefined;
let windows: ReturnType<typeof createFakeWindows>;
let states: LaunchStatus[];

beforeAll(() => {
  if (!existsSync(join(HELLO_TERM, 'manifest.json'))) {
    throw new Error(
      'examples/hello-term/out/ is not built: run `pnpm build` at the repository root first.',
    );
  }
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-reference-'));
  userData = join(root, 'userData');
  fake = await startFakeProvider({ aliases: { 'model-a': 'fake/echo' } });
  states = [];
});
afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

/** The Runtime on `userData` in `locale`, with `model-a` as the Default Model of `default`. */
async function start(locale: 'en' | 'zh-CN'): Promise<Runtime> {
  windows = createFakeWindows();
  runtime = await startRuntime({
    dataDir: userData,
    version: '1.0.0',
    osLocale: () => locale,
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
    spawnPty: spawnNodePty,
    // Credentials of the User's shell, which the launch contract keeps from the Harness.
    harnessEnvironment: () => ({ ...process.env, OPENAI_API_KEY: 'sk-parent-openai' }),
    openPath: () => Promise.resolve(true),
  });
  await expect(
    call('connections.add', { providerId: 'ollama', baseUrl: fake.url }),
  ).resolves.toMatchObject({ ok: true });
  await bindDefault('model-a');
  return runtime;
}

function bindDefault(model: string | null) {
  return expect(
    call('bindings.setGlobal', {
      slot: 'default',
      target: model === null ? null : { connectionId: 'ollama', model },
    }),
  ).resolves.toMatchObject({ ok: true });
}

function services() {
  if (runtime === undefined) throw new Error('The Runtime is not started');
  return runtime;
}

function call(method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(services().services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

/** A call from the page of `launchId`'s window, as main routes it. */
function windowCall(launchId: string, method: string, input?: unknown) {
  return createDispatcher({
    handlers: createHarnessWindowHandlers(launchId, {
      supervisor: services().supervisor,
      bindings: services().services.bindings,
      clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
      openModels: () => undefined,
    }),
    isTrustedSender: () => true,
  })(launchId, { method, input });
}

/** Harness windows without Electron: a terminal window's page reports itself ready at once. */
function createFakeWindows() {
  const open = new Set<string>();
  const sent: { launchId: string; event: HarnessWindowEventName; payload: unknown }[] = [];
  const fakes = {
    open,
    sent,
    openTerminal(spec) {
      open.add(spec.launchId);
      queueMicrotask(() => void windowCall(spec.launchId, 'terminal.ready', SIZE));
    },
    // hello-web arrives in P0-06.3.
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
      open.delete(launchId);
    },
  } satisfies HarnessWindows & Record<string, unknown>;
  return fakes;
}

/** Everything the pty of `launchId` printed so far, without the terminal's control sequences. */
function screen(launchId: string): string {
  return windows.sent
    .filter((each) => each.launchId === launchId && each.event === 'terminal.data')
    .map((each) => each.payload as string)
    .join('')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // eslint-disable-line no-control-regex
    .replace(/\r/g, '');
}

/** What the User types into the Harness window's terminal: Enter sends `\r`. */
async function type(launchId: string, text: string) {
  await expect(windowCall(launchId, 'terminal.input', text)).resolves.toMatchObject({ ok: true });
}

async function waitFor<T>(read: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const count = (text: string, part: string) => text.split(part).length - 1;

/** Waits until the screen shows `part` at least `times` times. */
const waitForScreen = (launchId: string, part: string, times = 1) =>
  waitFor(
    () => (count(screen(launchId), part) >= times ? true : undefined),
    `${JSON.stringify(part)} on screen; got ${JSON.stringify(screen(launchId))}`,
  );

/** Waits for the prompt the loop prints when it is ready for the next line. */
const waitForPrompt = (launchId: string, times: number) => waitForScreen(launchId, '\n> ', times);

const lastState = (launchId: string) => states.filter((each) => each.launchId === launchId).at(-1);
const waitForEnd = (launchId: string) =>
  waitFor(() => {
    const last = lastState(launchId);
    return last?.state === 'stopped' || last?.state === 'failed' ? last : undefined;
  }, 'the launch to end');

async function launch(harnessId: string, workspace: string | null): Promise<string> {
  const result = (await call('launch.start', { harnessId, workspace })) as IpcResult<{
    outcome: string;
    launchId: string;
  }>;
  if (!result.ok) throw new Error(result.error.message);
  expect(result.data.outcome).toBe('started');
  return result.data.launchId;
}

function rows(table: 'launches' | 'usage_records') {
  const db = new DatabaseSync(join(userData, 'harness-store.sqlite'), { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** The chat requests the fake Provider received, as the Model Gateway forwarded them. */
const chatRequests = () =>
  fake.requests
    .filter((request) => request.path === '/v1/chat/completions')
    .map((request) => request.body as { model: string; stream?: boolean; messages: unknown[] });

describe('hello-term (examples/hello-term/out)', () => {
  const harnessId = 'harness-store/hello-term';

  it('streams an answer from the default Slot, names the bound model on /model, and /quit ends it stopped with code 0 and one Usage Record', async () => {
    await start('en');
    await expect(call('installs.installFromFolder', HELLO_TERM)).resolves.toMatchObject({
      ok: true,
    });
    const launchId = await launch(harnessId, null);
    await waitForPrompt(launchId, 1);
    const banner = screen(launchId);
    expect(banner).toBe(
      'Hello Term 0.1.0\n' +
        'Type a message and press Enter. /model shows the model of each Model Slot, /quit exits.\n' +
        '\n> ',
    );

    const message = 'Hello from the reference test';
    await type(launchId, `${message}\r`);
    // Once as typed, once as the answer the fake Provider echoed back through the Gateway.
    await waitForScreen(launchId, `${message}\n`, 2);
    await waitForPrompt(launchId, 2);
    expect(chatRequests()).toEqual([
      expect.objectContaining({
        model: 'model-a',
        stream: true,
        messages: [{ role: 'user', content: message }],
      }),
    ]);

    await type(launchId, '/model\r');
    await waitForScreen(launchId, 'default → ollama/model-a\n');
    await waitForPrompt(launchId, 3);

    await type(launchId, '/quit\r');
    const ended = await waitForEnd(launchId);
    // The Harness's own normal exit: no stop sequence, and its window stays open, readable.
    expect(ended).toMatchObject({ state: 'stopped', exitCode: 0 });
    expect(states.filter((each) => each.launchId === launchId).map((each) => each.state)).toEqual([
      'preparing',
      'spawning',
      'ready',
      'stopped',
    ]);
    expect(windows.open.has(launchId)).toBe(true);
    expect(windows.sent).toContainEqual({
      launchId,
      event: 'window.state',
      payload: expect.objectContaining({ state: 'stopped', exitCode: 0 }) as unknown,
    });
    expect(screen(launchId)).toMatch(/\/quit\nBye\.\n$/);

    // Exactly one Usage Record, this Harness's, written during this launch.
    const [launchRow] = rows('launches');
    expect(launchRow).toMatchObject({ launch_id: launchId, harness_id: harnessId, exit_code: 0 });
    const usage = rows('usage_records');
    expect(usage).toEqual([
      expect.objectContaining({
        harness_id: harnessId,
        harness_version: '0.1.0',
        slot: 'default',
        provider: 'ollama',
        model: 'model-a',
        status: 'ok',
      }),
    ]);
    const timestamp = String(usage[0]?.timestamp);
    expect(timestamp >= String(launchRow?.started_at)).toBe(true);
    expect(timestamp <= String(launchRow?.ended_at)).toBe(true);
  });

  it('speaks zh-CN, prints its Workspace, keeps the conversation, and Ctrl-C ends it like /quit', async () => {
    await start('zh-CN');
    await expect(call('installs.installFromFolder', HELLO_TERM)).resolves.toMatchObject({
      ok: true,
    });
    const workspace = mkdtempSync(join(root, 'project-'));
    const launchId = await launch(harnessId, workspace);
    await waitForPrompt(launchId, 1);
    expect(screen(launchId)).toBe(
      'Hello Term 0.1.0\n' +
        `工作目录：${workspace}\n` +
        '输入消息后按 Enter。/model 显示每个模型槽位的模型，/quit 退出。\n' +
        '\n> ',
    );

    await type(launchId, '你好\r');
    await waitForPrompt(launchId, 2);
    await type(launchId, 'second question\r');
    await waitForScreen(launchId, 'second question\n', 2);
    await waitForPrompt(launchId, 3);
    // The second request carries the first exchange: the history is the session's.
    expect(chatRequests().at(-1)?.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好' },
      { role: 'user', content: 'second question' },
    ]);

    await type(launchId, '\x03');
    await expect(waitForEnd(launchId)).resolves.toMatchObject({ state: 'stopped', exitCode: 0 });
    expect(screen(launchId)).toMatch(/再见。\n$/);
    expect(rows('usage_records')).toHaveLength(2);
  });

  it('a Slot unbound mid-session says where to bind a model, and the loop carries on', async () => {
    await start('en');
    await expect(call('installs.installFromFolder', HELLO_TERM)).resolves.toMatchObject({
      ok: true,
    });
    const launchId = await launch(harnessId, null);
    await waitForPrompt(launchId, 1);
    await bindDefault(null);

    await type(launchId, 'anyone there?\r');
    await waitForScreen(
      launchId,
      'No model is bound to the Model Slot "default". Bind one on the Models page of Harness Store, then send your message again.\n',
    );
    await waitForPrompt(launchId, 2);
    await type(launchId, '/model\r');
    await waitForScreen(
      launchId,
      'default → unbound: bind a model on the Models page of Harness Store\n',
    );
    await waitForPrompt(launchId, 3);

    await bindDefault('model-a');
    await type(launchId, 'now?\r');
    await waitForScreen(launchId, 'now?\n', 2);
    await waitForPrompt(launchId, 4);
    // The unanswered message is not part of the conversation.
    expect(chatRequests().at(-1)?.messages).toEqual([{ role: 'user', content: 'now?' }]);

    await type(launchId, '/quit\r');
    await expect(waitForEnd(launchId)).resolves.toMatchObject({ state: 'stopped', exitCode: 0 });
    // The refused call never reached a Provider, so it has no Usage Record.
    expect(rows('usage_records')).toMatchObject([{ slot: 'default', status: 'ok' }]);
  });
});
