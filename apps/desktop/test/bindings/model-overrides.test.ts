import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * Ticket P0-03.5, Model Overrides and Recommended Models, through the Gateway HTTP seam: the real
 * Runtime with its SQLite stores, the fake cipher and the real resolver; a fixture Harness
 * installed from a folder (its Manifest recommends `anthropic/claude-x`, then `ollama/model-b`, for
 * its `default` Slot); fake Providers standing in for the vendors. Every change goes over IPC, as
 * the Models page makes it, and the very next Gateway request shows it.
 */

const FIXTURE = join(import.meta.dirname, '../fixtures/harnesses/fixture-web');
const HARNESS_ID = 'acme/fixture-web';
const MAIN_WINDOW = {};
const FAKE_KEY = 'fake-provider-key-0123456789';
const MODELS = { 'model-a': 'fake/echo', 'model-b': 'fake/echo', 'model-c': 'fake/echo' } as const;
const FAKE = 'openai-compatible:fake';

let root: string;
let folder: string;
/** A custom endpoint with a key. */
let fake: FakeProvider;
/** A keyless one, added as Ollama. */
let local: FakeProvider;
let runtime: Runtime;
let token: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-overrides-'));
  folder = join(root, 'my-harness');
  cpSync(FIXTURE, folder, { recursive: true });
  editManifest((manifest) => {
    manifest.models = {
      slots: {
        default: {
          description: 'Reviews the diff.',
          requirements: { tools: true },
          recommended: ['anthropic/claude-x', 'ollama/model-b'],
        },
        fast: { description: 'Names things.' },
      },
    };
  });
  fake = await startFakeProvider({ apiKey: FAKE_KEY, aliases: MODELS });
  local = await startFakeProvider({ aliases: MODELS });
  let created: Gateway | undefined;
  runtime = await startRuntime({
    dataDir: join(root, 'userData'),
    version: '1.0.0',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    providerFetch: globalThis.fetch,
    secretCipher: createFakeCipher(),
    platform: 'linux-x64',
    createGateway: (options) => {
      created = createGateway({
        ...options,
        logger: { debug: () => undefined, error: () => undefined },
      });
      return created;
    },
  });
  if (created === undefined) throw new Error('The Runtime did not create a Gateway');
  token = created.issueToken({
    harnessId: HARNESS_ID,
    harnessVersion: '1.0.0',
    launchId: 'launch-1',
    locale: 'en',
  });
  await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({ ok: true });
});
afterEach(async () => {
  await runtime.shutdown();
  await fake.close();
  await local.close();
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

/** Edits the copied fixture's manifest.json as a Publisher would. */
function editManifest(change: (manifest: Record<string, unknown>) => void) {
  const path = join(folder, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

/** What a request for `slot` resolved to: the response's `model`, or the error code. */
async function resolvedModel(slot: string): Promise<string> {
  const port = runtime.gatewayPort();
  if (port === null) throw new Error('The Model Gateway is not running');
  const response = await fetch(`http://127.0.0.1:${String(port)}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: slot, messages: [{ role: 'user', content: 'hello there' }] }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status === 200) return body.model as string;
  return `${String(response.status)} ${String((body.error as { code: unknown }).code)}`;
}

/** What `bindings.resolveAll` says the `default` Slot resolves to, and why. */
async function defaultSlot() {
  const result = await call('bindings.resolveAll', HARNESS_ID);
  if (!result.ok) throw new Error(result.error.message);
  return (result.data as { slot: string; binding: unknown }[]).find(
    (slot) => slot.slot === 'default',
  )?.binding;
}

async function addFake() {
  await expect(
    call('connections.add', {
      providerId: 'openai-compatible',
      displayName: 'Fake',
      baseUrl: fake.url,
      apiKey: FAKE_KEY,
    }),
  ).resolves.toMatchObject({ ok: true, data: { id: FAKE } });
}

async function addOllama() {
  await expect(
    call('connections.add', { providerId: 'ollama', baseUrl: local.url }),
  ).resolves.toMatchObject({ ok: true, data: { id: 'ollama' } });
}

const override = (slot: string, connectionId: string, model: string) =>
  call('bindings.setOverride', { harnessId: HARNESS_ID, slot, target: { connectionId, model } });

describe('Recommended Models and Model Overrides through the Gateway HTTP seam', () => {
  it('with only a Connection for the second Recommended Model, the request uses it, source recommended', async () => {
    await addOllama();
    expect(await resolvedModel('default')).toBe('ollama/model-b');
    expect(local.requests.at(-1)).toMatchObject({
      path: '/v1/chat/completions',
      body: { model: 'model-b' },
    });
    await expect(defaultSlot()).resolves.toEqual({
      connectionId: 'ollama',
      model: 'model-b',
      source: 'recommended',
    });
  });

  it('a Recommended Model wins over a Default Model whose Connection is reachable too', async () => {
    await addOllama();
    await addFake();
    await call('bindings.setGlobal', {
      slot: 'default',
      target: { connectionId: FAKE, model: 'model-a' },
    });
    expect(await resolvedModel('default')).toBe('ollama/model-b');
    // The `fast` Slot recommends nothing: the Default Model of `default`.
    expect(await resolvedModel('fast')).toBe(`${FAKE}/model-a`);
  });

  it('an override wins at once; clearing it reverts to the automatic choice', async () => {
    await addOllama();
    await addFake();
    await expect(override('default', FAKE, 'model-c')).resolves.toEqual({
      ok: true,
      data: [{ slot: 'default', connectionId: FAKE, model: 'model-c' }],
    });
    expect(await resolvedModel('default')).toBe(`${FAKE}/model-c`);
    expect(fake.requests.at(-1)).toMatchObject({ body: { model: 'model-c' } });
    await expect(defaultSlot()).resolves.toEqual({
      connectionId: FAKE,
      model: 'model-c',
      source: 'override',
    });

    await expect(
      call('bindings.clearOverride', { harnessId: HARNESS_ID, slot: 'default' }),
    ).resolves.toEqual({ ok: true, data: [] });
    expect(await resolvedModel('default')).toBe('ollama/model-b');
    await expect(defaultSlot()).resolves.toMatchObject({ source: 'recommended' });
  });

  it("disabling the override's Connection falls through the order; enabling it brings it back", async () => {
    await addOllama();
    await addFake();
    await call('bindings.setGlobal', {
      slot: 'fast',
      target: { connectionId: 'ollama', model: 'model-a' },
    });
    await call('bindings.setGlobal', {
      slot: 'default',
      target: { connectionId: 'ollama', model: 'model-c' },
    });
    await override('fast', FAKE, 'model-b');
    await override('default', FAKE, 'model-b');
    expect(await resolvedModel('fast')).toBe(`${FAKE}/model-b`);

    await call('connections.update', { id: FAKE, enabled: false });
    // `fast`: no Recommended Models, so its own Default Model; `default`: its Recommended Model.
    expect(await resolvedModel('fast')).toBe('ollama/model-a');
    expect(await resolvedModel('default')).toBe('ollama/model-b');
    await call('connections.update', { id: 'ollama', enabled: false });
    expect(await resolvedModel('fast')).toBe('409 slot_unbound');
    await expect(defaultSlot()).resolves.toBeNull();
    // The overrides are kept while their Connection is disabled.
    await expect(call('bindings.getForHarness', HARNESS_ID)).resolves.toEqual({
      ok: true,
      data: [
        { slot: 'default', connectionId: FAKE, model: 'model-b' },
        { slot: 'fast', connectionId: FAKE, model: 'model-b' },
      ],
    });

    await call('connections.update', { id: FAKE, enabled: true });
    expect(await resolvedModel('fast')).toBe(`${FAKE}/model-b`);
    expect(await resolvedModel('default')).toBe(`${FAKE}/model-b`);
  });

  it("removing the override's Connection deletes the override and falls through", async () => {
    await addOllama();
    await addFake();
    await override('default', FAKE, 'model-c');
    await call('connections.remove', FAKE);
    expect(await resolvedModel('default')).toBe('ollama/model-b');
    await expect(call('bindings.getForHarness', HARNESS_ID)).resolves.toEqual({
      ok: true,
      data: [],
    });
  });

  it('an override is accepted even when the model does not meet the Slot requirements', async () => {
    await addOllama();
    // Nothing is known of a typed model's capabilities, and nothing would refuse it anyway.
    await expect(override('default', 'ollama', 'tiny-no-tools')).resolves.toMatchObject({
      ok: true,
    });
    await expect(defaultSlot()).resolves.toEqual({
      connectionId: 'ollama',
      model: 'tiny-no-tools',
      source: 'override',
    });
  });

  it('is stored per Harness in slot_bindings, beside the Default Models', async () => {
    await addOllama();
    await call('bindings.setGlobal', {
      slot: 'default',
      target: { connectionId: 'ollama', model: 'model-a' },
    });
    await override('fast', 'ollama', 'model-c');
    const db = new DatabaseSync(runtime.databasePath, {
      readOnly: true,
    });
    try {
      expect(
        db
          .prepare('SELECT scope, slot, provider_id, model FROM slot_bindings ORDER BY scope')
          .all(),
      ).toEqual([
        { scope: 'global', slot: 'default', provider_id: 'ollama', model: 'model-a' },
        { scope: `harness:${HARNESS_ID}`, slot: 'fast', provider_id: 'ollama', model: 'model-c' },
      ]);
    } finally {
      db.close();
    }
  });

  it('an override for a Slot a newer version no longer declares is ignored, not deleted', async () => {
    await addOllama();
    await override('fast', 'ollama', 'model-c');
    editManifest((manifest) => {
      manifest.version = '1.1.0';
      manifest.models = { slots: { default: {} } };
    });
    await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({ ok: true });

    await expect(call('bindings.resolveAll', HARNESS_ID)).resolves.toEqual({
      ok: true,
      data: [{ slot: 'default', binding: null }],
    });
    expect(await resolvedModel('fast')).toBe('404 unknown_slot');
    await expect(call('bindings.getForHarness', HARNESS_ID)).resolves.toEqual({
      ok: true,
      data: [{ slot: 'fast', connectionId: 'ollama', model: 'model-c' }],
    });
  });
});

describe('bindings.setOverride, clearOverride, getForHarness and resolveAll', () => {
  it('lists every declared Slot, `default` first, unbound without a Connection', async () => {
    await expect(call('bindings.resolveAll', HARNESS_ID)).resolves.toEqual({
      ok: true,
      data: [
        { slot: 'default', binding: null },
        { slot: 'fast', binding: null },
      ],
    });
  });

  it('refuses a Harness that is not installed with not_installed', async () => {
    await addOllama();
    await expect(call('bindings.resolveAll', 'acme/other')).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_installed' },
    });
    await expect(
      call('bindings.setOverride', {
        harnessId: 'acme/other',
        slot: 'default',
        target: { connectionId: 'ollama', model: 'm' },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_installed' } });
    await expect(call('bindings.getForHarness', 'acme/other')).resolves.toEqual({
      ok: true,
      data: [],
    });
  });

  it('refuses a Slot the Manifest does not declare with invalid_input', async () => {
    await addOllama();
    for (const slot of ['summarize', 'constructor', 'Default']) {
      await expect(override(slot, 'ollama', 'm')).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input', params: { method: 'bindings.setOverride' } },
      });
    }
  });

  it('refuses a missing or disabled Connection with provider_not_connected', async () => {
    await addOllama();
    await call('connections.update', { id: 'ollama', enabled: false });
    for (const connectionId of ['ollama', 'anthropic']) {
      await expect(override('default', connectionId, 'm')).resolves.toMatchObject({
        ok: false,
        error: { code: 'provider_not_connected' },
      });
    }
    await expect(override('default', 'nope', 'm')).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    await expect(override('default', 'ollama', '../x')).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    await expect(call('bindings.getForHarness', HARNESS_ID)).resolves.toEqual({
      ok: true,
      data: [],
    });
  });

  it('a second override of the same Slot replaces the first; clearing nothing is fine', async () => {
    await addOllama();
    await override('default', 'ollama', 'model-a');
    await expect(override('default', 'ollama', 'model-c')).resolves.toEqual({
      ok: true,
      data: [{ slot: 'default', connectionId: 'ollama', model: 'model-c' }],
    });
    await expect(
      call('bindings.clearOverride', { harnessId: HARNESS_ID, slot: 'fast' }),
    ).resolves.toEqual({
      ok: true,
      data: [{ slot: 'default', connectionId: 'ollama', model: 'model-c' }],
    });
  });
});

describe('bindings.resolveManifest (the Store detail page, P0-09.3)', () => {
  /** A Store Manifest's `models` that is not installed: `default` needs tools, `vision` asks more. */
  const STORE_MODELS = {
    slots: {
      default: { requirements: { tools: true }, recommended: ['ollama/model-b'] },
      vision: { requirements: { vision: true }, recommended: ['anthropic/claude-x'] },
    },
  };

  async function resolveManifest(harnessId: string, models: unknown) {
    const result = await call('bindings.resolveManifest', { harnessId, models });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }

  it('resolves a Harness that is not installed, Slot by Slot, as the Gateway would', async () => {
    // Nothing can fill either Slot yet.
    await expect(resolveManifest('bob/not-installed', STORE_MODELS)).resolves.toEqual([
      { slot: 'default', binding: null },
      { slot: 'vision', binding: null },
    ]);
    await addOllama();
    // `default` by its Recommended Model; `vision` recommends an Anthropic model no Connection
    // serves, and no Default Model is set: not reachable. Model Requirements are not checked.
    await expect(resolveManifest('bob/not-installed', STORE_MODELS)).resolves.toEqual([
      {
        slot: 'default',
        binding: { connectionId: 'ollama', model: 'model-b', source: 'recommended' },
      },
      { slot: 'vision', binding: null },
    ]);
    await addFake();
    await call('bindings.setGlobal', {
      slot: 'default',
      target: { connectionId: FAKE, model: 'model-a' },
    });
    await expect(resolveManifest('bob/not-installed', STORE_MODELS)).resolves.toEqual([
      {
        slot: 'default',
        binding: { connectionId: 'ollama', model: 'model-b', source: 'recommended' },
      },
      { slot: 'vision', binding: { connectionId: FAKE, model: 'model-a', source: 'default' } },
    ]);
  });

  it('accepts a Recommended Model id of any length, as the Manifest schema does', async () => {
    await addOllama();
    const models = {
      slots: {
        default: { recommended: [`openrouter/${'x'.repeat(300)}`, 'ollama/model-b'] },
        vision: { recommended: [`anthropic/${'y'.repeat(300)}`] },
      },
    };
    await expect(resolveManifest('bob/not-installed', models)).resolves.toEqual([
      {
        slot: 'default',
        binding: { connectionId: 'ollama', model: 'model-b', source: 'recommended' },
      },
      { slot: 'vision', binding: null },
    ]);
  });

  it("counts the Harness's Model Overrides when it has some, exactly as resolveAll does", async () => {
    await addOllama();
    await addFake();
    await override('default', FAKE, 'model-c');
    const installed = await call('bindings.resolveAll', HARNESS_ID);
    if (!installed.ok) throw new Error(installed.error.message);
    const { models } = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
      models: unknown;
    };
    await expect(resolveManifest(HARNESS_ID, models)).resolves.toEqual(installed.data);
    expect(installed.data).toContainEqual({
      slot: 'default',
      binding: { connectionId: FAKE, model: 'model-c', source: 'override' },
    });
  });
});
