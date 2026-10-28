import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/runtime/database.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import type { Services } from '../../src/main/runtime/services.js';
import { createSqliteSettingsStore } from '../../src/main/runtime/settings-store.js';
import { createSettingsService, parseSettingsPatch } from '../../src/main/runtime/settings.js';

const MAIN_WINDOW = {};

let dir: string;
let path: string;
let opened: DatabaseSync[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-store-settings-'));
  path = join(dir, 'harness-store.sqlite');
  opened = [];
});
afterEach(() => {
  for (const db of opened) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The database of one app run, on the same userData. */
function database(): DatabaseSync {
  const db = openDatabase(path);
  opened.push(db);
  return db;
}

/** The `settings` table's rows, values JSON-decoded. */
function storedSettings(): Record<string, unknown> {
  const rows = database().prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map(({ key, value }) => [key, JSON.parse(value) as unknown]));
}

/** One app run: a fresh Runtime reading the same userData, on an OS in `osLocale`. */
function launch(osLocale: string) {
  const services: Services = {
    app: { version: '1.0.0', status: () => ({ state: 'ready' }), quit: () => undefined },
    settings: createSettingsService(createSqliteSettingsStore(database()), () => osLocale),
    diagnostics: {
      get: () => ({ version: '1.0.0', gateway: { running: false }, databasePath: path }),
    },
    connectivity: {
      get: () => ({ state: 'online' }),
      check: () => Promise.resolve({ state: 'online' }),
    },
  };
  const dispatch = createDispatcher({
    handlers: createHandlers(services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return (method: string, input?: unknown) => dispatch(MAIN_WINDOW, { method, input });
}

describe('language setting over IPC', () => {
  it('first launch on a zh-TW OS renders in zh-CN; on en-US in en', async () => {
    await expect(launch('zh-TW')('settings.get')).resolves.toEqual({
      ok: true,
      data: { resolvedLocale: 'zh-CN' },
    });
    await expect(launch('en-US')('settings.get')).resolves.toEqual({
      ok: true,
      data: { resolvedLocale: 'en' },
    });
  });

  it('settings.set returns the new settings with the resolved locale', async () => {
    const call = launch('en-US');
    await expect(call('settings.set', { locale: 'zh-CN' })).resolves.toEqual({
      ok: true,
      data: { locale: 'zh-CN', resolvedLocale: 'zh-CN' },
    });
  });

  it('the choice persists across restarts and overrides the OS locale', async () => {
    await launch('en-US')('settings.set', { locale: 'zh-CN' });
    await expect(launch('en-US')('settings.get')).resolves.toEqual({
      ok: true,
      data: { locale: 'zh-CN', resolvedLocale: 'zh-CN' },
    });
    expect(storedSettings()).toEqual({ locale: 'zh-CN' });
  });

  it('choosing System (locale: null) clears the override, back to the OS locale', async () => {
    await launch('zh-CN')('settings.set', { locale: 'en' });
    await expect(launch('zh-CN')('settings.set', { locale: null })).resolves.toEqual({
      ok: true,
      data: { resolvedLocale: 'zh-CN' },
    });
    expect(storedSettings()).toEqual({});
  });

  it('keeps the window state when the locale changes', () => {
    const store = createSqliteSettingsStore(database());
    const windowState = { x: 1, y: 2, width: 1000, height: 700, isMaximized: false };
    store.write('window_state', windowState);
    createSettingsService(store, () => 'en').set({ locale: 'zh-CN' });
    expect(storedSettings()).toEqual({ window_state: windowState, locale: 'zh-CN' });
  });

  it.each([
    undefined,
    null,
    'zh-CN',
    [],
    { locale: 'fr' },
    { locale: 'zh' },
    { locale: 1 },
    { theme: 'dark' },
  ])('settings.set rejects %j as invalid_input', async (input) => {
    await expect(launch('en')('settings.set', input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method: 'settings.set' } },
    });
  });

  it('settings.get takes no input', async () => {
    await expect(launch('en')('settings.get', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });
});

describe('parseSettingsPatch', () => {
  it.each([
    [{}, {}],
    [{ locale: 'en' }, { locale: 'en' }],
    [{ locale: null }, { locale: null }],
  ])('accepts %j', (input, expected) => {
    expect(parseSettingsPatch(input)).toEqual(expected);
  });
});

describe('stored locale', () => {
  it.each(['"fr"', '"zh"', '1', 'null', '{not json'])(
    'reads the stored value %s as absent',
    (value) => {
      database().prepare("INSERT INTO settings (key, value) VALUES ('locale', ?)").run(value);
      expect(
        createSettingsService(createSqliteSettingsStore(database()), () => 'en').get(),
      ).toEqual({
        resolvedLocale: 'en',
      });
    },
  );
});
