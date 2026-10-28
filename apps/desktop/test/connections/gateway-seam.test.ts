import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway, type Gateway } from '@harness-store/gateway';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createFakeCipher } from '../support/fake-cipher.js';

/**
 * Through the Gateway HTTP seam: the real Runtime (SQLite, the Connections service, the Model
 * Gateway on a loopback port) with the fake Provider standing in for a vendor. Connections are
 * changed over IPC, as the Models page does, and every Gateway request right after sees the change.
 */

const MAIN_WINDOW = {};
const FAKE_KEY = 'fake-provider-key-0123456789';

let dataDir: string;
let fake: FakeProvider;
/** A fake Provider that wants no key, as Ollama. */
let keyless: FakeProvider;
let runtime: Runtime;
let gateway: Gateway;
let token: string;

beforeEach(async () => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-gateway-seam-')), 'userData');
  fake = await startFakeProvider({ apiKey: FAKE_KEY });
  keyless = await startFakeProvider();
  let created: Gateway | undefined;
  runtime = await startRuntime({
    dataDir,
    version: '1.0.0',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    // Connection tests reach the fake Providers on loopback, nothing else.
    providerFetch: globalThis.fetch,
    secretCipher: createFakeCipher(),
    createGateway: (options) => {
      created = createGateway({
        ...options,
        logger: { debug: () => undefined, error: () => undefined },
      });
      return created;
    },
  });
  if (created === undefined) throw new Error('The Runtime did not create a Gateway');
  gateway = created;
  token = gateway.issueToken({
    harnessId: 'acme/hello',
    harnessVersion: '1.0.0',
    launchId: 'launch-1',
    locale: 'en',
  });
});
afterEach(async () => {
  await runtime.shutdown();
  await fake.close();
  await keyless.close();
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

function call(method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

/** One chat completion through the Gateway, as a Harness sends it. */
async function complete(model: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { gateway: status } = runtime.services.diagnostics.get();
  if (!status.running) throw new Error('The Model Gateway is not running');
  const response = await fetch(`http://127.0.0.1:${String(status.port)}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello there' }] }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const errorCode = (body: Record<string, unknown>) => (body.error as { code?: unknown }).code;

const MODEL = 'openai-compatible:fake/fake/echo';

describe('Connections and the Model Gateway', () => {
  it('a Connection added over IPC is used by the very next Gateway request, with its decrypted key', async () => {
    const before = await complete(MODEL);
    expect(before.status).toBe(403);
    expect(errorCode(before.body)).toBe('provider_not_connected');

    await expect(
      call('connections.add', {
        providerId: 'openai-compatible',
        displayName: 'Fake',
        baseUrl: fake.url,
        apiKey: FAKE_KEY,
      }),
    ).resolves.toMatchObject({ ok: true, data: { id: 'openai-compatible:fake' } });

    const after = await complete(MODEL);
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).toContain('hello there');
    expect(fake.requests.at(-1)?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('a preset Connection with its own base URL reaches it (Ollama on another port)', async () => {
    await expect(
      call('connections.add', { providerId: 'ollama', baseUrl: keyless.url }),
    ).resolves.toMatchObject({ ok: true });
    const response = await complete('ollama/fake/echo');
    expect(response.status).toBe(200);
    expect(keyless.requests.at(-1)?.path).toBe('/v1/chat/completions');
  });

  it('disabling, enabling and removing apply to the next request; a removed key is gone', async () => {
    await call('connections.add', {
      providerId: 'openai-compatible',
      displayName: 'Fake',
      baseUrl: fake.url,
      apiKey: FAKE_KEY,
    });
    // The add's own test (GET /models) is not a Gateway request.
    fake.reset();
    expect((await complete(MODEL)).status).toBe(200);

    await call('connections.update', { id: 'openai-compatible:fake', enabled: false });
    const disabled = await complete(MODEL);
    expect(disabled.status).toBe(403);
    expect(errorCode(disabled.body)).toBe('provider_not_connected');

    await call('connections.update', { id: 'openai-compatible:fake', enabled: true });
    expect((await complete(MODEL)).status).toBe(200);

    await expect(call('connections.remove', 'openai-compatible:fake')).resolves.toEqual({
      ok: true,
      data: null,
    });
    const removed = await complete(MODEL);
    expect(removed.status).toBe(403);
    expect(errorCode(removed.body)).toBe('provider_not_connected');
    expect(fake.requests).toHaveLength(2);
  });

  it('a key that fails its test is refused with the Provider text, and the stored one keeps working', async () => {
    await call('connections.add', {
      providerId: 'openai-compatible',
      displayName: 'Fake',
      baseUrl: fake.url,
      apiKey: FAKE_KEY,
    });
    await expect(
      call('connections.update', {
        id: 'openai-compatible:fake',
        apiKey: 'an-outdated-key-0123456789',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_error', params: { detail: 'Incorrect API key provided.' } },
    });
    expect((await complete(MODEL)).status).toBe(200);
    expect(fake.requests.at(-1)?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it('a replaced key and base URL that pass their test are used by the next request', async () => {
    const moved = await startFakeProvider({ apiKey: 'the-new-key-0123456789' });
    try {
      await call('connections.add', {
        providerId: 'openai-compatible',
        displayName: 'Fake',
        baseUrl: fake.url,
        apiKey: FAKE_KEY,
      });
      await expect(
        call('connections.update', {
          id: 'openai-compatible:fake',
          baseUrl: moved.url,
          apiKey: 'the-new-key-0123456789',
        }),
      ).resolves.toMatchObject({ ok: true, data: { keyHint: '6789', lastTestOk: true } });
      expect((await complete(MODEL)).status).toBe(200);
      expect(moved.requests.at(-1)).toMatchObject({
        path: '/v1/chat/completions',
        headers: { authorization: 'Bearer the-new-key-0123456789' },
      });
    } finally {
      await moved.close();
    }
  });

  it('a removed Connection leaves no Slot Binding pointing at it', async () => {
    await call('connections.add', { providerId: 'ollama', baseUrl: keyless.url });
    const db = new DatabaseSync(runtime.services.diagnostics.get().databasePath);
    try {
      db.prepare(
        "INSERT INTO slot_bindings (scope, slot, provider_id, model) VALUES ('global', 'default', 'ollama', 'qwen3:8b')",
      ).run();
      await expect(call('bindings.getGlobal')).resolves.toEqual({
        ok: true,
        data: [{ slot: 'default', connectionId: 'ollama', model: 'qwen3:8b' }],
      });
      await call('connections.remove', 'ollama');
      await expect(call('bindings.getGlobal')).resolves.toEqual({ ok: true, data: [] });
      expect(db.prepare('SELECT COUNT(*) AS n FROM slot_bindings').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('a key that cannot be decrypted fails the request with 500 internal_error', async () => {
    await call('connections.add', {
      providerId: 'openai-compatible',
      displayName: 'Fake',
      baseUrl: fake.url,
      apiKey: FAKE_KEY,
    });
    const db = new DatabaseSync(runtime.services.diagnostics.get().databasePath);
    try {
      db.prepare('UPDATE secrets SET ciphertext = ?').run(new Uint8Array([1, 2, 3]));
    } finally {
      db.close();
    }
    fake.reset();
    const response = await complete(MODEL);
    expect(response.status).toBe(500);
    expect(errorCode(response.body)).toBe('internal_error');
    expect(fake.requests).toHaveLength(0);
  });

  it('a Slot name resolves to nothing yet: no Harness is installed (P0-05) and no resolver (P0-03.4)', async () => {
    const response = await complete('default');
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('unknown_slot');
  });
});
