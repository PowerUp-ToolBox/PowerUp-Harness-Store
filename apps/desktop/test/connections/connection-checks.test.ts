import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAKE_SCENARIOS,
  startFakeProvider,
  type FakeProvider,
} from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createFakeCipher } from '../support/fake-cipher.js';

/**
 * Connection tests and model listing over IPC, as the Models page calls them, through the real
 * Runtime with the real test and listing (the Gateway package's) against the fake Provider on
 * loopback. The Runtime's clock is a fake one, to step over the 10-minute model-list cache.
 */

const MAIN_WINDOW = {};
const FAKE_KEY = 'fake-provider-key-0123456789';
const T0 = new Date('2026-10-28T09:00:00.000Z');

let dataDir: string;
let fake: FakeProvider;
let clock: Date;
let runtime: Runtime;

beforeEach(async () => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-connection-checks-')), 'userData');
  fake = await startFakeProvider({ apiKey: FAKE_KEY });
  clock = T0;
  runtime = await startRuntime({
    dataDir,
    version: '1.0.0',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    providerFetch: globalThis.fetch,
    now: () => clock,
    secretCipher: createFakeCipher(),
  });
});
afterEach(async () => {
  await runtime.shutdown();
  await fake.close();
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

function call(method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

const FAKE_MODELS = FAKE_SCENARIOS.map((id) => ({ id }));

function addFake(apiKey = FAKE_KEY) {
  return call('connections.add', {
    providerId: 'openai-compatible',
    displayName: 'Fake',
    baseUrl: fake.url,
    apiKey,
  });
}

/** How many model listings reached the fake. */
const listings = () => fake.requests.filter((request) => request.path === '/v1/models').length;

describe('model listing', () => {
  it("returns the Provider's own list and reuses it for 10 minutes", async () => {
    await expect(addFake()).resolves.toMatchObject({
      ok: true,
      data: { lastTestOk: true, lastTestedAt: T0.toISOString(), models: [...FAKE_SCENARIOS] },
    });
    // The add's test listed the models: opening the picker right after asks nobody.
    expect(listings()).toBe(1);
    await expect(call('connections.models', 'openai-compatible:fake')).resolves.toEqual({
      ok: true,
      data: FAKE_MODELS,
    });
    expect(listings()).toBe(1);

    clock = new Date(T0.getTime() + 9 * 60 * 1000);
    await call('connections.models', 'openai-compatible:fake');
    expect(listings()).toBe(1);

    clock = new Date(T0.getTime() + 10 * 60 * 1000);
    await expect(call('connections.models', 'openai-compatible:fake')).resolves.toEqual({
      ok: true,
      data: FAKE_MODELS,
    });
    expect(listings()).toBe(2);
    expect(fake.requests.at(-1)?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });
});

describe('testing a Connection', () => {
  it("stores a failed test with the Provider's exact error text", async () => {
    await addFake();
    // The Provider rotates its key: the same port now wants another one.
    const { port } = fake;
    await fake.close();
    fake = await startFakeProvider({ port, apiKey: 'the-rotated-key-0123456789' });
    clock = new Date(T0.getTime() + 60_000);

    await expect(call('connections.test', { id: 'openai-compatible:fake' })).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({
        lastTestedAt: '2026-10-28T09:01:00.000Z',
        lastTestOk: false,
        lastTestError: 'Incorrect API key provided.',
      }) as unknown,
    });
    await expect(call('connections.list')).resolves.toMatchObject({
      ok: true,
      data: [{ id: 'openai-compatible:fake', lastTestError: 'Incorrect API key provided.' }],
    });
  });

  it('says why an endpoint cannot be reached, with the cause', async () => {
    await addFake();
    // close() is idempotent, so afterEach closing it again is fine.
    await fake.close();
    const result = await call('connections.test', { id: 'openai-compatible:fake' });
    expect(result).toMatchObject({
      ok: true,
      data: {
        lastTestOk: false,
        lastTestError: expect.stringMatching(/^fetch failed: .*ECONNREFUSED/) as string,
      },
    });
  });

  it('a draft with a bad key fails with the Provider text and saves nothing', async () => {
    await expect(
      call('connections.testDraft', {
        providerId: 'openai-compatible',
        baseUrl: fake.url,
        apiKey: 'a-wrong-key-0123456789',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'provider_error',
        params: { detail: 'Incorrect API key provided.' },
        message: 'The Provider answered with an error: Incorrect API key provided.',
      },
    });
    await expect(
      call('connections.testDraft', {
        providerId: 'openai-compatible',
        baseUrl: fake.url,
        apiKey: FAKE_KEY,
      }),
    ).resolves.toEqual({ ok: true, data: { models: FAKE_MODELS } });
    await expect(call('connections.list')).resolves.toEqual({ ok: true, data: [] });
  });

  it('adding against a port nothing listens on fails, with the cause', async () => {
    const result = await call('connections.add', {
      providerId: 'ollama',
      baseUrl: `http://127.0.0.1:${String(await closedPort())}/v1`,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'provider_error' } });
    expect(result.ok ? '' : result.error.params?.detail).toMatch(/ECONNREFUSED/);
  });
});

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (typeof address !== 'object' || address === null) throw new Error('No port');
  return address.port;
}
