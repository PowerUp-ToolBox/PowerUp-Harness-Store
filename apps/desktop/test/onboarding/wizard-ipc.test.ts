import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PROVIDERS } from '@harness-store/gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { parseConnectionDraft, providerPresets } from '../../src/main/runtime/connections.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { parseSettingsPatch } from '../../src/main/runtime/settings.js';
import { createFakeCipher } from '../support/fake-cipher.js';

const MAIN_WINDOW = {};

let dataDir: string;
let started: Runtime[];
beforeEach(() => {
  // A fresh profile: the data directory does not exist yet.
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-onboarding-')), 'userData');
  started = [];
});
afterEach(async () => {
  await Promise.all(started.map((runtime) => runtime.shutdown()));
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

/** One app launch against `dataDir`, without Electron or network. */
async function launch(): Promise<Runtime> {
  const runtime = await startRuntime({
    dataDir,
    version: '1.0.0',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    secretCipher: createFakeCipher(),
  });
  started.push(runtime);
  return runtime;
}

function call(runtime: Runtime, method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

/** The `onboarding_done` row of the settings table, JSON-decoded; undefined when absent. */
function storedOnboardingDone(runtime: Runtime): unknown {
  const db = new DatabaseSync(runtime.services.diagnostics.get().databasePath, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'onboarding_done'").get() as
      { value: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as unknown);
  } finally {
    db.close();
  }
}

describe('onboarding_done across launches', () => {
  it('is false on a fresh profile, so the renderer opens the wizard', async () => {
    const runtime = await launch();
    await expect(call(runtime, 'settings.get')).resolves.toMatchObject({
      ok: true,
      data: { onboardingDone: false },
    });
    expect(storedOnboardingDone(runtime)).toBeUndefined();
  });

  it('is true in the local database once the wizard has ended, and stays true on relaunch', async () => {
    const first = await launch();
    await expect(call(first, 'settings.set', { onboardingDone: true })).resolves.toEqual({
      ok: true,
      data: { resolvedLocale: 'en', onboardingDone: true },
    });
    await first.shutdown();
    expect(storedOnboardingDone(first)).toBe(true);

    const second = await launch();
    await expect(call(second, 'settings.get')).resolves.toEqual({
      ok: true,
      data: { resolvedLocale: 'en', onboardingDone: true },
    });
  });

  it('keeps the language override when onboardingDone is written, and the other way round', async () => {
    const runtime = await launch();
    await call(runtime, 'settings.set', { locale: 'zh-CN' });
    await expect(call(runtime, 'settings.set', { onboardingDone: true })).resolves.toEqual({
      ok: true,
      data: { locale: 'zh-CN', resolvedLocale: 'zh-CN', onboardingDone: true },
    });
    await expect(call(runtime, 'settings.set', { locale: null })).resolves.toEqual({
      ok: true,
      data: { resolvedLocale: 'en', onboardingDone: true },
    });
  });

  it.each([{ onboardingDone: 'yes' }, { onboardingDone: null }, { onboarding_done: true }])(
    'settings.set rejects %j as invalid_input',
    async (input) => {
      const runtime = await launch();
      await expect(call(runtime, 'settings.set', input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
      expect(storedOnboardingDone(runtime)).toBeUndefined();
    },
  );

  it('parseSettingsPatch accepts both keys together', () => {
    expect(parseSettingsPatch({ locale: 'en', onboardingDone: false })).toEqual({
      locale: 'en',
      onboardingDone: false,
    });
  });
});

describe('providers.list', () => {
  it("lists every Provider of the Gateway's table in order, marking the local and custom ones", async () => {
    const runtime = await launch();
    const result = await call(runtime, 'providers.list');
    expect(result.ok).toBe(true);
    const presets = result.ok ? (result.data as ReturnType<typeof providerPresets>) : [];
    expect(presets.map((preset) => preset.id)).toEqual(PROVIDERS.map((provider) => provider.id));
    expect(presets.filter((preset) => preset.local).map((preset) => preset.id)).toEqual([
      'ollama',
      'lmstudio',
    ]);
    expect(presets.filter((preset) => preset.custom).map((preset) => preset.id)).toEqual([
      'openai-compatible',
    ]);
    expect(presets[0]).toEqual({
      id: 'anthropic',
      displayName: 'Anthropic',
      requiresKey: true,
      custom: false,
      local: false,
      baseUrl: 'https://api.anthropic.com/v1',
      docsUrl: 'https://docs.claude.com/en/api/overview',
      supportsModelList: false,
      keyPlaceholder: 'sk-ant-...',
    });
    expect(presets.find((preset) => preset.custom)).toMatchObject({ baseUrl: null });
  });

  it('follows the table it is given', () => {
    expect(
      providerPresets(PROVIDERS.filter((provider) => provider.id === 'ollama')).map(
        (preset) => preset.id,
      ),
    ).toEqual(['ollama']);
  });
});

describe('connections for the wizard', () => {
  it('connections.detectLocal finds nothing until P0-03.3', async () => {
    const runtime = await launch();
    await expect(call(runtime, 'connections.detectLocal')).resolves.toEqual({ ok: true, data: [] });
  });

  it('connections.add saves what the Remote Provider step sends, and the Connection stays after a relaunch', async () => {
    const first = await launch();
    await expect(
      call(first, 'connections.add', { providerId: 'anthropic', apiKey: 'sk-ant-test-0123456789' }),
    ).resolves.toMatchObject({
      ok: true,
      data: { id: 'anthropic', providerId: 'anthropic', keyHint: '6789', enabled: true },
    });
    await first.shutdown();
    const second = await launch();
    await expect(call(second, 'connections.list')).resolves.toMatchObject({
      ok: true,
      data: [{ id: 'anthropic', keyHint: '6789' }],
    });
  });

  it.each([
    undefined,
    'anthropic',
    {},
    { providerId: 'nope' },
    { providerId: 'anthropic', apiKey: 42 },
    { providerId: 'openai-compatible', baseUrl: null },
    { providerId: 'anthropic', secret: 'x' },
  ])('connections.add rejects %j as invalid_input', async (input) => {
    const runtime = await launch();
    await expect(call(runtime, 'connections.add', input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method: 'connections.add' } },
    });
  });

  it('parseConnectionDraft accepts a named custom endpoint and a local Provider', () => {
    const custom = {
      providerId: 'openai-compatible',
      displayName: 'vLLM',
      baseUrl: 'http://10.0.0.2:8000/v1',
    };
    expect(parseConnectionDraft(custom)).toEqual(custom);
    const local = { providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' };
    expect(parseConnectionDraft(local)).toEqual(local);
  });
});
