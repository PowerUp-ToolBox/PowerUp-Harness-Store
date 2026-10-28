/**
 * The authoring guide, docs/guides/authoring-harnesses.md, stays honest:
 *
 * - every ```ts block in it is, byte for byte, one of the files in test/guide/, which this package
 *   type-checks and lints like its own tests, and every file there appears in the guide;
 * - each of those files runs here, as the module a Publisher would paste, against a real Model
 *   Gateway whose `default` Slot is bound to the fake Provider (no real Provider, no real key);
 * - every Manifest in it is valid, and the reference Harnesses' Manifests are quoted exactly;
 * - it keeps the nine sections of ticket P0-06.4 in order, and the three sentences of what the
 *   platform does not do (ADR-0004's trust model);
 * - its zh-CN twin, docs/guides/authoring-harnesses.zh-CN.md, has the same headings and the same
 *   code blocks byte for byte, and the two link to each other.
 *
 * The shell commands and the build script were checked by following the guide once from an empty
 * folder; they are not run here.
 *
 * The snippets import `@harness-store/sdk` by its package name, as a Harness does; that resolves
 * to this package's built dist/, so `pnpm build` must have run (CI builds first).
 */
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGateway } from '@harness-store/gateway';
import type { Binding, Gateway } from '@harness-store/gateway';
import { startFakeProvider } from '@harness-store/gateway/testing/fake-provider';
import type { FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { validateManifest } from '@harness-store/manifest';
import type { Manifest } from '@harness-store/manifest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Sdk from '../src/index.js';
import { LAUNCH_ENV, stubLaunchEnv } from './support/env.js';

const REPO = join(import.meta.dirname, '../../..');
const GUIDE_PATH = join(REPO, 'docs/guides/authoring-harnesses.md');
const SNIPPETS = join(import.meta.dirname, 'guide');
const guide = readFileSync(GUIDE_PATH, 'utf8');

/** The fenced blocks of the guide that start at the beginning of a line, with their language. */
function fencedBlocks(lang: string): string[] {
  return [...guide.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)]
    .filter(([, blockLang]) => blockLang === lang)
    .map(([, , body]) => body ?? '');
}

const snippetFiles = readdirSync(SNIPPETS)
  .filter((file) => file.endsWith('.ts'))
  .sort();

const exampleManifest = (name: string): unknown =>
  JSON.parse(readFileSync(join(REPO, 'examples', name, 'manifest.json'), 'utf8'));

/** The guide's JSON blocks: full Manifests, and fragments of one (the worked Slot example). */
const jsonBlocks = fencedBlocks('json').map((body) => JSON.parse(body) as Record<string, unknown>);
const manifests = jsonBlocks.filter((block) => 'manifestVersion' in block);
const fragments = jsonBlocks.filter((block) => !('manifestVersion' in block));

/** First Harness, the Harness the guide builds; the snippets run as its launches. */
const firstHarness: Manifest = (() => {
  const block = manifests.find((each) => each.id === 'alice/first-harness');
  const result = validateManifest(block);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.manifest;
})();

