import { describe, expect, it, vi } from 'vitest';
import { createDispatcher, UntrustedSenderError } from '../src/main/runtime/dispatcher.js';
import { createHandlers, type IpcHandlers } from '../src/main/runtime/handlers.js';
import { createConnectionsStub, providerPresets } from '../src/main/runtime/connections.js';
import { createInstallsStub } from '../src/main/runtime/installer.js';
import { fail, ok } from '../src/main/runtime/ipc-result.js';
import type { Services } from '../src/main/runtime/services.js';
import { StoreAuthError } from '../src/main/runtime/store-auth.js';
import { translatorFor } from '../src/shared/i18n/translate.js';
import {
  IPC_METHODS,
  type IpcResult,
  type StoreDetail,
  type StoreHomeRequest,
  type StoreSearchRequest,
} from '../src/shared/ipc.js';

const MAIN_WINDOW = { id: 'main window webContents' };
const quit = vi.fn();
const stopWatching = vi.fn();
const cancel = vi.fn();
const home = vi.fn((request?: StoreHomeRequest) =>
  Promise.resolve(
    request?.refresh === true
      ? fail('store_unreachable')
      : ok({ platform: 'darwin-arm64' as const, featured: [], mostDownloaded: [], newest: [] }),
  ),
);
const search = vi.fn((request: StoreSearchRequest) =>
  Promise.resolve(
    request.q === 'offline'
      ? fail('store_unreachable')
      : ok({ platform: 'darwin-arm64' as const, listings: [], hasMore: false }),
  ),
);
const detail = vi.fn<(harnessId: string) => Promise<IpcResult<StoreDetail>>>(() =>
  Promise.resolve(ok({ platform: 'darwin-arm64', storeStatus: 'not_found', harness: null })),
);
const resolveManifest = vi.fn(() => ok([{ slot: 'default', binding: null }]));
const fakeServices: Services = {
  app: {
    version: '1.2.3',
    status: () => ({ state: 'failed', stage: 'gateway', detail: 'listen EADDRINUSE' }),
    quit,
  },
  settings: {
    get: () => ({ resolvedLocale: 'en', onboardingDone: false }),
    set: () => ({ resolvedLocale: 'en', onboardingDone: true }),
  },
  diagnostics: {
    get: () => ({
      version: '1.2.3',
      gateway: { running: true, port: 51234 },
      databasePath: '/profile/harness-store.sqlite',
    }),
  },
  connectivity: {
    get: () => ({ state: 'offline' }),
    check: () => Promise.resolve({ state: 'online' }),
  },
  store: { home, search, detail },
  providers: { list: () => providerPresets() },
  connections: createConnectionsStub(),
  bindings: {
    getGlobal: () => [{ slot: 'default', connectionId: 'ollama', model: 'qwen3:8b' }],
    setGlobal: (change) =>
      ok(change.target === null ? [] : [{ slot: change.slot, ...change.target }]),
    getForHarness: () => [],
    setOverride: (change) => ok([{ slot: change.slot, ...change.target }]),
    clearOverride: () => ok([]),
    resolveAll: () => ok([{ slot: 'default', binding: null }]),
    resolveManifest,
  },
  auth: {
    signIn: () =>
      Promise.reject(new StoreAuthError('sign_in_timeout', 'The browser did not come back.')),
    signOut: () => Promise.resolve({ signedIn: false }),
    whoami: () =>
      Promise.resolve({
        signedIn: true,
        githubLogin: 'octo-cat',
        displayName: 'Octo Cat',
        avatarUrl: null,
      }),
  },
  installs: { ...createInstallsStub(), chooseFolder: () => Promise.resolve('/Users/me/hello') },
  launch: {
    start: (harnessId, workspace) =>
      Promise.resolve(
        ok({ outcome: 'started', launchId: `launch-of-${harnessId}-in-${String(workspace)}` }),
      ),
    chooseWorkspace: (harnessId) => Promise.resolve(ok(`/Users/me/${harnessId}`)),
    lastWorkspace: () => Promise.resolve(ok({ path: '/Users/me/project', exists: false })),
    status: () => [
      {
        harnessId: 'acme/hello',
        launchId: 'launch-1',
        state: 'failed',
        reason: 'exit_nonzero',
        exitCode: 3,
        startedAt: '2026-10-28T09:00:00.000Z',
      },
    ],
    openLogs: (harnessId) =>
      Promise.resolve(harnessId === 'acme/hello' ? ok(null) : fail('not_installed')),
    openDataFolder: (harnessId) =>
      Promise.resolve(harnessId === 'acme/hello' ? ok(null) : fail('not_installed')),
  },
  publish: {
    validateFolder: (path) => Promise.resolve(fail('file_unreadable', { path })),
    stopWatching,
    publish: ({ archiveId, jobId }) =>
      Promise.resolve(
        ok({ harnessId: 'octo-cat/hello', version: `${archiveId}-${jobId}`, url: '/store/h/x' }),
      ),
    cancel,
    myHarnesses: () => Promise.resolve(fail('unauthenticated')),
    unpublish: ({ harnessId, version }) =>
      Promise.resolve(ok({ harnessId, version, latestVersion: null })),
  },
};
const en = translatorFor('en');

