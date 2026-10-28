import { describe, expect, it, vi } from 'vitest';
import { buildApi, type Invoke, type Listen } from '../src/preload/build-api.js';
import type { IpcRequest } from '../src/shared/ipc.js';

describe('buildApi (window.api)', () => {
  it('exposes one function per method, nested by domain, plus on() and pathForFile()', () => {
    const api = buildApi(vi.fn<Invoke>(), vi.fn<Listen>());
    expect(Object.keys(api).sort()).toEqual([
      'app',
      'auth',
      'bindings',
      'connections',
      'connectivity',
      'diagnostics',
      'installs',
      'launch',
      'on',
      'pathForFile',
      'providers',
      'publish',
      'settings',
    ]);
    expect(Object.keys(api.app)).toEqual(['ping', 'status', 'quit']);
    expect(Object.keys(api.auth)).toEqual(['signIn', 'signOut', 'whoami']);
    expect(Object.keys(api.bindings)).toEqual([
      'getGlobal',
      'setGlobal',
      'getForHarness',
      'setOverride',
      'clearOverride',
      'resolveAll',
    ]);
    expect(Object.keys(api.connections)).toEqual([
      'detectLocal',
      'list',
      'add',
      'update',
      'test',
      'testDraft',
      'models',
      'remove',
    ]);
    expect(Object.keys(api.connectivity)).toEqual(['get', 'check']);
    expect(Object.keys(api.diagnostics)).toEqual(['get']);
    expect(Object.keys(api.installs)).toEqual([
      'chooseFolder',
      'inspectFolder',
      'installFromFolder',
      'list',
    ]);
    expect(Object.keys(api.launch)).toEqual([
      'start',
      'chooseWorkspace',
      'lastWorkspace',
      'status',
      'openLogs',
      'openDataFolder',
    ]);
    expect(Object.keys(api.providers)).toEqual(['list']);
    expect(Object.keys(api.publish)).toEqual([
      'validateFolder',
      'stopWatching',
      'publish',
      'cancel',
    ]);
    expect(Object.keys(api.settings)).toEqual(['get', 'set']);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.app)).toBe(true);
    expect(Object.isFrozen(api.settings)).toBe(true);
  });

  it('sends { method, input } over invoke and returns its result', async () => {
    const requests: IpcRequest[] = [];
    const api = buildApi((request) => {
      requests.push(request);
      return Promise.resolve({ ok: true, data: { version: '9.9.9' } });
    }, vi.fn<Listen>());
    await expect(api.app.ping()).resolves.toEqual({ ok: true, data: { version: '9.9.9' } });
    expect(requests).toEqual([{ method: 'app.ping', input: undefined }]);
  });

  it('subscribes to a progress event and returns the unsubscribe function', () => {
    const unsubscribe = vi.fn();
    const listen = vi.fn<Listen>(() => unsubscribe);
    const api = buildApi(vi.fn<Invoke>(), listen);
    const listener = vi.fn();
    const off = api.on('progress:job-1', listener);
    expect(listen).toHaveBeenCalledWith('progress:job-1', listener);
    off();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('pathForFile is the preload’s, called without a request to main', () => {
    const invoke = vi.fn<Invoke>();
    const pathForFile = vi.fn((file: File) => `/dropped/${file.name}`);
    const api = buildApi(invoke, vi.fn<Listen>(), pathForFile);
    expect(api.pathForFile(new File([], 'my-harness'))).toBe('/dropped/my-harness');
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    'connectivity.changed',
    'auth.changed',
    'installs.changed',
    'publish.folderChanged',
  ] as const)('subscribes to %s', (event) => {
    const listen = vi.fn<Listen>(() => () => undefined);
    const api = buildApi(vi.fn<Invoke>(), listen);
    const listener = vi.fn();
    api.on(event, listener);
    expect(listen).toHaveBeenCalledWith(event, listener);
  });

  it('refuses an event name outside the contract', () => {
    const api = buildApi(vi.fn<Invoke>(), vi.fn<Listen>());
    const on = api.on as (event: string, listener: () => void) => () => void;
    expect(() => on('anything', () => undefined)).toThrow(TypeError);
  });
});