describe('the guide', () => {
  it('has the nine sections of ticket P0-06.4, in order', () => {
    expect(guide.match(/^## .*$/gm)).toEqual([
      '## 1. What a Harness is',
      '## 2. Folder layout',
      '## 3. The Manifest, field by field',
      '## 4. The launch contract',
      '## 5. Using the SDK',
      '## 6. Model Slots and Recommended Models',
      '## 7. What the platform does not do',
      '## 8. Testing locally',
      '## 9. Publishing',
    ]);
  });

  it('states what the platform does not do, one sentence each, as ADR-0004 does', () => {
    const section = guide.slice(guide.indexOf('## 7.'), guide.indexOf('## 8.'));
    expect(section).toContain(
      "- **No sandboxing.** Harness Store does not sandbox your Harness: it runs as an ordinary process with all of the User's operating-system permissions, and its Declared Permissions are shown to the User but not enforced.\n",
    );
    expect(section).toContain(
      "- **No access to real credentials.** Your Harness never receives the User's Provider credentials: it gets only a Gateway Token, which works on nothing but the local Model Gateway and is revoked when your process exits.\n",
    );
    expect(section).toContain(
      '- **No automatic Provider fallback.** When the Provider or model bound to a Slot fails, the Model Gateway returns the error to your Harness and never retries the call or switches to another Provider or model.\n',
    );
  });

  it('claims at install only what the install consent dialog says', () => {
    const section = guide.slice(guide.indexOf('## 7.'), guide.indexOf('## 8.'));
    expect(section).toContain(
      'and the app tells Users at install that Harnesses are not sandboxed and that Declared Permissions are not enforced.\n',
    );
    const strings = JSON.parse(
      readFileSync(join(REPO, 'apps/desktop/src/shared/i18n/en.json'), 'utf8'),
    ) as Record<string, string>;
    const dialog = Object.entries(strings)
      .filter(([key]) => key.startsWith('consent.'))
      .map(([, text]) => text)
      .join('\n');
    expect(dialog).toContain('does not sandbox Harnesses');
    expect(dialog).toContain('does not enforce them');
    // The other two facts are not shown at install, so the guide must not say they are.
    expect(dialog).not.toMatch(/credential|fallback/i);
  });

  it('quotes every file of test/guide/ exactly in a ts block, and has no other ts block', () => {
    const blocks = fencedBlocks('ts');
    const files = snippetFiles.map((file) => readFileSync(join(SNIPPETS, file), 'utf8'));
    expect(snippetFiles).toEqual([
      'chat.ts',
      'context.ts',
      'first-harness.ts',
      'list-slots.ts',
      'web-server.ts',
    ]);
    expect([...blocks].sort()).toEqual([...files].sort());
  });

  it('quotes the reference Harnesses’ Manifests exactly', () => {
    expect(manifests).toContainEqual(exampleManifest('hello-web'));
    expect(manifests).toContainEqual(exampleManifest('hello-term'));
    expect(manifests.map((each) => each.id)).toEqual([
      'harness-store/hello-web',
      'harness-store/hello-term',
      'alice/first-harness',
    ]);
  });

  it('names every field in which hello-term’s Manifest differs from hello-web’s', () => {
    const web = exampleManifest('hello-web') as Record<string, unknown>;
    const term = exampleManifest('hello-term') as Record<string, unknown>;
    const differing = [...new Set([...Object.keys(web), ...Object.keys(term)])].filter(
      (key) => JSON.stringify(web[key]) !== JSON.stringify(term[key]),
    );
    expect(differing.sort()).toEqual(
      ['id', 'name', 'summary', 'sourceRepo', 'ui', 'workspace', 'models'].sort(),
    );
    expect(guide).toContain(
      'Apart from its identity fields (`id`, `name`, `summary` and `sourceRepo`), [`hello-term`](../../examples/hello-term/manifest.json) differs in three fields: its UI Kind is `terminal`',
    );
  });

  it('holds only valid Manifests, with no problems and no warnings', () => {
    for (const manifest of manifests) {
      expect(validateManifest(manifest), String(manifest.id)).toMatchObject({
        ok: true,
        warnings: [],
      });
    }
  });

  it('has a zh-CN twin with the same headings and the same code, linked both ways', () => {
    const twin = readFileSync(join(REPO, 'docs/guides/authoring-harnesses.zh-CN.md'), 'utf8');
    // Every fenced block, indented ones in list items included, in order.
    const code = (text: string) =>
      [...text.matchAll(/^( *)```.*\n[\s\S]*?^\1```$/gm)].map(([block]) => block);
    const levels = (text: string) => text.match(/^#{1,6} /gm);
    expect(code(twin)).toEqual(code(guide));
    expect(levels(twin)).toEqual(levels(guide));
    expect(guide).toMatch(/^English \| \[简体中文\]\(authoring-harnesses\.zh-CN\.md\)$/m);
    expect(twin).toMatch(/^\[English\]\(authoring-harnesses\.md\) \| 简体中文$/m);
  });

  it('shows a models fragment that is valid in a Manifest', () => {
    expect(fragments).toHaveLength(1);
    for (const fragment of fragments) {
      expect(Object.keys(fragment)).toEqual(['models']);
      expect(validateManifest({ ...firstHarness, ...fragment })).toMatchObject({
        ok: true,
        warnings: [],
      });
    }
  });
});

// The web snippet's server, kept so the tests can close it; createServer is otherwise the SDK's.
const servers = vi.hoisted(() => [] as Server[]);
vi.mock('@harness-store/sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof Sdk>();
  return {
    ...sdk,
    createServer: (...args: Parameters<typeof sdk.createServer>) => {
      const server = sdk.createServer(...args);
      servers.push(server);
      return server;
    },
  };
});

