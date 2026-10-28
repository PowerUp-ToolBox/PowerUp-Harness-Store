import { act, render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { Root } from '../../src/renderer/src/Root.js';
import type { Locale } from '../../src/shared/i18n/locale.js';
import type {
  Connectivity,
  ConnectivityState,
  Diagnostics,
  IpcEventName,
  IpcEvents,
  IpcResult,
  Settings,
  SettingsPatch,
  StartupStatus,
} from '../../src/shared/ipc.js';

/** What `connectivity.get` and `connectivity.check` answer when the Store is in `state`. */
export function connectivityResult(state: ConnectivityState): IpcResult<Connectivity> {
  return { ok: true, data: { state } };
}

export const FAKE_DIAGNOSTICS: Diagnostics = {
  version: '4.5.6',
  gateway: { running: true, port: 51234 },
  databasePath: '/profile/harness-store.sqlite',
};

/**
 * A fake `window.api` whose settings behave like the Runtime's: `osLocale` stands in for
 * `app.getLocale()` and an override set through `settings.set` wins over it. The Runtime started
 * fine and the Store is online; a test changes `app.status`, `diagnostics.get` or the
 * `connectivity` methods before rendering to say otherwise, and pushes events with `emit`.
 */
export function installFakeApi(osLocale: Locale = 'en', override?: Locale) {
  let locale = override;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
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
    connectivity: {
      get: vi.fn((): Promise<IpcResult<Connectivity>> =>
        Promise.resolve(connectivityResult('online')),
      ),
      check: vi.fn((): Promise<IpcResult<Connectivity>> =>
        Promise.resolve(connectivityResult('online')),
      ),
    },
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const forEvent = listeners.get(event) ?? new Set();
      listeners.set(event, forEvent);
      forEvent.add(listener);
      return () => {
        forEvent.delete(listener);
      };
    }),
    /** Pushes an event to the renderer, as main does over the event channel. */
    emit<E extends IpcEventName>(event: E, payload: IpcEvents[E]) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
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
