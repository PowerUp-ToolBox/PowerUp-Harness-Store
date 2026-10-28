import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import type { LocalProbeTarget } from '../../src/main/runtime/local-detection.js';
import { createFakeCipher } from '../support/fake-cipher.js';
import { REFUSED_BASE_URL } from '../support/refused-port.js';

/**
 * Local Provider detection over IPC, as the wizard's Local Providers step and the Models page call
 * it, through the real Runtime and Node's fetch. Fake Providers on ports the OS picks stand in for
 * Ollama and LM Studio (the probe targets point at them), so no test depends on what runs on
 * 11434 or 1234 of the machine it runs on.
 */

const MAIN_WINDOW = {};

let dataDir: string;
let runtime: Runtime | undefined;
let closers: (() => Promise<void>)[];

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-detect-local-')), 'userData');
  closers = [];
});
afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await Promise.all(closers.map((close) => close()));
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

async function launch(
  targets: readonly LocalProbeTarget[] | undefined,
  providerFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Runtime> {
  runtime = await startRuntime({
    dataDir,
    version: '1.0.0',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    providerFetch,
    ...(targets === undefined ? {} : { localProbeTargets: targets }),
    secretCipher: createFakeCipher(),
  });
  return runtime;
}

function call(method: string, input?: unknown) {
  if (runtime === undefined) throw new Error('Not launched');
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

/** A fake Provider standing in for a local one, serving `model` too. */
async function fakeLocal(model: string): Promise<FakeProvider> {
  const fake = await startFakeProvider({ aliases: { [model]: 'fake/echo' } });
  closers.push(() => fake.close());
  return fake;
}

/**
 * A loopback server that answers GET /v1/models with 404 until `start()`, then as Ollama does.
 * It listens for the whole test, so the port cannot change hands between two detections.
 */
async function ollamaStartedLater(): Promise<{ readonly url: string; start: () => void }> {
  let running = false;
  const server: Server = createServer((_request, response) => {
    if (!running) {
      response.writeHead(404).end('Not found');
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:8b', object: 'model' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    start: () => {
      running = true;
    },
  };
}

describe.each([
  { providerId: 'ollama', displayName: 'Ollama', model: 'qwen3:8b', other: 'lmstudio' },
  { providerId: 'lmstudio', displayName: 'LM Studio', model: 'gemma-3', other: 'ollama' },
])('$displayName running', ({ providerId, displayName, model, other }) => {
  it('is detected and offered, and nothing is added until connections.add', async () => {
    const fake = await fakeLocal(model);
    await launch([
      { providerId, baseUrl: fake.url },
      { providerId: other, baseUrl: REFUSED_BASE_URL },
    ]);
    const detected = await call('connections.detectLocal');
    expect(detected).toMatchObject({
      ok: true,
      data: [{ providerId, displayName, baseUrl: fake.url, added: false }],
    });
    expect(detected.ok && (detected.data as { models: string[] }[])[0]?.models).toContain(model);
    // Detection alone saved nothing, however often it runs.
    await call('connections.detectLocal');
    await expect(call('connections.list')).resolves.toEqual({ ok: true, data: [] });
  });

  it(`Add creates the "${providerId}" Connection without a key, and it then shows as added`, async () => {
    const fake = await fakeLocal(model);
    await launch([{ providerId, baseUrl: fake.url }]);
    await call('connections.detectLocal');
    const added = await call('connections.add', { providerId, baseUrl: fake.url });
    expect(added).toMatchObject({
      ok: true,
      data: {
        id: providerId,
        providerId,
        local: true,
        enabled: true,
        baseUrl: fake.url,
        keyHint: null,
        lastTestOk: true,
      },
    });
    expect(added.ok && (added.data as { models: string[] }).models).toContain(model);
    await expect(call('connections.detectLocal')).resolves.toMatchObject({
      ok: true,
      data: [{ providerId, added: true }],
    });
  });
});

describe('detection', () => {
  it('answers with nothing, within the timeout, when neither runs', async () => {
    await launch([
      { providerId: 'ollama', baseUrl: REFUSED_BASE_URL },
      { providerId: 'lmstudio', baseUrl: REFUSED_BASE_URL },
    ]);
    const started = performance.now();
    await expect(call('connections.detectLocal')).resolves.toEqual({ ok: true, data: [] });
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('finds on a later call (Detect again) a Provider started after the first one', async () => {
    const ollama = await ollamaStartedLater();
    await launch([{ providerId: 'ollama', baseUrl: ollama.url }]);
    await expect(call('connections.detectLocal')).resolves.toEqual({ ok: true, data: [] });
    ollama.start();
    await expect(call('connections.detectLocal')).resolves.toEqual({
      ok: true,
      data: [
        {
          providerId: 'ollama',
          displayName: 'Ollama',
          baseUrl: ollama.url,
          models: ['qwen3:8b'],
          added: false,
        },
      ],
    });
  });

  it('looks at the default ports, and Add points the Connection at the default base URL', async () => {
    // Node's fetch stand-in: an Ollama-shaped answer on 127.0.0.1:11434, nothing elsewhere. No
    // socket is opened, so whatever runs on this machine's ports does not matter.
    const probed: string[] = [];
    await launch(undefined, (input) => {
      const url = new Request(input).url;
      probed.push(url);
      return url.startsWith('http://127.0.0.1:11434/')
        ? Promise.resolve(Response.json({ object: 'list', data: [{ id: 'qwen3:8b' }] }))
        : Promise.reject(new TypeError('fetch failed'));
    });
    const detected = await call('connections.detectLocal');
    expect(probed.sort()).toEqual([
      'http://127.0.0.1:11434/v1/models',
      'http://127.0.0.1:1234/v1/models',
    ]);
    expect(detected).toEqual({
      ok: true,
      data: [
        {
          providerId: 'ollama',
          displayName: 'Ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: ['qwen3:8b'],
          added: false,
        },
      ],
    });
    await expect(
      call('connections.add', { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }),
    ).resolves.toMatchObject({
      ok: true,
      data: { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', keyHint: null },
    });
    // Stored as the Provider's default (NULL), not as a copy of the URL.
    const db = new DatabaseSync(runtime?.databasePath ?? '', {
      readOnly: true,
    });
    try {
      expect(db.prepare('SELECT id, base_url, secret_ref FROM connections').all()).toEqual([
        { id: 'ollama', base_url: null, secret_ref: null },
      ]);
    } finally {
      db.close();
    }
  });
});