describe('the guide’s snippets against a real Model Gateway', () => {
  const WORKSPACE = '/Users/alice/project';
  let fake: FakeProvider;
  let gateway: Gateway;
  let gatewayUrl: string;
  let token: string;
  let binding: Binding | null;

  beforeAll(async () => {
    fake = await startFakeProvider({ aliases: { 'model-a': 'fake/echo' } });
    gateway = createGateway({
      resolveBinding: ({ slot }) => Promise.resolve(slot === 'default' ? binding : null),
      getConnection: (providerId) =>
        Promise.resolve(providerId === 'ollama' ? { baseUrl: fake.url } : null),
      getManifest: (harnessId) =>
        Promise.resolve(harnessId === firstHarness.id ? firstHarness : null),
      onUsage: () => Promise.resolve(),
      logger: { debug: () => undefined, error: () => undefined },
    });
    ({ url: gatewayUrl } = await gateway.listen());
    token = gateway.issueToken({
      harnessId: firstHarness.id,
      harnessVersion: firstHarness.version,
      launchId: 'launch-1',
      locale: 'en',
      workspace: WORKSPACE,
    });
  });

  afterAll(async () => {
    await gateway.close();
    await fake.close();
  });

  beforeEach(() => {
    fake.reset();
    binding = { providerId: 'ollama', model: 'model-a', source: 'default' };
    stubLaunchEnv({
      ...LAUNCH_ENV,
      HARNESS_GATEWAY_URL: gatewayUrl,
      HARNESS_GATEWAY_TOKEN: token,
      OPENAI_BASE_URL: gatewayUrl,
      OPENAI_API_KEY: token,
      HARNESS_ID: firstHarness.id,
      HARNESS_VERSION: firstHarness.version,
      HARNESS_WORKSPACE: WORKSPACE,
      HARNESS_LOCALE: 'en',
      HARNESS_PORT: undefined,
    });
    // Every run evaluates the snippet afresh, as a new launch would.
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  /** Runs the snippet `file` as a module and returns what it printed to stdout. */
  async function run(file: string): Promise<string> {
    let printed = '';
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed += `${args.map(String).join(' ')}\n`;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      printed += String(chunk);
      return true;
    });
    await import(/* @vite-ignore */ join(SNIPPETS, file));
    return printed;
  }

  const chatRequests = () => fake.requests.filter((each) => each.path === '/v1/chat/completions');

  describe('context.ts', () => {
    it('prints the launch environment', async () => {
      expect(await run('context.ts')).toBe(
        'alice/first-harness 0.1.0 on darwin-arm64\n' +
          'Language: en\n' +
          `Data Directory: ${LAUNCH_ENV.HARNESS_DATA_DIR}\n` +
          `Workspace: ${WORKSPACE}\n`,
      );
    });

    it('exits 1 with the NotInHarnessStoreError message outside Harness Store', async () => {
      stubLaunchEnv({});
      const errors: unknown[] = [];
      vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
        errors.push(message);
      });
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      expect(await run('context.ts')).toBe('');
      expect(exit).toHaveBeenCalledWith(1);
      expect(errors).toEqual([expect.stringContaining('"Install this folder locally"')]);
    });
  });

  describe('chat.ts', () => {
    it('prints the answer and the model that wrote it', async () => {
      expect(await run('chat.ts')).toBe('Say hello in five words\nAnswered by ollama/model-a\n');
      expect(chatRequests()).toHaveLength(1);
    });

    it('tells the User where to bind a model when the Slot is unbound', async () => {
      binding = null;
      expect(await run('chat.ts')).toBe(
        'No model is bound to the "default" Model Slot. Bind one on the Models page of Harness Store.\n',
      );
      expect(chatRequests()).toHaveLength(0);
    });
  });

  describe('first-harness.ts', () => {
    function stdin(...lines: string[]) {
      vi.spyOn(process, 'stdin', 'get').mockReturnValue(
        Readable.from(lines) as unknown as typeof process.stdin,
      );
    }

    it('streams an answer for each question and ends at the end of input', async () => {
      stdin('What is a Harness\n', '\n', 'Two words\n');
      expect(await run('first-harness.ts')).toBe(
        'First Harness 0.1.0. Ask a question; Ctrl-D quits.\n' +
          `Workspace: ${WORKSPACE}\n` +
          'What is a Harness\n(ollama/model-a)\n' +
          'Two words\n(ollama/model-a)\n',
      );
      // Streamed from the Provider too; the empty line asked nothing.
      expect(chatRequests().map((each) => each.body)).toEqual([
        expect.objectContaining({ stream: true }),
        expect.objectContaining({ stream: true }),
      ]);
    });

    it('carries on with a message when the Slot is unbound', async () => {
      binding = null;
      vi.stubEnv('HARNESS_WORKSPACE', undefined);
      stdin('Hello\n');
      expect(await run('first-harness.ts')).toBe(
        'First Harness 0.1.0. Ask a question; Ctrl-D quits.\n' +
          'No model is bound to the "default" Model Slot. Bind one on the Models page of Harness Store.\n',
      );
    });
  });

  describe('list-slots.ts', () => {
    it('prints each Slot with its bound model', async () => {
      expect(await run('list-slots.ts')).toBe('default → ollama/model-a\n');
    });

    it('says when a Slot is unbound', async () => {
      binding = null;
      expect(await run('list-slots.ts')).toBe('default → no model bound\n');
    });
  });

  describe('web-server.ts', () => {
    let port: number;

    beforeEach(async () => {
      const probe = createNetServer();
      probe.listen(0, '127.0.0.1');
      await once(probe, 'listening');
      ({ port } = probe.address() as AddressInfo);
      await new Promise((resolve) => probe.close(resolve));
      vi.stubEnv('HARNESS_PORT', String(port));
      // Not the suite's 'en', which is also getContext()'s fallback: the page must follow the launch.
      vi.stubEnv('HARNESS_LOCALE', 'zh-CN');
      await run('web-server.ts');
      const [server] = servers;
      if (server === undefined) throw new Error('web-server.ts created no server');
      if (!server.listening) await once(server, 'listening');
    });

    /**
     * A request to the snippet's server, with `headers` exactly as given (Host included). A body
     * given as several parts is sent in that many writes, a moment apart, so the server reads it
     * in that many chunks.
     */
    function send(
      method: string,
      path: string,
      headers: Record<string, string>,
      body: string | Buffer[] = '',
    ) {
      return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>(
        (resolve, reject) => {
          const request = httpRequest(
            { host: '127.0.0.1', port, method, path, headers },
            (response) => {
              let text = '';
              response.setEncoding('utf8');
              response.on('data', (chunk: string) => (text += chunk));
              response.on('end', () => {
                resolve({ status: response.statusCode ?? 0, headers: response.headers, text });
              });
            },
          );
          request.on('error', reject);
          if (typeof body === 'string') {
            request.end(body);
            return;
          }
          void (async () => {
            for (const part of body) {
              request.write(part);
              await sleep(50);
            }
            request.end();
          })();
        },
      );
    }

    const own = () => ({ Host: `127.0.0.1:${String(port)}`, 'Content-Type': 'application/json' });

    it('listens on 127.0.0.1:HARNESS_PORT and serves the page in the app language', async () => {
      expect(servers[0]?.address()).toMatchObject({ address: '127.0.0.1', port });
      const page = await send('GET', '/', { Host: `127.0.0.1:${String(port)}` });
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(page.headers['content-security-policy']).toBe("connect-src 'self'");
      expect(page.text).toContain('<html lang="zh-CN">');
      // The page never sees the Gateway's address or the Gateway Token.
      expect(page.text).not.toContain(token);
      expect(page.text).not.toContain(gatewayUrl);
    });

    it('streams the answer to its own page through the Gateway', async () => {
      const answer = await send('POST', '/ask', own(), JSON.stringify({ question: 'Hello page' }));
      expect(answer).toMatchObject({ status: 200, text: 'Hello page' });
      expect(chatRequests().map((each) => each.body)).toEqual([
        expect.objectContaining({ stream: true }),
      ]);

      const local = await send(
        'POST',
        '/ask',
        { ...own(), Host: `localhost:${String(port)}` },
        JSON.stringify({ question: 'Hi again' }),
      );
      expect(local).toMatchObject({ status: 200, text: 'Hi again' });
    });

    it('reads a question whose characters are split across chunks', async () => {
      const question = '你好，世界';
      const body = Buffer.from(JSON.stringify({ question }));
      // Cut inside the first character's three UTF-8 bytes.
      const cut = body.indexOf(Buffer.from('你')) + 1;
      const answer = await send('POST', '/ask', own(), [body.subarray(0, cut), body.subarray(cut)]);
      expect(answer).toMatchObject({ status: 200, text: question });
    });

    it('keeps serving when a page goes away halfway through sending its question', async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        const socket = connect(port, '127.0.0.1');
        await once(socket, 'connect');
        socket.write(
          `POST /ask HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n` +
            'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"question":',
        );
        await sleep(50);
        socket.destroy();
        await sleep(50);
        expect(rejections).toEqual([]);
        expect(chatRequests()).toHaveLength(0);
        const answer = await send(
          'POST',
          '/ask',
          own(),
          JSON.stringify({ question: 'Still here' }),
        );
        expect(answer).toMatchObject({ status: 200, text: 'Still here' });
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });

    it('answers no one else: another Host on any route, or a body that is not JSON', async () => {
      const body = JSON.stringify({ question: 'Hello' });
      const rebound = { Host: `evil.example:${String(port)}` };
      // A rebound DNS name is the page's own origin, so every route checks Host, not only /ask.
      expect((await send('GET', '/', rebound)).status).toBe(403);
      expect((await send('POST', '/ask', { ...own(), ...rebound }, body)).status).toBe(403);
      expect((await send('GET', '/history', rebound)).status).toBe(403);
      const form = await send('POST', '/ask', { ...own(), 'Content-Type': 'text/plain' }, body);
      expect(form.status).toBe(404);
      expect(chatRequests()).toHaveLength(0);
    });

    describe('the page’s script', () => {
      interface Element {
        value: string;
        textContent: string;
        disabled: boolean;
        onclick: (() => Promise<void>) | null;
      }

      /**
       * Runs the served page's inline script against stand-ins for its three elements, with
       * `fetch` given, and returns the elements. Only what the script touches is provided.
       */
      async function loadPage(fetch: (path: string, init: RequestInit) => Promise<Response>) {
        const { text } = await send('GET', '/', { Host: `127.0.0.1:${String(port)}` });
        const script = /<script>([\s\S]*)<\/script>/.exec(text)?.[1];
        if (script === undefined) throw new Error('the page has no script');
        const element = (): Element => ({
          value: '',
          textContent: '',
          disabled: false,
          onclick: null,
        });
        const page = { question: element(), ask: element(), answer: element() };
        runInNewContext(script, {
          document: { getElementById: (id: keyof typeof page) => page[id] },
          fetch,
          TextDecoderStream,
        });
        return page;
      }

      /** fetch() as the page in the Harness window makes it: relative to this server. */
      const ownFetch = (path: string, init: RequestInit) =>
        fetch(`http://127.0.0.1:${String(port)}${path}`, init);

      it('streams the answer and allows one question at a time', async () => {
        const page = await loadPage(ownFetch);
        page.question.value = 'Hello from the page';
        const asked = page.ask.onclick?.();
        // Disabled while the answer streams: a second Ask cannot mix a second answer into it.
        expect(page.ask.disabled).toBe(true);
        await asked;
        expect(page.answer.textContent).toBe('Hello from the page');
        expect(page.ask.disabled).toBe(false);
        expect(chatRequests()).toHaveLength(1);
      });

      it('shows a failed request instead of dropping it', async () => {
        const page = await loadPage(() => Promise.reject(new Error('Failed to fetch')));
        await page.ask.onclick?.();
        expect(page.answer.textContent).toBe('No answer: Failed to fetch');
        expect(page.ask.disabled).toBe(false);

        const refused = await loadPage((path, init) =>
          ownFetch(path, { ...init, headers: { 'Content-Type': 'text/plain' } }),
        );
        await refused.ask.onclick?.();
        expect(refused.answer.textContent).toBe('No answer: the server answered 404');
      });
    });

    it('tells the page where to bind a model when the Slot is unbound', async () => {
      binding = null;
      const answer = await send('POST', '/ask', own(), JSON.stringify({ question: 'Hello' }));
      expect(answer).toMatchObject({
        status: 200,
        text: 'No model is bound to this Harness. Bind one on the Models page of Harness Store.',
      });
    });
  });
});
