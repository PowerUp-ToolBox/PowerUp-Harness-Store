import { describe, expect, it, vi } from 'vitest';
import { buildApi, type Invoke, type Listen } from '../src/preload/build-api.js';
import type { IpcRequest } from '../src/shared/ipc.js';

describe('buildApi (window.api)', () => {
  it('exposes one function per method, nested by domain, plus on()', () => {
    const api = buildApi(vi.fn<Invoke>(), vi.fn<Listen>());
    expect(Object.keys(api).sort()).toEqual(['app', 'on', 'settings']);
    expect(Object.keys(api.app)).toEqual(['ping']);
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

  it('refuses an event name outside the contract', () => {
    const api = buildApi(vi.fn<Invoke>(), vi.fn<Listen>());
    const on = api.on as (event: string, listener: () => void) => () => void;
    expect(() => on('anything', () => undefined)).toThrow(TypeError);
  });
});
