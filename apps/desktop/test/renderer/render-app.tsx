import { act, render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { Root } from '../../src/renderer/src/Root.js';
import type { Locale } from '../../src/shared/i18n/locale.js';
import type {
  Diagnostics,
  IpcResult,
  Settings,
  SettingsPatch,
  StartupStatus,
} from '../../src/shared/ipc.js';

export const FAKE_DIAGNOSTICS: Diagnostics = {
  version: '4.5.6',
  gateway: { running: true, port: 51234 },
  databasePath: '/profile/harness-store.sqlite',
};

/**
 * A fake `window.api` whose settings behave like the Runtime's: `osLocale` stands in for
 * `app.getLocale()` and an override set through `settings.set` wins over it. The Runtime started
 * fine; a test changes `app.status` or `diagnostics.get` before rendering to say otherwise.
 */
export function installFakeApi(osLocale: Locale = 'en', override?: Locale) {
  let locale = override;
  const current = (): Settings =>
    locale === undefined ? { resolvedLocale: osLocale } : { locale, resolvedLocale: locale };
  const api = {
    app: {
      ping: vi.fn(() => Promise.resolve({ ok: true, data: { version: '4.5.6' } })),
      status: vi.fn((): Promise<IpcResult<StartupStatus>> =>
        Promise.resolve({ ok: true, data: { state: 'ready' } }),
      ),
      quit: vi.fn(() => Promise.resolve({ ok: true, data: null })),
    },
    settings: {
      get: vi.fn(() => Promise.resolve({ ok: true, data: current() })),
      set: vi.fn((patch: SettingsPatch): Promise<IpcResult<Settings>> => {
        if (patch.locale !== undefined) locale = patch.locale ?? undefined;
        return Promise.resolve({ ok: true, data: current() });
      }),
    },
    diagnostics: {
      get: vi.fn((): Promise<IpcResult<Diagnostics>> =>
        Promise.resolve({ ok: true, data: FAKE_DIAGNOSTICS }),
      ),
    },
    on: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, 'api', { value: api, configurable: true });
  return api;
}

/**
 * Renders the whole app at `hash`, as src/renderer/src/main.tsx does, once the settings and the
 * startup status arrive.
 */
export async function renderApp(hash: string): Promise<RenderResult> {
  window.location.hash = hash;
  return act(() => render(<Root />));
}
