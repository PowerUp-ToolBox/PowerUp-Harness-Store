import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createHarnessWindowHandlers } from '../../src/main/runtime/harness-window-handlers.js';
import { spawnPiped, type PipedSpawnOptions } from '../../src/main/runtime/piped-process.js';
import { spawnNodePty } from '../../src/main/runtime/pty.js';
import type { HarnessWindows, WebWindowSpec } from '../../src/main/runtime/supervisor.js';
import type { HarnessWindowEventName } from '../../src/shared/harness-ipc.js';
import type { IpcEventName, IpcEvents, IpcResult, LaunchStatus } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';

/**
 * Tickets P0-06.2 and P0-06.3, the reference Harnesses end to end through the Supervisor seam: the
 * real Runtime with its SQLite file in a temp app data root and the real Model Gateway, its
 * `default` Slot bound (as the Default Model) to the `ollama` Connection pointing at the fake
 * Provider (`model-a`, which echoes the last user message word by word). Each example's built
 * Harness folder, out/, is installed through the installer and run for real: hello-term in a pty
 * (node-pty, under this test's Node), typed into as the Harness window's terminal would; hello-web
 * with its output piped, its page fetched from the URL the Runtime shows in its window and driven
 * in jsdom, whose `fetch` reaches the Harness's server for real. Only the windows are faked.
 *
 * The examples are built by the root `pnpm build`; without out/ these tests fail, never skip.
 */

const HELLO_TERM = join(import.meta.dirname, '../../../../examples/hello-term/out');
const HELLO_WEB = join(import.meta.dirname, '../../../../examples/hello-web/out');
const PLATFORM = `${process.platform}-${process.arch}`;
const MAIN_WINDOW = {};
const SIZE = { cols: 100, rows: 30 };

let root: string;
let userData: string;
let fake: FakeProvider;
let runtime: Runtime | undefined;
let windows: ReturnType<typeof createFakeWindows>;
let states: LaunchStatus[];
/** What the Runtime started each piped (web) Harness process with. */
let spawned: PipedSpawnOptions[];

