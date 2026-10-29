import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROVIDERS } from '@harness-store/gateway';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalDetector,
  DETECT_TIMEOUT_MS,
  localProbeTargets,
  localProbeTargetsWithOllama,
} from '../../src/main/runtime/local-detection.js';
import { REFUSED_BASE_URL } from '../support/refused-port.js';

const fetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

/** A fake Provider on a port the OS picks, standing in for Ollama or LM Studio. */
async function fakeLocalProvider(models: Record<string, 'fake/echo'> = {}): Promise<FakeProvider> {
  const fake = await startFakeProvider({ aliases: models });
  closers.push(() => fake.close());
  return fake;
}

/** A loopback server that accepts every request and never answers it. */
async function silentServer(): Promise<string> {
  const server: Server = createServer(() => undefined);
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
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
}

describe('localProbeTargets', () => {
  it("are Ollama's and LM Studio's default base URLs from the Provider table", () => {
    expect(localProbeTargets()).toEqual([
      { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
      { providerId: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
    ]);
    expect(localProbeTargets(PROVIDERS.filter((provider) => provider.id !== 'ollama'))).toEqual([
      { providerId: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
    ]);
  });
});

describe('localProbeTargetsWithOllama', () => {
  it('moves only Ollama to the URL given, without a trailing slash', () => {
    expect(localProbeTargetsWithOllama('http://127.0.0.1:11435/v1/')).toEqual([
      { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11435/v1' },
      { providerId: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
    ]);
    expect(localProbeTargetsWithOllama('http://localhost:9/v1')[0]?.baseUrl).toBe(
      'http://localhost:9/v1',
    );
  });

  it.each(['https://127.0.0.1:11435/v1', 'http://192.168.1.2:11434/v1', 'not a url', ''])(
    'refuses %j: only a loopback http URL',
    (url) => {
      expect(() => localProbeTargetsWithOllama(url)).toThrow(/loopback http URL/);
    },
  );
});

describe('createLocalDetector', () => {
  it('by default probes GET /v1/models on 11434 and 1234, both at once', async () => {
    const probed: string[] = [];
    let open = 0;
    let maxOpen = 0;
    const detect = createLocalDetector({
      fetch: async (input, init) => {
        probed.push(`${init?.method ?? 'GET'} ${new Request(input).url}`);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        await new Promise((resolve) => setTimeout(resolve, 10));
        open -= 1;
        throw new TypeError('fetch failed');
      },
    });
    await expect(detect()).resolves.toEqual([]);
    expect(probed).toEqual([
      'GET http://127.0.0.1:11434/v1/models',
      'GET http://127.0.0.1:1234/v1/models',
    ]);
    expect(maxOpen).toBe(2);
  });

  it('finds an Ollama-shaped server, with the models it lists', async () => {
    const ollama = await fakeLocalProvider({ 'qwen3:8b': 'fake/echo' });
    const detect = createLocalDetector({
      fetch,
      targets: [
        { providerId: 'ollama', baseUrl: ollama.url },
        { providerId: 'lmstudio', baseUrl: REFUSED_BASE_URL },
      ],
    });
    const found = await detect();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ providerId: 'ollama', baseUrl: ollama.url });
    expect(found[0]?.models).toContain('qwen3:8b');
    expect(ollama.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /v1/models',
    ]);
  });

  it('finds an LM Studio-shaped server, and both when both run', async () => {
    const ollama = await fakeLocalProvider();
    const lmStudio = await fakeLocalProvider({ 'gemma-3': 'fake/echo' });
    const lmStudioOnly = createLocalDetector({
      fetch,
      targets: [
        { providerId: 'ollama', baseUrl: REFUSED_BASE_URL },
        { providerId: 'lmstudio', baseUrl: lmStudio.url },
      ],
    });
    await expect(lmStudioOnly()).resolves.toMatchObject([
      { providerId: 'lmstudio', baseUrl: lmStudio.url },
    ]);
    const both = createLocalDetector({
      fetch,
      targets: [
        { providerId: 'ollama', baseUrl: ollama.url },
        { providerId: 'lmstudio', baseUrl: lmStudio.url },
      ],
    });
    expect((await both()).map((found) => found.providerId)).toEqual(['ollama', 'lmstudio']);
  });

  it('finds nothing, without rejecting, when nothing listens', async () => {
    const detect = createLocalDetector({
      fetch,
      targets: [
        { providerId: 'ollama', baseUrl: REFUSED_BASE_URL },
        { providerId: 'lmstudio', baseUrl: REFUSED_BASE_URL },
      ],
    });
    await expect(detect()).resolves.toEqual([]);
  });

  it('gives up on a server that does not answer after 1.5 seconds, probing both in parallel', async () => {
    expect(DETECT_TIMEOUT_MS).toBe(1500);
    const detect = createLocalDetector({
      fetch,
      targets: [
        { providerId: 'ollama', baseUrl: await silentServer() },
        { providerId: 'lmstudio', baseUrl: await silentServer() },
      ],
    });
    const started = performance.now();
    await expect(detect()).resolves.toEqual([]);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(DETECT_TIMEOUT_MS - 50);
    // Both probes share the window: well under two timeouts back to back.
    expect(elapsed).toBeLessThan(DETECT_TIMEOUT_MS + 1000);
  });

  it('bounds a reply whose body never ends by the same timeout', async () => {
    const detect = createLocalDetector({
      fetch: (_input, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"data":['));
                init?.signal?.addEventListener('abort', () => {
                  controller.error(init.signal?.reason);
                });
              },
            }),
            { status: 200 },
          ),
        ),
      targets: [{ providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }],
      timeoutMs: 50,
    });
    await expect(detect()).resolves.toEqual([]);
  });

  it.each([
    { reason: 'a 401', response: () => Response.json({ error: {} }, { status: 401 }) },
    { reason: 'a 404', response: () => new Response('Not found', { status: 404 }) },
    { reason: 'a body that is not JSON', response: () => new Response('<html></html>') },
    { reason: 'JSON without a data array', response: () => Response.json({ models: [] }) },
    { reason: 'a data field that is not an array', response: () => Response.json({ data: {} }) },
  ])('does not count $reason as a running Provider', async ({ response }) => {
    const detect = createLocalDetector({
      fetch: () => Promise.resolve(response()),
      targets: [{ providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }],
    });
    await expect(detect()).resolves.toEqual([]);
  });

  it('counts an empty model list as running, and keeps only string ids, once each', async () => {
    const detect = createLocalDetector({
      fetch: () =>
        Promise.resolve(
          Response.json({ data: [{ id: 'a' }, { id: 7 }, {}, { id: 'a' }, { id: '' }, 'b'] }),
        ),
      targets: [{ providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }],
    });
    await expect(detect()).resolves.toEqual([
      { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['a'] },
    ]);
    const empty = createLocalDetector({
      fetch: () => Promise.resolve(Response.json({ object: 'list', data: [] })),
      targets: [{ providerId: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' }],
    });
    await expect(empty()).resolves.toEqual([
      { providerId: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', models: [] },
    ]);
  });
  it('counts "data": null, Ollama\'s answer while no model is pulled, as running with no models', async () => {
    const detect = createLocalDetector({
      fetch: () => Promise.resolve(Response.json({ object: 'list', data: null })),
      targets: [{ providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }],
    });
    await expect(detect()).resolves.toEqual([
      { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: [] },
    ]);
  });
});
