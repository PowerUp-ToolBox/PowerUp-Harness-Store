import { act, render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import { Root } from '../../src/renderer/src/Root.js';
import type { Locale } from '../../src/shared/i18n/locale.js';
import type {
  AuthState,
  ConnectionDraft,
  ConnectionSummary,
  ConnectionTestDraft,
  ConnectionTestPassed,
  ConnectionTestRequest,
  ConnectionUpdate,
  Connectivity,
  ConnectivityState,
  Diagnostics,
  FolderInspection,
  FolderValidation,
  GlobalBinding,
  InstalledHarness,
  InstalledVersion,
  GlobalBindingChange,
  IpcEventName,
  IpcEvents,
  IpcResult,
  LastWorkspace,
  LaunchRequest,
  LaunchStarted,
  LaunchStatus,
  LocalProvider,
  ModelInfo,
  ModelOverride,
  ModelOverrideChange,
  ModelOverrideClear,
  OwnHarness,
  ProviderPreset,
  PublishedVersion,
  PublishRequest,
  ResolvedSlot,
  Settings,
  SettingsPatch,
  StartupStatus,
  UnpublishedVersion,
  UnpublishRequest,
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

/** The Publisher `auth.signIn` signs in as. */
export const FAKE_PUBLISHER: AuthState = {
  signedIn: true,
  githubLogin: 'octo-cat',
  displayName: 'Octo Cat',
  avatarUrl: null,
};

/** Four of the Runtime's presets: two cloud ones, a local one and the custom endpoint. */
export const FAKE_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    requiresKey: true,
    custom: false,
    local: false,
    baseUrl: 'https://api.anthropic.com/v1',
    docsUrl: 'https://docs.claude.com/en/api/overview',
    supportsModelList: false,
    keyPlaceholder: 'sk-ant-...',
    needsTestModel: false,
    testModel: 'claude-haiku-5-5',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    requiresKey: true,
    custom: false,
    local: false,
    baseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    supportsModelList: true,
    keyPlaceholder: 'sk-...',
    needsTestModel: false,
    testModel: null,
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    requiresKey: false,
    custom: false,
    local: true,
    baseUrl: 'http://127.0.0.1:11434/v1',
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    supportsModelList: true,
    keyPlaceholder: '',
    needsTestModel: false,
    testModel: null,
  },
  {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible endpoint',
    requiresKey: false,
    custom: true,
    local: false,
    baseUrl: null,
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    supportsModelList: true,
    keyPlaceholder: '',
    needsTestModel: false,
    testModel: null,
  },
];

/** A Provider that lists no models and has no catalogue: its test needs a model name. */
export const ZHIPU_PRESET: ProviderPreset = {
  id: 'zhipu',
  displayName: 'Zhipu AI (GLM)',
  requiresKey: true,
  custom: false,
  local: false,
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
  supportsModelList: false,
  keyPlaceholder: '',
  needsTestModel: true,
  testModel: null,
};

/** A saved Connection as `connections.list` answers it; `overrides` change any field. */
export function connectionSummary(
  overrides: Partial<ConnectionSummary> & Pick<ConnectionSummary, 'id'>,
): ConnectionSummary {
  const providerId = overrides.providerId ?? overrides.id.split(':')[0] ?? overrides.id;
  const preset = FAKE_PRESETS.find((item) => item.id === providerId);
  return {
    providerId,
    displayName: preset?.displayName ?? providerId,
    local: preset?.local ?? false,
    enabled: true,
    baseUrl: preset?.baseUrl ?? '',
    keyHint: null,
    lastTestedAt: null,
    lastTestOk: null,
    lastTestError: null,
    lastTestFailure: null,
    testModel: null,
    models: [],
    ...overrides,
  };
}

export interface FakeApiOptions {
  /** Whether the first-run wizard already ran; true, a returning User, unless a test says so. */
  readonly onboardingDone?: boolean;
}