function dispatcherFor(handlers: IpcHandlers = createHandlers(fakeServices)) {
  const onHandlerError = vi.fn();
  const dispatch = createDispatcher({
    handlers,
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
    onHandlerError,
  });
  return { dispatch, onHandlerError };
}

describe('IPC handlers against a fake service container', () => {
  it('has exactly one handler per method in the contract', () => {
    expect(Object.keys(createHandlers(fakeServices)).sort()).toEqual([...IPC_METHODS].sort());
  });

  it('app.ping returns the app version', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'app.ping' })).resolves.toEqual({
      ok: true,
      data: { version: '1.2.3' },
    });
  });

  it('app.status returns how the Runtime started', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'app.status' })).resolves.toEqual({
      ok: true,
      data: { state: 'failed', stage: 'gateway', detail: 'listen EADDRINUSE' },
    });
  });

  it('app.quit asks the app to quit', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'app.quit' })).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(quit).toHaveBeenCalledOnce();
  });

  it('diagnostics.get returns the version, Model Gateway status and database path', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'diagnostics.get' })).resolves.toEqual({
      ok: true,
      data: {
        version: '1.2.3',
        gateway: { running: true, port: 51234 },
        databasePath: '/profile/harness-store.sqlite',
      },
    });
  });

  it('connectivity.get returns what the last Store check found', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'connectivity.get' })).resolves.toEqual({
      ok: true,
      data: { state: 'offline' },
    });
  });

  it('connectivity.check checks the Store now and returns the result', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'connectivity.check' })).resolves.toEqual({
      ok: true,
      data: { state: 'online' },
    });
  });

  it('store.home reads the Store home, again with { refresh: true }', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'store.home' })).resolves.toEqual({
      ok: true,
      data: { platform: 'darwin-arm64', featured: [], mostDownloaded: [], newest: [] },
    });
    expect(home).toHaveBeenLastCalledWith({});
    await expect(
      dispatch(MAIN_WINDOW, { method: 'store.home', input: { refresh: true } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'store_unreachable' } });
    expect(home).toHaveBeenLastCalledWith({ refresh: true });
  });

  it.each([42, 'refresh', [], { refresh: 'yes' }, { refresh: true, extra: 1 }])(
    'store.home rejects %j as invalid_input',
    async (input) => {
      const { dispatch } = dispatcherFor();
      home.mockClear();
      await expect(dispatch(MAIN_WINDOW, { method: 'store.home', input })).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input', params: { method: 'store.home' } },
      });
      expect(home).not.toHaveBeenCalled();
    },
  );

  it('store.search searches the Store with the request as it came', async () => {
    const { dispatch } = dispatcherFor();
    const request = { q: '写作', tags: ['writing', 'coding'], allPlatforms: true, offset: 24 };
    await expect(
      dispatch(MAIN_WINDOW, { method: 'store.search', input: request }),
    ).resolves.toEqual({
      ok: true,
      data: { platform: 'darwin-arm64', listings: [], hasMore: false },
    });
    expect(search).toHaveBeenLastCalledWith(request);
    await expect(
      dispatch(MAIN_WINDOW, {
        method: 'store.search',
        input: { q: 'offline', tags: [], allPlatforms: false, offset: 0 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'store_unreachable' } });
  });

  const SEARCH = { q: 'notes', tags: ['writing'], allPlatforms: false, offset: 0 };
  it.each([
    undefined,
    'notes',
    [],
    { q: 'notes' },
    { ...SEARCH, extra: 1 },
    { ...SEARCH, q: 42 },
    { ...SEARCH, q: 'x'.repeat(201) },
    { ...SEARCH, tags: 'writing' },
    { ...SEARCH, tags: ['not-a-tag'] },
    { ...SEARCH, tags: ['writing', 'writing'] },
    { ...SEARCH, allPlatforms: 'yes' },
    { ...SEARCH, offset: -24 },
    { ...SEARCH, offset: 1.5 },
    { ...SEARCH, offset: '24' },
    { ...SEARCH, offset: 2 ** 31 },
  ])('store.search rejects %j as invalid_input', async (input) => {
    const { dispatch } = dispatcherFor();
    search.mockClear();
    await expect(dispatch(MAIN_WINDOW, { method: 'store.search', input })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method: 'store.search' } },
    });
    expect(search).not.toHaveBeenCalled();
  });

  it('store.detail reads the detail page of a Harness ID', async () => {
    const { dispatch } = dispatcherFor();
    await expect(
      dispatch(MAIN_WINDOW, { method: 'store.detail', input: 'alice/writer' }),
    ).resolves.toEqual({
      ok: true,
      data: { platform: 'darwin-arm64', storeStatus: 'not_found', harness: null },
    });
    expect(detail).toHaveBeenLastCalledWith('alice/writer');
  });

  it.each([undefined, '', 'writer', 42, { harnessId: 'alice/writer' }, `a/${'x'.repeat(256)}`])(
    'store.detail rejects %j as invalid_input',
    async (input) => {
      const { dispatch } = dispatcherFor();
      detail.mockClear();
      await expect(dispatch(MAIN_WINDOW, { method: 'store.detail', input })).resolves.toMatchObject(
        { ok: false, error: { code: 'invalid_input', params: { method: 'store.detail' } } },
      );
      expect(detail).not.toHaveBeenCalled();
    },
  );

  it('store.search takes 200 characters of text', async () => {
    const { dispatch } = dispatcherFor();
    const input = { ...SEARCH, q: 'x'.repeat(200) };
    await expect(dispatch(MAIN_WINDOW, { method: 'store.search', input })).resolves.toMatchObject({
      ok: true,
    });
  });

  it.each([
    'app.status',
    'app.quit',
    'diagnostics.get',
    'connectivity.get',
    'connectivity.check',
    'providers.list',
    'connections.detectLocal',
    'connections.list',
    'bindings.getGlobal',
    'auth.signIn',
    'auth.signOut',
    'auth.whoami',
    'installs.chooseFolder',
    'installs.list',
    'launch.status',
  ])('%s rejects any input as invalid_input', async (method) => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method, input: {} })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method } },
    });
  });

  it.each([undefined, 42, { id: 'anthropic' }])(
    'connections.remove rejects %j as invalid_input',
    async (input) => {
      const { dispatch } = dispatcherFor();
      await expect(
        dispatch(MAIN_WINDOW, { method: 'connections.remove', input }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input', params: { method: 'connections.remove' } },
      });
    },
  );

  it.each([
    undefined,
    'anthropic',
    { enabled: false },
    { id: 7 },
    { id: 'anthropic', enabled: 'no' },
    { id: 'anthropic', apiKey: null },
    { id: 'anthropic', secret: 'x' },
  ])('connections.update rejects %j as invalid_input', async (input) => {
    const { dispatch } = dispatcherFor();
    await expect(
      dispatch(MAIN_WINDOW, { method: 'connections.update', input }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method: 'connections.update' } },
    });
  });

  it.each([
    ['connections.test', undefined],
    ['connections.test', 'anthropic'],
    ['connections.test', { id: 'anthropic', model: 7 }],
    ['connections.test', { id: 'anthropic', apiKey: 'x' }],
    ['connections.testDraft', undefined],
    ['connections.testDraft', { id: 'anthropic' }],
    ['connections.testDraft', { providerId: 'anthropic', apiKey: null }],
    ['connections.testDraft', { providerId: 'anthropic', displayName: 'x' }],
    ['connections.models', undefined],
    ['connections.models', { id: 'anthropic' }],
    ['bindings.setGlobal', undefined],
    ['bindings.setGlobal', { slot: 'default' }],
    ['bindings.setGlobal', { slot: 'default', target: 'ollama/qwen3:8b' }],
    ['bindings.getForHarness', undefined],
    ['bindings.getForHarness', ''],
    ['bindings.getForHarness', { harnessId: 'acme/hello' }],
    ['bindings.setOverride', undefined],
    ['bindings.setOverride', { harnessId: 'acme/hello', slot: 'default' }],
    ['bindings.setOverride', { harnessId: 'acme/hello', slot: 'default', target: null }],
    [
      'bindings.setOverride',
      { harnessId: 7, slot: 'default', target: { connectionId: 'ollama', model: 'm' } },
    ],
    [
      'bindings.setOverride',
      { harnessId: 'acme/hello', slot: 'default', target: { connectionId: 'ollama' } },
    ],
    [
      'bindings.setOverride',
      {
        harnessId: 'acme/hello',
        slot: 'default',
        target: { connectionId: 'ollama', model: 'm' },
        scope: 'global',
      },
    ],
    ['bindings.clearOverride', undefined],
    ['bindings.clearOverride', { harnessId: 'acme/hello' }],
    ['bindings.clearOverride', { harnessId: 'acme/hello', slot: 'default', target: null }],
    ['bindings.resolveAll', undefined],
    ['bindings.resolveAll', { harnessId: 'acme/hello' }],
    ['bindings.resolveManifest', undefined],
    ['bindings.resolveManifest', 'acme/hello'],
    ['bindings.resolveManifest', { harnessId: 'acme/hello' }],
    ['bindings.resolveManifest', { harnessId: 'acme/hello', models: { slots: {} } }],
    ['bindings.resolveManifest', { harnessId: 'acme/hello', models: { slots: { fast: {} } } }],
    [
      'bindings.resolveManifest',
      { harnessId: 'acme/hello', models: { slots: { default: {}, Fast: {} } } },
    ],
    [
      'bindings.resolveManifest',
      { harnessId: 'acme/hello', models: { slots: { default: { recommended: 'ollama/m' } } } },
    ],
    [
      'bindings.resolveManifest',
      { harnessId: 'acme/hello', models: { slots: { default: { recommended: [42] } } } },
    ],
    [
      'bindings.resolveManifest',
      {
        harnessId: 'acme/hello',
        models: {
          slots: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${String(i)}`, {}])),
        },
      },
    ],
    [
      'bindings.resolveManifest',
      { harnessId: 'acme/hello', models: { slots: { default: {} } }, extra: 1 },
    ],
    ['installs.inspectFolder', undefined],
    ['installs.inspectFolder', 'relative/folder'],
    ['installs.inspectFolder', '/folder\u0000'],
    ['installs.installFromFolder', { path: '/folder' }],
    ['installs.installFromFolder', ''],
    ['launch.start', undefined],
    ['launch.start', 'acme/hello'],
    ['launch.start', { harnessId: '' }],
    ['launch.start', { harnessId: 'acme/hello', workspace: 'relative/folder' }],
    ['launch.start', { harnessId: 'acme/hello', workspace: 42 }],
    ['launch.start', { harnessId: 'acme/hello', workspace: '/Users/me', extra: true }],
    ['launch.chooseWorkspace', undefined],
    ['launch.chooseWorkspace', { harnessId: 'acme/hello' }],
    ['launch.lastWorkspace', ''],
    ['launch.openLogs', undefined],
    ['launch.openLogs', { harnessId: 'acme/hello' }],
    ['launch.openDataFolder', ''],
    ['launch.openDataFolder', 'a'.repeat(257)],
    ['publish.validateFolder', undefined],
    ['publish.validateFolder', 'relative/folder'],
    ['publish.validateFolder', { path: '/folder' }],
    ['publish.stopWatching', '/folder'],
    ['publish.publish', undefined],
    ['publish.publish', 'archive-1'],
    ['publish.publish', { archiveId: 'archive-1' }],
    ['publish.publish', { archiveId: 'archive-1', jobId: '' }],
    ['publish.publish', { archiveId: 'archive/1', jobId: 'job-1' }],
    ['publish.publish', { archiveId: 'archive-1', jobId: 'job-1', path: '/folder' }],
    ['publish.cancel', undefined],
    ['publish.cancel', { jobId: 'job-1' }],
    ['publish.cancel', 'job 1'],
    ['publish.myHarnesses', 'octo-cat'],
    ['publish.unpublish', undefined],
    ['publish.unpublish', 'octo-cat/hello@1.0.0'],
    ['publish.unpublish', { harnessId: 'octo-cat/hello' }],
    ['publish.unpublish', { harnessId: 'hello', version: '1.0.0' }],
    ['publish.unpublish', { harnessId: 'octo-cat/hello', version: '' }],
    ['publish.unpublish', { harnessId: 'octo-cat/hello', version: 1 }],
    ['publish.unpublish', { harnessId: 'octo-cat/hello', version: '1.0.0', force: true }],
  ])('%s rejects %j as invalid_input', async (method, input) => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method, input })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method } },
    });
  });

  it('publish.validateFolder passes an absolute path on; publish.stopWatching stops', async () => {
    const { dispatch } = dispatcherFor();
    await expect(
      dispatch(MAIN_WINDOW, { method: 'publish.validateFolder', input: '/Users/me/hello' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'file_unreadable', params: { path: '/Users/me/hello' } },
    });
    await expect(dispatch(MAIN_WINDOW, { method: 'publish.stopWatching' })).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(stopWatching).toHaveBeenCalledOnce();
  });

  it('publish.publish passes the archive and job on; publish.cancel cancels the job', async () => {
    const { dispatch } = dispatcherFor();
    await expect(
      dispatch(MAIN_WINDOW, {
        method: 'publish.publish',
        input: { archiveId: 'archive-1', jobId: 'job-1' },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { harnessId: 'octo-cat/hello', version: 'archive-1-job-1', url: '/store/h/x' },
    });
    await expect(
      dispatch(MAIN_WINDOW, { method: 'publish.cancel', input: 'job-1' }),
    ).resolves.toEqual({ ok: true, data: null });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('job-1');
  });

  it('publish.myHarnesses and publish.unpublish pass their call on', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'publish.myHarnesses' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unauthenticated' },
    });
    await expect(
      dispatch(MAIN_WINDOW, {
        method: 'publish.unpublish',
        input: { harnessId: 'octo-cat/hello', version: '1.0.0' },
      }),
    ).resolves.toEqual({
      ok: true,
      data: { harnessId: 'octo-cat/hello', version: '1.0.0', latestVersion: null },
    });
  });

  it('launch.start starts the Harness named and answers the launch', async () => {
    const { dispatch } = dispatcherFor();
    await expect(
      dispatch(MAIN_WINDOW, { method: 'launch.start', input: { harnessId: 'acme/hello' } }),
    ).resolves.toEqual({
      ok: true,
      data: { outcome: 'started', launchId: 'launch-of-acme/hello-in-null' },
    });
  });

  it('launch.start passes the Workspace on, an absolute path or null', async () => {
    const { dispatch } = dispatcherFor();
    for (const workspace of ['/Users/me/project', null]) {
      await expect(
        dispatch(MAIN_WINDOW, {
          method: 'launch.start',
          input: { harnessId: 'acme/hello', workspace },
        }),
      ).resolves.toMatchObject({
        ok: true,
        data: { launchId: `launch-of-acme/hello-in-${String(workspace)}` },
      });
    }
  });

  it('launch.chooseWorkspace and launch.lastWorkspace answer for the Harness named', async () => {
    const { dispatch } = dispatcherFor();
    await expect(
      dispatch(MAIN_WINDOW, { method: 'launch.chooseWorkspace', input: 'acme/hello' }),
    ).resolves.toEqual({ ok: true, data: '/Users/me/acme/hello' });
    await expect(
      dispatch(MAIN_WINDOW, { method: 'launch.lastWorkspace', input: 'acme/hello' }),
    ).resolves.toEqual({ ok: true, data: { path: '/Users/me/project', exists: false } });
  });

  it('launch.status lists the latest launches', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'launch.status' })).resolves.toMatchObject({
      ok: true,
      data: [{ harnessId: 'acme/hello', state: 'failed', reason: 'exit_nonzero', exitCode: 3 }],
    });
  });

  it('launch.openLogs and launch.openDataFolder act on the Harness named', async () => {
    const { dispatch } = dispatcherFor();
    for (const method of ['launch.openLogs', 'launch.openDataFolder']) {
      await expect(dispatch(MAIN_WINDOW, { method, input: 'acme/hello' })).resolves.toEqual({
        ok: true,
        data: null,
      });
      await expect(dispatch(MAIN_WINDOW, { method, input: 'acme/other' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'not_installed' },
      });
    }
  });

  it('bindings.getGlobal returns the global Slot Bindings', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'bindings.getGlobal' })).resolves.toEqual({
      ok: true,
      data: [{ slot: 'default', connectionId: 'ollama', model: 'qwen3:8b' }],
    });
  });

  it('bindings.setGlobal hands a well-formed change to the service', async () => {
    const { dispatch } = dispatcherFor();
    await expect(
      dispatch(MAIN_WINDOW, {
        method: 'bindings.setGlobal',
        input: { slot: 'fast', target: { connectionId: 'ollama', model: 'qwen3:8b' } },
      }),
    ).resolves.toEqual({
      ok: true,
      data: [{ slot: 'fast', connectionId: 'ollama', model: 'qwen3:8b' }],
    });
  });

  it('bindings.setOverride, clearOverride and resolveAll hand well-formed input to the service', async () => {
    const { dispatch } = dispatcherFor();
    await expect(
      dispatch(MAIN_WINDOW, {
        method: 'bindings.setOverride',
        input: {
          harnessId: 'acme/hello',
          slot: 'fast',
          target: { connectionId: 'ollama', model: 'qwen3:8b' },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      data: [{ slot: 'fast', connectionId: 'ollama', model: 'qwen3:8b' }],
    });
    await expect(
      dispatch(MAIN_WINDOW, {
        method: 'bindings.clearOverride',
        input: { harnessId: 'acme/hello', slot: 'fast' },
      }),
    ).resolves.toEqual({ ok: true, data: [] });
    await expect(
      dispatch(MAIN_WINDOW, { method: 'bindings.resolveAll', input: 'acme/hello' }),
    ).resolves.toEqual({ ok: true, data: [{ slot: 'default', binding: null }] });
  });

  it('bindings.resolveManifest hands the Slots and their Recommended Models to the service', async () => {
    const { dispatch } = dispatcherFor();
    const slots = {
      default: {
        description: 'Writes.',
        requirements: { tools: true },
        recommended: ['ollama/qwen3:8b'],
      },
      fast: {},
    };
    await expect(
      dispatch(MAIN_WINDOW, {
        method: 'bindings.resolveManifest',
        input: { harnessId: 'acme/hello', models: { slots } },
      }),
    ).resolves.toEqual({ ok: true, data: [{ slot: 'default', binding: null }] });
    // Only what resolution reads reaches it.
    expect(resolveManifest).toHaveBeenLastCalledWith({
      harnessId: 'acme/hello',
      models: { slots: { default: { recommended: ['ollama/qwen3:8b'] }, fast: {} } },
    });
  });

  it('installs.chooseFolder returns the folder the picker chose', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'installs.chooseFolder' })).resolves.toEqual({
      ok: true,
      data: '/Users/me/hello',
    });
  });

  it('auth.whoami returns the signed-in Publisher', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'auth.whoami' })).resolves.toEqual({
      ok: true,
      data: { signedIn: true, githubLogin: 'octo-cat', displayName: 'Octo Cat', avatarUrl: null },
    });
  });

  it('auth.signIn answers a failed sign-in with its error code', async () => {
    const { dispatch, onHandlerError } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'auth.signIn' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'sign_in_timeout',
        messageKey: 'error.sign_in_timeout',
        message: en.t('error.sign_in_timeout'),
      },
    });
    expect(onHandlerError).not.toHaveBeenCalled();
  });

  it('auth.signOut returns signed out', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'auth.signOut' })).resolves.toEqual({
      ok: true,
      data: { signedIn: false },
    });
  });

  it('app.ping rejects any input as invalid_input', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'app.ping', input: 1 })).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_input',
        messageKey: 'error.invalid_input',
        params: { method: 'app.ping' },
        message: en.t('error.invalid_input'),
      },
    });
  });
});

describe('createDispatcher', () => {
  it('answers an unknown method with invalid_input, never by throwing', async () => {
    const { dispatch } = dispatcherFor();
    const result = await dispatch(MAIN_WINDOW, { method: 'toString' });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        messageKey: 'error.invalid_input',
        params: { method: 'toString' },
      },
    });
  });

  it.each([null, 'app.ping', 42, {}, { method: 7 }])(
    'answers the malformed request %j with invalid_input',
    async (request) => {
      const { dispatch } = dispatcherFor();
      await expect(dispatch(MAIN_WINDOW, request)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    },
  );

  it('turns a handler that throws into internal_error and reports the cause', async () => {
    const boom = new Error('boom');
    const { dispatch, onHandlerError } = dispatcherFor({
      ...createHandlers(fakeServices),
      'app.ping': () => {
        throw boom;
      },
    });
    await expect(dispatch(MAIN_WINDOW, { method: 'app.ping' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        messageKey: 'error.internal_error',
        params: { method: 'app.ping' },
        message: en.t('error.internal_error'),
      },
    });
    expect(onHandlerError).toHaveBeenCalledWith('app.ping', boom);
  });

  it('turns a handler whose promise rejects into internal_error', async () => {
    const { dispatch } = dispatcherFor({
      ...createHandlers(fakeServices),
      'app.ping': () => Promise.reject(new Error('later')),
    });
    await expect(dispatch(MAIN_WINDOW, { method: 'app.ping' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
  });

  it('refuses a sender other than the main window', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch({ id: 'another webContents' }, { method: 'app.ping' })).rejects.toThrow(
      UntrustedSenderError,
    );
  });
});
