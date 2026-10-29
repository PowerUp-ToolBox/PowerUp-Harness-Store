import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway, type Gateway } from '@harness-store/gateway';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGlobalBindingChange } from '../../src/main/runtime/bindings.js';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createFakeCipher } from '../support/fake-cipher.js';
import { manifestWith } from '../support/manifest.js';

/**
 * Default Models (global Slot Bindings) through the real Runtime: set over IPC as the Models page
 * and the wizard do, stored in SQLite, and resolved by the Model Gateway on a loopback port, with
 * fake Providers standing in for vendors. Until Harnesses can be installed (P0-05) the Gateway's
 * `getManifest` answers a fixture Manifest declaring the Slots `default`, `fast` and `summarize`.
 */

const MAIN_WINDOW = {};
const FAKE_KEY = 'fake-provider-key-0123456789';
const MODELS = { 'model-a': 'fake/echo', 'model-b': 'fake/echo' } as const;
const FAKE = 'openai-compatible:fake';

let dataDir: string;
/** A custom endpoint with a key. */
let fake: FakeProvider;
/** A keyless one, added as Ollama. */
let local: FakeProvider;
let runtime: Runtime;
let token: string;

beforeEach(async () => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-default-models-')), 'userData');
  fake = await startFakeProvider({ apiKey: FAKE_KEY, aliases: MODELS });
  local = await startFakeProvider({ aliases: MODELS });
  let created: Gateway | undefined;
  runtime = await startRuntime({
    dataDir,
    version: '1.0.0',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    providerFetch: globalThis.fetch,
    secretCipher: createFakeCipher(),
    createGateway: (options) => {
      created = createGateway({
        ...options,
        getManifest: () => Promise.resolve(manifestWith({ default: {}, fast: {}, summarize: {} })),
        logger: { debug: () => undefined, error: () => undefined },
      });
      return created;
    },
  });
  if (created === undefined) throw new Error('The Runtime did not create a Gateway');
  token = created.issueToken({
    harnessId: 'acme/hello',
    harnessVersion: '1.0.0',
    launchId: 'launch-1',
    locale: 'en',
  });
});
afterEach(async () => {
  await runtime.shutdown();
  await fake.close();
  await local.close();
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

function call(method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

function gatewayUrl(path: string): string {
  const { gateway } = runtime.services.diagnostics.get();
  if (!gateway.running) throw new Error('The Model Gateway is not running');
  return `http://127.0.0.1:${String(gateway.port)}${path}`;
}

/** One chat completion naming `model` (a Slot name), as a Harness sends it. */
async function complete(model: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(gatewayUrl('/v1/chat/completions'), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hello there' }] }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** What a request for `slot` resolved to: the response's `model`, or the error code. */
async function resolvedModel(slot: string): Promise<string> {
  const { status, body } = await complete(slot);
  if (status === 200) return body.model as string;
  return `${String(status)} ${String((body.error as { code: unknown }).code)}`;
}

async function addConnections() {
  await expect(
    call('connections.add', {
      providerId: 'openai-compatible',
      displayName: 'Fake',
      baseUrl: fake.url,
      apiKey: FAKE_KEY,
    }),
  ).resolves.toMatchObject({ ok: true, data: { id: FAKE } });
  await expect(
    call('connections.add', { providerId: 'ollama', baseUrl: local.url }),
  ).resolves.toMatchObject({ ok: true, data: { id: 'ollama' } });
}

function setGlobal(slot: string, connectionId: string | null, model = 'model-a') {
  return call('bindings.setGlobal', {
    slot,
    target: connectionId === null ? null : { connectionId, model },
  });
}

describe('Default Models through the Gateway HTTP seam', () => {
  it('with no Slot Binding at all, every declared Slot answers 409 slot_unbound', async () => {
    await addConnections();
    for (const slot of ['default', 'fast', 'summarize']) {
      const { status, body } = await complete(slot);
      expect(status).toBe(409);
      expect(body.error).toMatchObject({ code: 'slot_unbound', slot, type: 'harness_store' });
    }
  });

  it('a Default Model set over IPC is used by the very next request, and a change by the one after', async () => {
    await addConnections();
    expect(await resolvedModel('default')).toBe('409 slot_unbound');

    await expect(setGlobal('default', FAKE)).resolves.toEqual({
      ok: true,
      data: [{ slot: 'default', connectionId: FAKE, model: 'model-a' }],
    });
    const { status, body } = await complete('default');
    expect(status).toBe(200);
    expect(body.model).toBe(`${FAKE}/model-a`);
    expect(JSON.stringify(body)).toContain('hello there');
    expect(fake.requests.at(-1)).toMatchObject({
      path: '/v1/chat/completions',
      headers: { authorization: `Bearer ${FAKE_KEY}` },
      body: { model: 'model-a' },
    });

    await setGlobal('default', 'ollama', 'model-b');
    expect(await resolvedModel('default')).toBe('ollama/model-b');
    expect(local.requests.at(-1)).toMatchObject({ body: { model: 'model-b' } });

    await expect(setGlobal('default', null)).resolves.toEqual({ ok: true, data: [] });
    expect(await resolvedModel('default')).toBe('409 slot_unbound');
  });

  it('a Slot with its own Default Model uses it; other Slots fall through to `default`', async () => {
    await addConnections();
    await setGlobal('default', FAKE, 'model-a');
    await setGlobal('fast', 'ollama', 'model-b');

    expect(await resolvedModel('fast')).toBe('ollama/model-b');
    expect(await resolvedModel('summarize')).toBe(`${FAKE}/model-a`);
    expect(await resolvedModel('default')).toBe(`${FAKE}/model-a`);

    const models = await fetch(gatewayUrl('/v1/models'), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await models.json()) as { data: unknown[] }).data).toEqual([
      expect.objectContaining({ id: 'default', resolved_model: `${FAKE}/model-a` }),
      expect.objectContaining({ id: 'fast', resolved_model: 'ollama/model-b' }),
      expect.objectContaining({ id: 'summarize', resolved_model: `${FAKE}/model-a` }),
    ]);
  });

  it('only `fast` bound: `fast` resolves and every other Slot is unbound', async () => {
    await addConnections();
    await setGlobal('fast', 'ollama', 'model-b');
    expect(await resolvedModel('fast')).toBe('ollama/model-b');
    expect(await resolvedModel('default')).toBe('409 slot_unbound');
    expect(await resolvedModel('summarize')).toBe('409 slot_unbound');
  });

  it("disabling a Default Model's Connection falls through at once; enabling it brings it back", async () => {
    await addConnections();
    await setGlobal('default', FAKE, 'model-a');
    await setGlobal('fast', 'ollama', 'model-b');

    await call('connections.update', { id: 'ollama', enabled: false });
    expect(await resolvedModel('fast')).toBe(`${FAKE}/model-a`);
    // The binding is kept, so enabling the Connection again restores it.
    await expect(call('bindings.getGlobal')).resolves.toMatchObject({
      data: [{ slot: 'default' }, { slot: 'fast', connectionId: 'ollama' }],
    });

    await call('connections.update', { id: FAKE, enabled: false });
    expect(await resolvedModel('fast')).toBe('409 slot_unbound');
    expect(await resolvedModel('summarize')).toBe('409 slot_unbound');

    await call('connections.update', { id: 'ollama', enabled: true });
    expect(await resolvedModel('fast')).toBe('ollama/model-b');
  });

  it("removing a Default Model's Connection deletes the binding; resolution falls through or is unbound", async () => {
    await addConnections();
    await setGlobal('default', FAKE, 'model-a');
    await setGlobal('fast', 'ollama', 'model-b');

    await call('connections.remove', 'ollama');
    expect(await resolvedModel('fast')).toBe(`${FAKE}/model-a`);
    await call('connections.remove', FAKE);
    expect(await resolvedModel('fast')).toBe('409 slot_unbound');
    expect(await resolvedModel('default')).toBe('409 slot_unbound');
    await expect(call('bindings.getGlobal')).resolves.toEqual({ ok: true, data: [] });
  });
});

describe('bindings.setGlobal', () => {
  it('stores the Default Models in SQLite, `default` first, and keeps them across a relaunch', async () => {
    await addConnections();
    await setGlobal('summarize', 'ollama', 'model-b');
    await setGlobal('default', FAKE, 'model-a');
    await expect(setGlobal('fast', 'ollama', 'qwen3:8b')).resolves.toEqual({
      ok: true,
      data: [
        { slot: 'default', connectionId: FAKE, model: 'model-a' },
        { slot: 'fast', connectionId: 'ollama', model: 'qwen3:8b' },
        { slot: 'summarize', connectionId: 'ollama', model: 'model-b' },
      ],
    });
    // Setting a Slot again replaces its binding.
    await setGlobal('fast', FAKE, 'model-b');

    const databasePath = runtime.services.diagnostics.get().databasePath;
    await runtime.shutdown();
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        db.prepare('SELECT scope, slot, provider_id, model FROM slot_bindings ORDER BY slot').all(),
      ).toEqual([
        { scope: 'global', slot: 'default', provider_id: FAKE, model: 'model-a' },
        { scope: 'global', slot: 'fast', provider_id: FAKE, model: 'model-b' },
        { scope: 'global', slot: 'summarize', provider_id: 'ollama', model: 'model-b' },
      ]);
    } finally {
      db.close();
    }
  });

  it('accepts a model the Provider does not list, as typed by hand', async () => {
    await addConnections();
    await expect(setGlobal('default', 'ollama', 'not-pulled-yet:latest')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('refuses a Connection that does not exist or is disabled with provider_not_connected', async () => {
    await addConnections();
    await call('connections.update', { id: 'ollama', enabled: false });
    for (const connectionId of ['ollama', 'anthropic', 'openai-compatible:other']) {
      await expect(setGlobal('default', connectionId)).resolves.toMatchObject({
        ok: false,
        error: { code: 'provider_not_connected' },
      });
    }
    await expect(call('bindings.getGlobal')).resolves.toEqual({ ok: true, data: [] });
  });

  it('clears a binding whatever state its Connection is in, and clearing nothing is fine', async () => {
    await addConnections();
    await setGlobal('fast', 'ollama', 'model-b');
    await call('connections.update', { id: 'ollama', enabled: false });
    await expect(setGlobal('fast', null)).resolves.toEqual({ ok: true, data: [] });
    await expect(setGlobal('never-bound', null)).resolves.toEqual({ ok: true, data: [] });
  });

  it.each([
    ['a Slot name with capitals', { slot: 'Default', target: null }],
    ['an empty Slot name', { slot: '', target: null }],
    ['a Slot name longer than 32 characters', { slot: `a${'b'.repeat(32)}`, target: null }],
    ['a Slot name with a slash', { slot: 'fast/x', target: null }],
    ['an empty model', { slot: 'default', target: { connectionId: 'ollama', model: '' } }],
    ['a model with a space', { slot: 'default', target: { connectionId: 'ollama', model: 'a b' } }],
    ['a model with ..', { slot: 'default', target: { connectionId: 'ollama', model: '../x' } }],
    [
      'a Provider id the Gateway does not serve',
      { slot: 'default', target: { connectionId: 'nope', model: 'm' } },
    ],
    ['no input', undefined],
    ['no target', { slot: 'default' }],
    ['a target without a model', { slot: 'default', target: { connectionId: 'ollama' } }],
    ['an extra field', { slot: 'default', target: null, scope: 'global' }],
    [
      'an extra target field',
      { slot: 'default', target: { connectionId: 'ollama', model: 'm', x: 1 } },
    ],
    [
      'a model that is not a string',
      { slot: 'default', target: { connectionId: 'ollama', model: 3 } },
    ],
  ])('rejects %s as invalid_input', async (_case, input) => {
    await addConnections();
    await expect(call('bindings.setGlobal', input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method: 'bindings.setGlobal' } },
    });
    await expect(call('bindings.getGlobal')).resolves.toEqual({ ok: true, data: [] });
  });

  it('parseGlobalBindingChange keeps only the fields of the change', () => {
    expect(
      parseGlobalBindingChange({ slot: 'fast', target: { connectionId: 'ollama', model: 'm' } }),
    ).toEqual({ slot: 'fast', target: { connectionId: 'ollama', model: 'm' } });
    expect(parseGlobalBindingChange({ slot: 'fast', target: null })).toEqual({
      slot: 'fast',
      target: null,
    });
  });
});