beforeAll(() => {
  for (const [name, out] of [
    ['hello-term', HELLO_TERM],
    ['hello-web', HELLO_WEB],
  ] as const) {
    if (!existsSync(join(out, 'manifest.json'))) {
      throw new Error(
        `examples/${name}/out/ is not built: run \`pnpm build\` at the repository root first.`,
      );
    }
  }
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-reference-'));
  userData = join(root, 'userData');
  fake = await startFakeProvider({
    aliases: { 'model-a': 'fake/echo', 'model-stall': 'fake/stall' },
  });
  states = [];
  spawned = [];
});
afterEach(async () => {
  for (const page of pages.splice(0)) page.close();
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
    spawnProcess: (options) => {
      spawned.push(options);
      return spawnPiped(options);
    },
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

/**
 * Harness windows without Electron: a terminal window's page reports itself ready at once; a web
 * window records the URL of the Harness's page the Runtime shows in it, and whether that page
 * answered right then. `close` closes a web window as Electron does (its `closed` event).
 */
function createFakeWindows() {
  const open = new Set<string>();
  const sent: { launchId: string; event: HarnessWindowEventName; payload: unknown }[] = [];
  const webSpecs: WebWindowSpec[] = [];
  const onWebClosed = new Map<string, () => void>();
  const shown = new Map<string, { url: string; statusWhenShown: Promise<number> }>();
  const fakes = {
    open,
    sent,
    webSpecs,
    shown,
    openTerminal(spec) {
      open.add(spec.launchId);
      queueMicrotask(() => void windowCall(spec.launchId, 'terminal.ready', SIZE));
    },
    openWeb(spec, onClosed) {
      open.add(spec.launchId);
      webSpecs.push(spec);
      onWebClosed.set(spec.launchId, onClosed);
    },
    showWeb(launchId, url) {
      const statusWhenShown = fetch(url).then(
        (response) => response.status,
        () => 0,
      );
      shown.set(launchId, { url, statusWhenShown });
    },
    hideWeb: () => undefined,
    reloadWeb: () => undefined,
    layoutWeb: () => undefined,
    send(launchId, event, payload) {
      if (open.has(launchId)) sent.push({ launchId, event, payload });
    },
    focus: (launchId) => open.has(launchId),
    close(launchId) {
      open.delete(launchId);
      const onClosed = onWebClosed.get(launchId);
      onWebClosed.delete(launchId);
      onClosed?.();
    },
  } satisfies HarnessWindows & Record<string, unknown>;
  return fakes;
}

/**
 * Everything the pty of `launchId` printed so far, without the terminal's control sequences: CSI
 * sequences and window titles (OSC, which Windows' ConPTY writes and macOS and Linux ptys do not).
 */
function screen(launchId: string): string {
  return windows.sent
    .filter((each) => each.launchId === launchId && each.event === 'terminal.data')
    .map((each) => each.payload as string)
    .join('')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // eslint-disable-line no-control-regex
    .replace(/\x1b\][^\x07]*\x07/g, '') // eslint-disable-line no-control-regex
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

/** jsdom, typed only as far as these tests drive the page with it (it ships no types). */
interface PageElement {
  readonly textContent: string | null;
  readonly hidden: boolean;
  value: string;
  getAttribute(name: string): string | null;
  requestSubmit(): void;
  dispatchEvent(event: object): boolean;
}
interface PageWindow {
  readonly document: {
    readonly documentElement: { readonly lang: string };
    getElementById(id: string): PageElement | null;
  };
  readonly Event: new (type: string) => object;
  fetch: typeof fetch;
  TextDecoder: typeof TextDecoder;
  close(): void;
}
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (
    html: string,
    options: { url: string; runScripts: 'dangerously'; beforeParse: (window: PageWindow) => void },
  ) => { readonly window: PageWindow };
};

/** The pages opened in jsdom, closed after each test. */
const pages: PageWindow[] = [];

/** The URL of the page the Runtime showed in `launchId`'s window. */
function shownUrl(launchId: string): URL {
  const shown = windows.shown.get(launchId);
  if (shown === undefined) throw new Error('No page was shown');
  return new URL(shown.url);
}

/**
 * Loads the page shown in `launchId`'s window in jsdom and runs its script, as the Harness window
 * would. The page's `fetch` goes to the Harness's server for real; every URL it asks for is kept.
 */
async function openPage(launchId: string) {
  const url = shownUrl(launchId);
  const response = await fetch(url);
  const html = await response.text();
  const requested: string[] = [];
  const { window } = new JSDOM(html, {
    url: url.href,
    runScripts: 'dangerously',
    beforeParse(page) {
      page.TextDecoder = TextDecoder;
      page.fetch = (input, init) => {
        const target = new URL(input instanceof Request ? input.url : input, url);
        requested.push(target.href);
        return fetch(target, init);
      };
    },
  });
  pages.push(window);
  const element = (id: string) => {
    const found = window.document.getElementById(id);
    if (found === null) throw new Error(`The page has no #${id}`);
    return found;
  };
  /** Types `text` into the message box and sends it, as the User would. */
  const send = (text: string) => {
    element('message').value = text;
    element('composer').requestSubmit();
  };
  /** Waits until the latest answer is complete (or failed), then returns its text. */
  const reply = (part: string) =>
    waitFor(
      () => {
        const latest = window.document.getElementById('reply');
        const text = latest?.textContent ?? '';
        return latest?.getAttribute('aria-busy') === null && text.includes(part) ? text : undefined;
      },
      `a reply with ${JSON.stringify(part)}`,
    );
  return { window, response, html, requested, element, send, reply };
}

/** One HTTP request to hello-web's server, with full control of its headers (`Host` included). */
function serverRequest(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (incoming) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => (body += chunk));
        incoming.on('end', () => {
          resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}

/**
 * Sends `head` (a request line and headers, without the blank line that ends them) to hello-web's
 * server byte for byte, as no HTTP client would, and returns its status line.
 */
function rawRequest(port: number, head: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    socket.on('end', () => {
      resolve(received.split('\r\n')[0] ?? '');
    });
    socket.on('error', reject);
    socket.end(`${head}\r\nHost: 127.0.0.1:${String(port)}\r\nConnection: close\r\n\r\n`);
  });
}

