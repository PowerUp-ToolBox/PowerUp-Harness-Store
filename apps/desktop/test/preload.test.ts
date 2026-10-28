import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL, type DesktopApi } from '../src/shared/ipc.js';

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock('electron', () => electron);

describe('preload', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await import('../src/preload/index.js');
  });

  it('exposes exactly one global, window.api', () => {
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledOnce();
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'api',
      expect.any(Object),
    );
  });

  it('routes every method over the single invoke channel', async () => {
    electron.ipcRenderer.invoke.mockResolvedValue({ ok: true, data: { version: '1.0.0' } });
    const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    await api.app.ping();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_INVOKE_CHANNEL, {
      method: 'app.ping',
      input: undefined,
    });
  });

  it('delivers only the subscribed event from the event channel, until unsubscribed', () => {
    const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DesktopApi;
    const listener = vi.fn();
    const off = api.on('progress:a', listener);
    const [channel, onMessage] = electron.ipcRenderer.on.mock.calls[0] as [
      string,
      (sender: unknown, message: unknown) => void,
    ];
    expect(channel).toBe(IPC_EVENT_CHANNEL);
    onMessage({}, { event: 'progress:b', payload: 1 });
    onMessage({}, { event: 'progress:a', payload: 2 });
    expect(listener).toHaveBeenCalledExactlyOnceWith(2);
    off();
    expect(electron.ipcRenderer.off).toHaveBeenCalledWith(IPC_EVENT_CHANNEL, onMessage);
  });
});