/**
 * A fake `window.api` whose settings behave like the Runtime's: `osLocale` stands in for
 * `app.getLocale()` and an override set through `settings.set` wins over it. The Runtime started
 * fine, the Store is online, there are no Connections or Slot Bindings, detection finds nothing,
 * `connections.add`, `update`, `remove` and `test` (of a saved Connection) answer
 * `not_implemented`, `connections.testDraft` passes finding no models and `connections.models`
 * lists none; `bindings.setGlobal` sets or clears a Default Model that `bindings.getGlobal` then
 * lists, without checking its Connection, and `bindings.setOverride` and `clearOverride` do the
 * same for the Model Overrides `bindings.getForHarness` lists, while `bindings.resolveAll` answers
 * `not_implemented`; nobody is signed in to the Store, `auth.signIn` signs
 * in as `octo-cat` and `auth.signOut` signs out; nothing is installed, the folder picker is
 * cancelled, and inspecting or installing a folder answers `not_implemented`; nothing was
 * launched, launching answers `not_implemented`, no Harness has a last Workspace and the
 * Workspace picker is cancelled; validating a folder to publish and publishing answer
 * `not_implemented`, cancelling an upload does nothing, the Publisher has no Harnesses and
 * Unpublishing answers `not_implemented`, and a dropped file's path is `/dropped/<name>`; a test
 * changes `app.status`, `diagnostics.get`, the `connectivity`, `connections`, `bindings` or `installs`
 * methods before rendering to say otherwise, and pushes events with `emit`.
 */