/** The events of a `/chat` response body, in order. */
function sseEvents(body: string): { event: string; data: unknown }[] {
  return body
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? '';
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6) ?? 'null';
      return { event, data: JSON.parse(data) as unknown };
    });
}

const chat = (port: number, messages: unknown) =>
  serverRequest(port, {
    method: 'POST',
    path: '/chat',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

describe('hello-web (examples/hello-web/out)', () => {
  const harnessId = 'harness-store/hello-web';

  async function launchHelloWeb(locale: 'en' | 'zh-CN') {
    await start(locale);
    await expect(call('installs.installFromFolder', HELLO_WEB)).resolves.toMatchObject({
      ok: true,
    });
    const launchId = await launch(harnessId, null);
    await waitFor(
      () => (lastState(launchId)?.state === 'ready' ? true : undefined),
      'the launch to be ready',
    );
    return launchId;
  }

  it('shows its chat page once it serves it; a message streams in from the default Slot, the page names the model that wrote it, and one Usage Record is left', async () => {
    const launchId = await launchHelloWeb('en');
    // Its window opened at once, on its Starting state; the page came in once it answered.
    expect(windows.webSpecs).toEqual([{ launchId, harnessId, name: 'Hello Web', size: {} }]);
    expect(states.filter((each) => each.launchId === launchId).map((each) => each.state)).toEqual([
      'preparing',
      'spawning',
      'waiting-ready',
      'ready',
    ]);
    const url = shownUrl(launchId);
    expect(url.href).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    await expect(windows.shown.get(launchId)?.statusWhenShown).resolves.toBe(200);
    const env = spawned.at(-1)?.env ?? {};
    expect(env.HARNESS_PORT).toBe(url.port);
    const token = env.HARNESS_GATEWAY_TOKEN ?? '';
    const gatewayUrl = env.HARNESS_GATEWAY_URL ?? '';
    expect(token).not.toBe('');

    const page = await openPage(launchId);
    // Its page may connect to its own origin only, and never holds the Gateway's address or token.
    expect(page.response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(page.response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(page.html).toContain('<html lang="en">');
    expect(page.html).not.toContain(token);
    expect(page.html).not.toContain(gatewayUrl);
    expect(page.element('locale').value).toBe('en');
    expect(page.element('send').textContent).toBe('Send');
    expect(page.element('answered').hidden).toBe(true);

    const message = 'Hello from the reference page';
    page.send(message);
    // The fake Provider echoes the message back, word by word, through the Gateway and /chat.
    await expect(page.reply(message)).resolves.toBe(message);
    // Once the answer is complete, the page names the model that wrote it.
    expect(page.element('model').textContent).toBe('ollama/model-a');
    expect(page.element('answered').hidden).toBe(false);
    expect(page.requested).toEqual([`${url.origin}/chat`]);
    expect(chatRequests()).toEqual([
      expect.objectContaining({
        model: 'model-a',
        stream: true,
        messages: [{ role: 'user', content: message }],
      }),
    ]);

    // Exactly one Usage Record, this Harness's, written during this launch.
    expect(rows('usage_records')).toEqual([
      expect.objectContaining({
        harness_id: harnessId,
        harness_version: '0.1.0',
        slot: 'default',
        provider: 'ollama',
        model: 'model-a',
        status: 'ok',
      }),
    ]);
    windows.close(launchId);
    await expect(waitForEnd(launchId)).resolves.toMatchObject({ state: 'stopped' });
    const [launchRow] = rows('launches');
    expect(launchRow).toMatchObject({ launch_id: launchId, harness_id: harnessId });
    const usage = rows('usage_records');
    expect(usage).toHaveLength(1);
    const timestamp = String(usage[0]?.timestamp);
    expect(timestamp >= String(launchRow?.started_at)).toBe(true);
    expect(timestamp <= String(launchRow?.ended_at)).toBe(true);
  });

  it('starts in HARNESS_LOCALE (zh-CN), keeps the conversation, says where to bind a model, and its menu switches it to English', async () => {
    const launchId = await launchHelloWeb('zh-CN');
    const page = await openPage(launchId);
    expect(page.html).toContain('<html lang="zh-CN">');
    expect(page.window.document.documentElement.lang).toBe('zh-CN');
    expect(page.element('locale').value).toBe('zh-CN');
    expect(page.element('send').textContent).toBe('发送');
    expect(page.element('message').getAttribute('placeholder')).toBe('向 default 模型槽位发送消息');

    page.send('你好');
    await page.reply('你好');
    page.send('second question');
    await page.reply('second question');
    // The second request carries the first exchange: the page keeps the conversation.
    expect(chatRequests().at(-1)?.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好' },
      { role: 'user', content: 'second question' },
    ]);

    await bindDefault(null);
    page.send('anyone there?');
    await expect(page.reply('模型槽位')).resolves.toBe(
      '模型槽位“default”还没有绑定模型。请在 Harness Store 的模型页绑定一个，然后重新发送消息。',
    );
    expect(page.element('reply').getAttribute('role')).toBe('alert');

    const menu = page.element('locale');
    menu.value = 'en';
    menu.dispatchEvent(new page.window.Event('change'));
    expect(page.window.document.documentElement.lang).toBe('en');
    expect(page.element('send').textContent).toBe('Send');
    expect(page.element('reply').textContent).toBe(
      'No model is bound to the Model Slot "default". Bind one on the Models page of Harness Store, then send your message again.',
    );

    // The unanswered message is not part of the conversation.
    await bindDefault('model-a');
    page.send('now?');
    await page.reply('now?');
    expect(chatRequests().at(-1)?.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second question' },
      { role: 'user', content: 'now?' },
    ]);
    expect(rows('usage_records')).toHaveLength(3);
  });

  it('shows a Gateway error with the Provider message as written, `$` patterns included', async () => {
    const launchId = await launchHelloWeb('en');
    // A model the fake Provider does not know: its 404 message names the model, `$&` and all.
    await bindDefault("cost-$&-and-$'-or-$$");
    const page = await openPage(launchId);
    page.send('hi');
    const message =
      "502 The Provider returned an error: The model `cost-$&-and-$'-or-$$` does not exist or you do not have access to it.";
    await expect(page.reply('could not answer')).resolves.toBe(
      `The Model Gateway could not answer: ${message}`,
    );

    const menu = page.element('locale');
    menu.value = 'zh-CN';
    menu.dispatchEvent(new page.window.Event('change'));
    expect(page.element('reply').textContent).toBe(`Model Gateway 无法回答：${message}`);
  });

  it('answers /chat with Server-Sent Events ending in the model that wrote the answer, refuses other callers, and aborts the Gateway call when its page goes away', async () => {
    const launchId = await launchHelloWeb('en');
    const port = Number(shownUrl(launchId).port);
    const env = spawned.at(-1)?.env ?? {};

    const answered = await chat(port, [{ role: 'user', content: 'one two three' }]);
    expect(answered.status).toBe(200);
    expect(answered.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(sseEvents(answered.body)).toEqual([
      { event: 'token', data: { text: 'one ' } },
      { event: 'token', data: { text: 'two ' } },
      { event: 'token', data: { text: 'three' } },
      { event: 'done', data: { model: 'ollama/model-a' } },
    ]);
    expect(answered.body).not.toContain(env.HARNESS_GATEWAY_TOKEN ?? 'no token');
    expect(answered.body).not.toContain(env.HARNESS_GATEWAY_URL ?? 'no url');

    // Only its own page may call: JSON from this origin's Host, on the one route.
    const valid = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
    await expect(
      serverRequest(port, {
        method: 'POST',
        path: '/chat',
        headers: { Host: `evil.example:${String(port)}`, 'Content-Type': 'application/json' },
        body: valid,
      }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      serverRequest(port, {
        method: 'POST',
        path: '/chat',
        headers: { 'Content-Type': 'text/plain' },
        body: valid,
      }),
    ).resolves.toMatchObject({ status: 415 });
    await expect(chat(port, [])).resolves.toMatchObject({ status: 400 });
    await expect(chat(port, [{ role: 'system', content: 'x' }])).resolves.toMatchObject({
      status: 400,
    });
    await expect(serverRequest(port, { method: 'GET', path: '/chat' })).resolves.toMatchObject({
      status: 404,
    });
    await expect(serverRequest(port, { method: 'GET', path: '/other' })).resolves.toMatchObject({
      status: 404,
    });
    const tooLarge = await serverRequest(port, {
      method: 'POST',
      path: '/chat',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
      }),
    });
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(tooLarge.body)).toMatchObject({ error: { code: 'invalid_request' } });
    // Request-targets Node's HTTP parser accepts but `new URL` does not: unknown routes, not a
    // crash of the Harness.
    for (const target of ['http://[', '//[/', 'http://a%zz/', 'http://x:99999/']) {
      await expect(rawRequest(port, `GET ${target} HTTP/1.1`)).resolves.toBe(
        'HTTP/1.1 404 Not Found',
      );
    }
    // The refused requests never reached the Gateway.
    expect(chatRequests()).toHaveLength(1);

    // `localhost` on its port is its own Host too.
    const viaLocalhost = await serverRequest(port, {
      method: 'POST',
      path: '/chat',
      headers: { Host: `localhost:${String(port)}`, 'Content-Type': 'application/json' },
      body: valid,
    });
    expect(viaLocalhost.status).toBe(200);
    expect(sseEvents(viaLocalhost.body)).toEqual([
      { event: 'token', data: { text: 'hi' } },
      { event: 'done', data: { model: 'ollama/model-a' } },
    ]);
    expect(chatRequests()).toHaveLength(2);
    expect(lastState(launchId)?.state).toBe('ready');

    await bindDefault(null);
    const unbound = await chat(port, [{ role: 'user', content: 'hi' }]);
    expect(unbound.status).toBe(200);
    expect(sseEvents(unbound.body)).toEqual([
      {
        event: 'error',
        data: {
          code: 'slot_unbound',
          message:
            'No model is bound to the Model Slot "default". Bind one on the Models page of Harness Store.',
        },
      },
    ]);

    // A page that goes away mid-answer: hello-web aborts its Gateway call, the Gateway its own.
    await bindDefault('model-stall');
    const leaving = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/chat',
      headers: { 'Content-Type': 'application/json' },
    });
    const status = new Promise<number>((resolve) => {
      leaving.on('response', (incoming) => {
        resolve(incoming.statusCode ?? 0);
      });
    });
    leaving.on('error', () => undefined);
    leaving.end(valid);
    await expect(status).resolves.toBe(200);
    const stalled = await waitFor(
      () =>
        fake.requests.find(
          (each) => (each.body as { model?: string } | null)?.model === 'model-stall',
        ),
      'the stalled call to reach the fake Provider',
    );
    leaving.destroy();
    await waitFor(() => (stalled.aborted ? true : undefined), 'the Provider call to be aborted');
  });
});
