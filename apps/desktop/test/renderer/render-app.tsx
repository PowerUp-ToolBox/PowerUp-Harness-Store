import { act, render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { Root } from '../../src/renderer/src/Root.js';
import type { Locale } from '../../src/shared/i18n/locale.js';
import type {
  ConnectionDraft,
  ConnectionSummary,
  Connectivity,
  ConnectivityState,
  Diagnostics,
  IpcEventName,
  IpcEvents,
  IpcResult,
  LocalProvider,
  ProviderPreset,
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

/** Three of the Runtime's presets, the custom endpoint among them. */
export const FAKE_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    requiresKey: true,
    custom: false,
    keyPlaceholder: 'sk-ant-...',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    requiresKey: true,
    custom: false,
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible endpoint',
    requiresKey: false,
    custom: true,
    keyPlaceholder: '',
  },
];

export interface FakeApiOptions {
  /** Whether the first-run wizard already ran; true, a returning User, unless a test says so. */
  readonly onboardingDone?: boolean;
}

/**
 * A fake `window.api` whose settings behave like the Runtime's: `osLocale` stands in for
 * `app.getLocale()` and an override set through `settings.set` wins over it. The Runtime started
 * fine, the Store is online, and Connections are the Runtime's stubs (detection finds nothing,
 * adding answers `not_implemented`); a test changes `app.status`, `diagnostics.get`, the
 * `connectivity` or `connections` methods before rendering to say otherwise, and pushes events
 * with `emit`.
 */
export function installFakeApi(
  osLocale: Locale = 'en',
  override?: Locale,
  options: FakeApiOptions = {},
) {
  let locale = override;
  let onboardingDone = options.onboardingDone ?? true;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const current = (): Settings =>
    locale === undefined
      ? { resolvedLocale: osLocale, onboardingDone }
      : { locale, resolvedLocale: locale, onboardingDone };
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
        if (patch.onboardingDone !== undefined) onboardingDone = patch.onboardingDone;
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
    providers: {
      list: vi.fn((): Promise<IpcResult<readonly ProviderPreset[]>> =>
        Promise.resolve({ ok: true, data: FAKE_PRESETS }),
      ),
    },
    connections: {
      detectLocal: vi.fn((): Promise<IpcResult<readonly LocalProvider[]>> =>
        Promise.resolve({ ok: true, data: [] }),
      ),
      add: vi.fn((draft: ConnectionDraft): Promise<IpcResult<ConnectionSummary>> =>
        Promise.resolve({
          ok: false,
          error: {
            code: 'not_implemented',
            messageKey: 'error.not_implemented',
            params: { method: 'connections.add', providerId: draft.providerId },
            message: 'This is not available in this version of Harness Store yet.',
          },
        }),
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
