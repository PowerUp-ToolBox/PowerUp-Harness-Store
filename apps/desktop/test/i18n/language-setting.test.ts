import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppStateFile } from '../../src/main/runtime/app-state-file.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createSettingsService, parseSettingsPatch } from '../../src/main/runtime/settings.js';

const MAIN_WINDOW = {};

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-store-settings-'));
  path = join(dir, 'app-state.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One app run: a fresh Runtime reading the same userData, on an OS in `osLocale`. */
function launch(osLocale: string) {
  const settings = createSettingsService(createAppStateFile(path), () => osLocale);
  const dispatch = createDispatcher({
    handlers: createHandlers({ app: { version: '1.0.0' }, settings }),
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
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ locale: 'zh-CN' });
  });

  it('choosing System (locale: null) clears the override, back to the OS locale', async () => {
    await launch('zh-CN')('settings.set', { locale: 'en' });
    await expect(launch('zh-CN')('settings.set', { locale: null })).resolves.toEqual({
      ok: true,
      data: { resolvedLocale: 'zh-CN' },
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
  });

  it('keeps the window state when the locale changes', () => {
    const file = createAppStateFile(path);
    const windowState = { x: 1, y: 2, width: 1000, height: 700, isMaximized: false };
    file.update({ windowState });
    createSettingsService(file, () => 'en').set({ locale: 'zh-CN' });
    expect(file.read()).toEqual({ windowState, locale: 'zh-CN' });
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

describe('createAppStateFile locale', () => {
  it.each(['"fr"', '"zh"', '1', 'null'])('reads the stored locale %s as absent', (value) => {
    writeFileSync(path, `{"locale":${value}}`);
    expect(createAppStateFile(path).read()).toEqual({});
  });
});
