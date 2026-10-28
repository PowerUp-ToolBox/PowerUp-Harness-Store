import { describe, expect, it, vi } from 'vitest';
import { createDispatcher, UntrustedSenderError } from '../src/main/runtime/dispatcher.js';
import { createHandlers, type IpcHandlers } from '../src/main/runtime/handlers.js';
import { createConnectionsStub, providerPresets } from '../src/main/runtime/connections.js';
import type { Services } from '../src/main/runtime/services.js';
import { translatorFor } from '../src/shared/i18n/translate.js';
import { IPC_METHODS } from '../src/shared/ipc.js';

const MAIN_WINDOW = { id: 'main window webContents' };
const quit = vi.fn();
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
  providers: { list: () => providerPresets() },
  connections: createConnectionsStub(),
  bindings: { getGlobal: () => [{ slot: 'default', connectionId: 'ollama', model: 'qwen3:8b' }] },
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
  ])('%s rejects %j as invalid_input', async (method, input) => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method, input })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method } },
    });
  });

  it('bindings.getGlobal returns the global Slot Bindings', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'bindings.getGlobal' })).resolves.toEqual({
      ok: true,
      data: [{ slot: 'default', connectionId: 'ollama', model: 'qwen3:8b' }],
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