export function installFakeApi(
  osLocale: Locale = 'en',
  override?: Locale,
  options: FakeApiOptions = {},
) {
  let locale = override;
  let onboardingDone = options.onboardingDone ?? true;
  let bindings: readonly GlobalBinding[] = [];
  const overrides = new Map<string, readonly ModelOverride[]>();
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
      list: vi.fn((): Promise<IpcResult<readonly ConnectionSummary[]>> =>
        Promise.resolve({ ok: true, data: [] }),
      ),
      add: vi.fn((draft: ConnectionDraft): Promise<IpcResult<ConnectionSummary>> =>
        notImplemented('connections.add', draft.providerId),
      ),
      update: vi.fn((update: ConnectionUpdate): Promise<IpcResult<ConnectionSummary>> =>
        notImplemented('connections.update', update.id),
      ),
      remove: vi.fn((id: string): Promise<IpcResult<null>> =>
        notImplemented('connections.remove', id),
      ),
      test: vi.fn((request: ConnectionTestRequest): Promise<IpcResult<ConnectionSummary>> =>
        notImplemented('connections.test', request.id),
      ),
      testDraft: vi.fn<(draft: ConnectionTestDraft) => Promise<IpcResult<ConnectionTestPassed>>>(
        () => Promise.resolve({ ok: true, data: { models: [] } }),
      ),
      models: vi.fn<(id: string) => Promise<IpcResult<readonly ModelInfo[]>>>(() =>
        Promise.resolve({ ok: true, data: [] }),
      ),
    },
    bindings: {
      getGlobal: vi.fn((): Promise<IpcResult<readonly GlobalBinding[]>> =>
        Promise.resolve({ ok: true, data: bindings }),
      ),
      setGlobal: vi.fn(
        (change: GlobalBindingChange): Promise<IpcResult<readonly GlobalBinding[]>> => {
          const others = bindings.filter((binding) => binding.slot !== change.slot);
          bindings = sortBindings(
            change.target === null ? others : [...others, { slot: change.slot, ...change.target }],
          );
          return Promise.resolve({ ok: true, data: bindings });
        },
      ),
      getForHarness: vi.fn((harnessId: string): Promise<IpcResult<readonly ModelOverride[]>> =>
        Promise.resolve({ ok: true, data: overrides.get(harnessId) ?? [] }),
      ),
      setOverride: vi.fn(
        (change: ModelOverrideChange): Promise<IpcResult<readonly ModelOverride[]>> => {
          const others = (overrides.get(change.harnessId) ?? []).filter(
            (row) => row.slot !== change.slot,
          );
          overrides.set(
            change.harnessId,
            [...others, { slot: change.slot, ...change.target }].sort((a, b) =>
              a.slot < b.slot ? -1 : 1,
            ),
          );
          return Promise.resolve({ ok: true, data: overrides.get(change.harnessId) ?? [] });
        },
      ),
      clearOverride: vi.fn(
        (clear: ModelOverrideClear): Promise<IpcResult<readonly ModelOverride[]>> => {
          const rest = (overrides.get(clear.harnessId) ?? []).filter(
            (row) => row.slot !== clear.slot,
          );
          overrides.set(clear.harnessId, rest);
          return Promise.resolve({ ok: true, data: rest });
        },
      ),
      resolveAll: vi.fn((harnessId: string): Promise<IpcResult<readonly ResolvedSlot[]>> =>
        notImplemented('bindings.resolveAll', harnessId),
      ),
    },
    auth: {
      whoami: vi.fn((): Promise<IpcResult<AuthState>> =>
        Promise.resolve({ ok: true, data: { signedIn: false } }),
      ),
      signIn: vi.fn((): Promise<IpcResult<AuthState>> =>
        Promise.resolve({ ok: true, data: FAKE_PUBLISHER }),
      ),
      signOut: vi.fn((): Promise<IpcResult<AuthState>> =>
        Promise.resolve({ ok: true, data: { signedIn: false } }),
      ),
    },
    installs: {
      chooseFolder: vi.fn((): Promise<IpcResult<string | null>> =>
        Promise.resolve({ ok: true, data: null }),
      ),
      inspectFolder: vi.fn((path: string): Promise<IpcResult<FolderInspection>> =>
        notImplemented('installs.inspectFolder', path),
      ),
      installFromFolder: vi.fn((path: string): Promise<IpcResult<InstalledVersion>> =>
        notImplemented('installs.installFromFolder', path),
      ),
      list: vi.fn((): Promise<IpcResult<readonly InstalledHarness[]>> =>
        Promise.resolve({ ok: true, data: [] }),
      ),
    },
    launch: {
      start: vi.fn((request: LaunchRequest): Promise<IpcResult<LaunchStarted>> =>
        notImplemented('launch.start', request.harnessId),
      ),
      chooseWorkspace: vi.fn<(harnessId: string) => Promise<IpcResult<string | null>>>(() =>
        Promise.resolve({ ok: true, data: null }),
      ),
      lastWorkspace: vi.fn<(harnessId: string) => Promise<IpcResult<LastWorkspace | null>>>(() =>
        Promise.resolve({ ok: true, data: null }),
      ),
      status: vi.fn((): Promise<IpcResult<readonly LaunchStatus[]>> =>
        Promise.resolve({ ok: true, data: [] }),
      ),
      openLogs: vi.fn<(harnessId: string) => Promise<IpcResult<null>>>(() =>
        Promise.resolve({ ok: true, data: null }),
      ),
      openDataFolder: vi.fn<(harnessId: string) => Promise<IpcResult<null>>>(() =>
        Promise.resolve({ ok: true, data: null }),
      ),
    },
    publish: {
      validateFolder: vi.fn((path: string): Promise<IpcResult<FolderValidation>> =>
        notImplemented('publish.validateFolder', path),
      ),
      stopWatching: vi.fn((): Promise<IpcResult<null>> =>
        Promise.resolve({ ok: true, data: null }),
      ),
      publish: vi.fn((request: PublishRequest): Promise<IpcResult<PublishedVersion>> =>
        notImplemented('publish.publish', request.archiveId),
      ),
      cancel: vi.fn<(jobId: string) => Promise<IpcResult<null>>>(() =>
        Promise.resolve({ ok: true, data: null }),
      ),
      myHarnesses: vi.fn((): Promise<IpcResult<readonly OwnHarness[]>> =>
        Promise.resolve({ ok: true, data: [] }),
      ),
      unpublish: vi.fn((request: UnpublishRequest): Promise<IpcResult<UnpublishedVersion>> =>
        notImplemented('publish.unpublish', request.harnessId),
      ),
    },
    pathForFile: vi.fn((file: File) => `/dropped/${file.name}`),
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

/** As the Runtime lists them: `default` first, then by Slot name. */
function sortBindings(bindings: readonly GlobalBinding[]): readonly GlobalBinding[] {
  return [...bindings].sort(
    (a, b) =>
      Number(a.slot !== 'default') - Number(b.slot !== 'default') ||
      (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0),
  );
}

function notImplemented(method: string, subject: string) {
  return Promise.resolve({
    ok: false as const,
    error: {
      code: 'not_implemented' as const,
      messageKey: 'error.not_implemented' as const,
      params: { method, subject },
      message: 'This is not available in this version of Harness Store yet.',
    },
  });
}

/**
 * Renders the whole app at `hash`, as src/renderer/src/main.tsx does, once the settings and the
 * startup status arrive.
 */
export async function renderApp(hash: string): Promise<RenderResult> {
  window.location.hash = hash;
  return act(() => render(<Root />));
}
