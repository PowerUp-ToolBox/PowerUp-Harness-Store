import { act, render, type RenderResult } from '@testing-library/react';
import { HashRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../../src/renderer/src/App.js';
import { I18nProvider } from '../../src/renderer/src/i18n/I18nProvider.js';
import type { Locale } from '../../src/shared/i18n/locale.js';
import type { IpcResult, Settings, SettingsPatch } from '../../src/shared/ipc.js';

/**
 * A fake `window.api` whose settings behave like the Runtime's: `osLocale` stands in for
 * `app.getLocale()` and an override set through `settings.set` wins over it.
 */
export function installFakeApi(osLocale: Locale = 'en', override?: Locale) {
  let locale = override;
  const current = (): Settings =>
    locale === undefined ? { resolvedLocale: osLocale } : { locale, resolvedLocale: locale };
  const api = {
    app: { ping: vi.fn(() => Promise.resolve({ ok: true, data: { version: '4.5.6' } })) },
    settings: {
      get: vi.fn(() => Promise.resolve({ ok: true, data: current() })),
      set: vi.fn((patch: SettingsPatch): Promise<IpcResult<Settings>> => {
        if (patch.locale !== undefined) locale = patch.locale ?? undefined;
        return Promise.resolve({ ok: true, data: current() });
      }),
    },
    on: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, 'api', { value: api, configurable: true });
  return api;
}

/** Renders the whole app at `hash`, as src/renderer/src/main.tsx does, once settings arrive. */
export async function renderApp(hash: string): Promise<RenderResult> {
  window.location.hash = hash;
  return act(() =>
    render(
      <I18nProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </I18nProvider>,
    ),
  );
}
