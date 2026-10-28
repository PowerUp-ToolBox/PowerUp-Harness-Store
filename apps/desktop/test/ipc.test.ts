import { describe, expect, it, vi } from 'vitest';
import { createDispatcher, UntrustedSenderError } from '../src/main/runtime/dispatcher.js';
import { createHandlers, type IpcHandlers } from '../src/main/runtime/handlers.js';
import type { Services } from '../src/main/runtime/services.js';
import { IPC_METHODS } from '../src/shared/ipc.js';

const MAIN_WINDOW = { id: 'main window webContents' };
const fakeServices: Services = { app: { version: '1.2.3' } };

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

  it('app.ping rejects any input as invalid_input', async () => {
    const { dispatch } = dispatcherFor();
    await expect(dispatch(MAIN_WINDOW, { method: 'app.ping', input: 1 })).resolves.toEqual({
      ok: false,
      error: {
        code: 'invalid_input',
        messageKey: 'error.invalid_input',
        message: 'app.ping takes no input.',
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
        message: 'app.ping failed unexpectedly.',
      },
    });
    expect(onHandlerError).toHaveBeenCalledWith('app.ping', boom);
  });

  it('turns a handler whose promise rejects into internal_error', async () => {
    const { dispatch } = dispatcherFor({ 'app.ping': () => Promise.reject(new Error('later')) });
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
