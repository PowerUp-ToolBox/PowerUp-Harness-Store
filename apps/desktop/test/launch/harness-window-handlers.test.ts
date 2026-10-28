import { describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHarnessWindowHandlers } from '../../src/main/runtime/harness-window-handlers.js';
import { ok } from '../../src/main/runtime/ipc-result.js';
import {
  createSupervisorStub,
  type LaunchWindow,
  type Supervisor,
} from '../../src/main/runtime/supervisor.js';
import { HARNESS_WINDOW_METHODS } from '../../src/shared/harness-ipc.js';

/**
 * Ticket P0-05.2: the Harness window IPC. Every call acts on the launch main found from the
 * sending window, checks its input, and reaches only that launch.
 */

function setup() {
  const launchWindow = {
    harnessId: 'acme/hello',
    info: vi.fn(() =>
      Promise.resolve({
        harnessId: 'acme/hello',
        name: 'Hello',
        uiKind: 'terminal' as const,
        readyTimeoutSeconds: null,
        iconDataUrl: null,
        locale: 'en' as const,
        status: {
          harnessId: 'acme/hello',
          launchId: 'launch-1',
          state: 'ready' as const,
          startedAt: '2026-10-28T09:00:00.000Z',
        },
      }),
    ),
    openLogs: vi.fn(() => Promise.resolve()),
    relaunch: vi.fn(() =>
      Promise.resolve(ok({ outcome: 'started' as const, launchId: 'launch-2' })),
    ),
    close: vi.fn(),
    reload: vi.fn(),
    webLayout: vi.fn(),
    terminalReady: vi.fn(),
    terminalInput: vi.fn(),
    terminalResize: vi.fn(),
  } satisfies LaunchWindow;
  const supervisor: Supervisor = {
    ...createSupervisorStub(),
    window: (launchId) => (launchId === 'launch-1' ? launchWindow : null),
  };
  const clipboard = {
    readText: vi.fn(() => Promise.resolve('pasted')),
    writeText: vi.fn(() => Promise.resolve()),
  };
  const openModels = vi.fn();
  const resolveAll = vi.fn(() => ok([{ slot: 'default', binding: null }]));
  const call = (launchId: string, method: string, input?: unknown) =>
    createDispatcher({
      handlers: createHarnessWindowHandlers(launchId, {
        supervisor,
        bindings: { resolveAll },
        clipboard,
        openModels,
      }),
      isTrustedSender: () => true,
    })(launchId, { method, input });
  return { launchWindow, clipboard, openModels, resolveAll, call };
}

describe('Harness window handlers', () => {
  it('has one handler per method of the contract', () => {
    const handlers = createHarnessWindowHandlers('launch-1', {
      supervisor: createSupervisorStub(),
      bindings: { resolveAll: () => ok([]) },
      clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
      openModels: () => undefined,
    });
    expect(Object.keys(handlers).sort()).toEqual([...HARNESS_WINDOW_METHODS].sort());
  });

  it("acts on the window's own launch", async () => {
    const { launchWindow, clipboard, openModels, resolveAll, call } = setup();
    await expect(call('launch-1', 'window.info')).resolves.toMatchObject({
      ok: true,
      data: { harnessId: 'acme/hello', status: { state: 'ready' } },
    });
    await expect(call('launch-1', 'window.slots')).resolves.toEqual({
      ok: true,
      data: [{ slot: 'default', binding: null }],
    });
    expect(resolveAll).toHaveBeenCalledWith('acme/hello');
    await call('launch-1', 'window.openModels');
    expect(openModels).toHaveBeenCalledWith('acme/hello');
    await call('launch-1', 'window.openLogs');
    expect(launchWindow.openLogs).toHaveBeenCalledOnce();
    await expect(call('launch-1', 'window.relaunch')).resolves.toEqual({ ok: true, data: null });
    await call('launch-1', 'window.close');
    expect(launchWindow.close).toHaveBeenCalledOnce();
    await call('launch-1', 'web.reload');
    expect(launchWindow.reload).toHaveBeenCalledOnce();
    await call('launch-1', 'web.layout', { x: 0, y: 44.5, width: 1100, height: 760 });
    expect(launchWindow.webLayout).toHaveBeenCalledWith({
      x: 0,
      y: 44.5,
      width: 1100,
      height: 760,
    });
    await call('launch-1', 'terminal.ready', { cols: 80, rows: 24 });
    expect(launchWindow.terminalReady).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    await call('launch-1', 'terminal.input', 'ls\r');
    expect(launchWindow.terminalInput).toHaveBeenCalledWith('ls\r');
    await call('launch-1', 'terminal.resize', { cols: 120, rows: 40 });
    expect(launchWindow.terminalResize).toHaveBeenCalledWith({ cols: 120, rows: 40 });
    await call('launch-1', 'terminal.copy', 'selected');
    expect(clipboard.writeText).toHaveBeenCalledWith('selected');
    await expect(call('launch-1', 'terminal.paste')).resolves.toEqual({
      ok: true,
      data: 'pasted',
    });
  });

  it.each([
    ['window.info', {}],
    ['window.close', 'now'],
    ['terminal.ready', undefined],
    ['terminal.ready', { cols: 0, rows: 24 }],
    ['terminal.ready', { cols: 80.5, rows: 24 }],
    ['terminal.resize', { cols: 80, rows: 24, x: 1 }],
    ['terminal.resize', { cols: 80, rows: 1001 }],
    ['terminal.input', 42],
    ['terminal.copy', undefined],
    ['terminal.paste', 'x'],
    ['web.reload', 1],
    ['web.layout', { x: 0, y: 0, width: 10 }],
    ['web.layout', { x: 0, y: -1, width: 10, height: 10 }],
    ['web.layout', { x: 0, y: 0, width: Infinity, height: 10 }],
  ])('%s rejects %j as invalid_input', async (method, input) => {
    const { call, launchWindow } = setup();
    await expect(call('launch-1', method, input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input', params: { method } },
    });
    expect(launchWindow.terminalReady).not.toHaveBeenCalled();
    expect(launchWindow.webLayout).not.toHaveBeenCalled();
  });

  it('answers invalid_input for a launch the Supervisor does not know', async () => {
    const { call, launchWindow } = setup();
    await expect(call('launch-9', 'window.close')).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(launchWindow.close).not.toHaveBeenCalled();
  });
});
