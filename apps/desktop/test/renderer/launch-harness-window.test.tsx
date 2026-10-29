// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-empty-function -- stand-ins for xterm.js and the DOM */
/**
 * Tickets P0-05.2 and P0-05.3: a Harness window's own page, over a fake `window.harness`, with
 * xterm.js replaced by a stand-in (jsdom cannot lay a terminal out). The top bar shows the Harness,
 * its models and Open logs; after a terminal's process ended, "Exited with code N" with Relaunch
 * and Close, and the window title adds the exit code. A web window shows Starting, then leaves the
 * room to the Harness's page, or shows Crashed, Timed out, Could not start or (after code 0) Exited.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessWindowApp } from '../../src/renderer/src/harness/HarnessWindowApp.js';
import type { HarnessWindowEvents, HarnessWindowInfo } from '../../src/shared/harness-ipc.js';
import type { IpcResult, LaunchStatus } from '../../src/shared/ipc.js';

const terminals = vi.hoisted(() => [] as { written: string[] }[]);

// A stand-in for xterm.js: it records what is written to it.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    written: string[] = [];
    constructor() {
      terminals.push(this);
    }
    loadAddon() {}
    open() {}
    write(data: string) {
      this.written.push(data);
    }
    focus() {}
    dispose() {}
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

afterEach(() => {
  cleanup();
  terminals.length = 0;
});

const RUNNING: LaunchStatus = {
  harnessId: 'acme/hello-term',
  launchId: 'launch-1',
  state: 'ready',
  startedAt: '2026-10-28T09:00:00.000Z',
};

function fakeHarness(locale: 'en' | 'zh-CN' = 'en', web?: Partial<HarnessWindowInfo>) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const info: HarnessWindowInfo = {
    harnessId: 'acme/hello-term',
    name: 'Hello Term',
    uiKind: 'terminal',
    readyTimeoutSeconds: null,
    iconDataUrl: null,
    locale,
    status: RUNNING,
    ...web,
  };
  const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
  const harness = {
    window: {
      info: vi.fn(() => ok(info)),
      slots: vi.fn(() =>
        ok([
          {
            slot: 'default',
            binding: { connectionId: 'ollama', model: 'qwen3:8b', source: 'default' as const },
          },
          { slot: 'fast', binding: null },
        ]),
      ),
      openModels: vi.fn(() => ok(null)),
      openLogs: vi.fn<() => Promise<IpcResult<null>>>(() => ok(null)),
      relaunch: vi.fn(() => ok(null)),
      close: vi.fn(() => ok(null)),
    },
    web: {
      reload: vi.fn(() => ok(null)),
      layout: vi.fn(() => ok(null)),
    },
    terminal: {
      ready: vi.fn(() => ok(null)),
      input: vi.fn(() => ok(null)),
      resize: vi.fn(() => ok(null)),
      copy: vi.fn(() => ok(null)),
      paste: vi.fn(() => ok('')),
    },
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const forEvent = listeners.get(event) ?? new Set();
      listeners.set(event, forEvent);
      forEvent.add(listener);
      return () => {
        forEvent.delete(listener);
      };
    }),
    emit<E extends keyof HarnessWindowEvents>(event: E, payload: HarnessWindowEvents[E]) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
  Object.defineProperty(window, 'harness', { value: harness, configurable: true });
  return harness;
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

describe('Harness terminal window', () => {
  it('shows the Harness, its models and Open logs, and starts the terminal at its size', async () => {
    const harness = fakeHarness();
    await act(() => render(<HarnessWindowApp />));
    expect(await screen.findByText('Hello Term')).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Model · default: qwen3:8b' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Model · fast: Not set' }));
    expect(harness.window.openModels).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Open logs' }));
    expect(harness.window.openLogs).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Relaunch' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Terminal of Hello Term' })).toBeDefined();
    expect(document.title).toBe('Hello Term — Harness Store');

    // StrictMode is not used here, so one terminal reports its size once.
    expect(harness.terminal.ready).toHaveBeenCalledWith({ cols: 100, rows: 30 });
    act(() => {
      harness.emit('terminal.data', 'hello\r\n');
    });
    expect(terminals.at(-1)?.written).toEqual(['hello\r\n']);
  });

  it('after an exit, says so with Relaunch and Close, and the title adds the code', async () => {
    const harness = fakeHarness();
    await act(() => render(<HarnessWindowApp />));
    await screen.findByText('Hello Term');
    act(() => {
      harness.emit('window.state', {
        ...RUNNING,
        state: 'failed',
        reason: 'exit_nonzero',
        exitCode: 3,
      });
    });
    expect(screen.getByRole('status').textContent).toBe('Exited with code 3');
    expect(document.title).toBe('Hello Term — Harness Store (Exited with code 3)');
    fireEvent.click(screen.getByRole('button', { name: 'Relaunch' }));
    await waitFor(() => {
      expect(harness.window.relaunch).toHaveBeenCalledOnce();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(harness.window.close).toHaveBeenCalledOnce();
  });

  it('renders in zh-CN', async () => {
    const harness = fakeHarness('zh-CN');
    await act(() => render(<HarnessWindowApp />));
    await screen.findByText('Hello Term');
    act(() => {
      harness.emit('window.state', { ...RUNNING, state: 'stopped', exitCode: 0 });
    });
    expect(screen.getByRole('status').textContent).toBe('已退出，退出码 0');
    expect(screen.getByRole('button', { name: '重新启动' })).toBeDefined();
    expect(screen.getByRole('button', { name: '查看日志' })).toBeDefined();
    expect(await screen.findByRole('button', { name: '模型 · default：qwen3:8b' })).toBeDefined();
  });
});

const STARTING: LaunchStatus = {
  harnessId: 'acme/hello-web',
  launchId: 'launch-1',
  state: 'spawning',
  startedAt: '2026-10-28T09:00:00.000Z',
};

/** A web Harness window's page, its launch `status` when it opened. */
function fakeWebHarness(status: LaunchStatus = STARTING, locale: 'en' | 'zh-CN' = 'en') {
  return fakeHarness(locale, {
    harnessId: 'acme/hello-web',
    name: 'Hello Web',
    uiKind: 'web',
    readyTimeoutSeconds: 5,
    status,
  });
}

describe('Harness web window (P0-05.3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows Starting with the elapsed seconds and Cancel until the page is ready', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-28T09:00:02.400Z'));
    const harness = fakeWebHarness();
    await act(() => render(<HarnessWindowApp />));
    expect(await screen.findByText('Starting Hello Web…')).toBeDefined();
    expect(screen.getByText('2 s')).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText('5 s')).toBeDefined();
    expect(document.title).toBe('Hello Web — Harness Store');
    // No terminal, and Reload waits for the page.
    expect(screen.queryByRole('region', { name: 'Terminal of Hello Web' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveProperty('disabled', true);
    // The room for the Harness's page is reported to main.
    expect(harness.web.layout).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 });

    // Cancel closes the window, which stops the Harness.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(harness.window.close).toHaveBeenCalledOnce();

    act(() => {
      harness.emit('window.state', { ...STARTING, state: 'waiting-ready' });
    });
    expect(screen.getByText('Starting Hello Web…')).toBeDefined();
    act(() => {
      harness.emit('window.state', { ...STARTING, state: 'ready' });
    });
    expect(screen.queryByText('Starting Hello Web…')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(harness.web.reload).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Open logs' }));
    expect(harness.window.openLogs).toHaveBeenCalledOnce();
  });

  it('a timed-out launch shows the timeout message with the last lines of its log', async () => {
    const harness = fakeWebHarness({ ...STARTING, state: 'waiting-ready' });
    await act(() => render(<HarnessWindowApp />));
    await screen.findByText('Starting Hello Web…');
    // It is stopped before it fails: still starting for the User.
    act(() => {
      harness.emit('window.state', { ...STARTING, state: 'stopping' });
    });
    expect(screen.getByText('Starting Hello Web…')).toBeDefined();
    const logTail = [
      '2026-10-28T09:00:00.100Z [out] fixture-hang: line 60',
      '2026-10-28T09:00:05.000Z [runtime] Did not accept connections on 127.0.0.1:52341 within 5 s',
    ];
    act(() => {
      harness.emit('window.state', {
        ...STARTING,
        state: 'failed',
        reason: 'ready_timeout',
        exitCode: 143,
        logTail,
      });
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Hello Web did not start in time');
    expect(alert.textContent).toContain(
      'It did not accept connections within 5 seconds. Its last output:',
    );
    expect(screen.getByLabelText('Last output of Hello Web').textContent).toBe(logTail.join('\n'));
    fireEvent.click(screen.getByRole('button', { name: 'Show logs' }));
    expect(harness.window.openLogs).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Relaunch' }));
    await waitFor(() => {
      expect(harness.window.relaunch).toHaveBeenCalledOnce();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(harness.window.close).toHaveBeenCalledOnce();
  });

  it('a Harness that exits on its own shows Crashed with its exit code', async () => {
    const harness = fakeWebHarness({ ...STARTING, state: 'ready' });
    await act(() => render(<HarnessWindowApp />));
    await screen.findByText('Hello Web');
    act(() => {
      harness.emit('window.state', {
        ...STARTING,
        state: 'failed',
        reason: 'exit_nonzero',
        exitCode: 3,
      });
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Hello Web stopped unexpectedly');
    expect(alert.textContent).toContain('Exit code 3');
    expect(screen.queryByLabelText('Last output of Hello Web')).toBeNull();
    // The title keeps the name only: the exit code is in the window.
    expect(document.title).toBe('Hello Web — Harness Store');
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveProperty('disabled', true);
  });

  it('a Harness that quit with code 0 by itself says it exited, not that it crashed', async () => {
    const harness = fakeWebHarness({ ...STARTING, state: 'ready' });
    await act(() => render(<HarnessWindowApp />));
    await screen.findByText('Hello Web');
    act(() => {
      harness.emit('window.state', { ...STARTING, state: 'stopped', exitCode: 0 });
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Hello Web has exited');
    expect(alert.textContent).toContain('Exit code 0');
    expect(alert.textContent).not.toContain('stopped unexpectedly');
    for (const name of ['Show logs', 'Relaunch', 'Close']) {
      expect(screen.getByRole('button', { name })).toBeDefined();
    }
  });

  it('listens for its launch state before asking for it, so no state sent meanwhile is lost', async () => {
    const harness = fakeWebHarness();
    await act(() => render(<HarnessWindowApp />));
    await screen.findByText('Starting Hello Web…');
    const subscribed = harness.on.mock.calls.findIndex(([event]) => event === 'window.state');
    expect(subscribed).toBeGreaterThanOrEqual(0);
    expect(harness.on.mock.invocationCallOrder[subscribed]).toBeLessThan(
      harness.window.info.mock.invocationCallOrder[0] ?? 0,
    );
    // A state sent once the answer came is shown.
    act(() => {
      harness.emit('window.state', {
        ...STARTING,
        state: 'failed',
        reason: 'exit_nonzero',
        exitCode: 1,
      });
    });
    expect(screen.getByRole('alert').textContent).toContain('Hello Web stopped unexpectedly');
  });

  it('a process that could not start says so, and a refused Relaunch says why', async () => {
    const harness = fakeWebHarness();
    harness.window.relaunch.mockReturnValueOnce(
      Promise.resolve({
        ok: false as const,
        error: {
          code: 'slot_unbound',
          messageKey: 'error.slot_unbound',
          message: 'No model',
          params: { slot: 'default' },
        },
      }) as never,
    );
    await act(() => render(<HarnessWindowApp />));
    await screen.findByText('Starting Hello Web…');
    act(() => {
      harness.emit('window.state', { ...STARTING, state: 'failed', reason: 'spawn_error' });
    });
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('Hello Web could not start');
    fireEvent.click(screen.getByRole('button', { name: 'Relaunch' }));
    await waitFor(() => {
      expect(screen.getAllByRole('alert')).toHaveLength(2);
    });
  });

  it('refreshes its model indicator when main says the window gained focus', async () => {
    const harness = fakeWebHarness({ ...STARTING, state: 'ready' });
    await act(() => render(<HarnessWindowApp />));
    await screen.findByRole('button', { name: 'Model · default: qwen3:8b' });
    expect(harness.window.slots).toHaveBeenCalledOnce();
    act(() => {
      harness.emit('window.focus', null);
    });
    expect(harness.window.slots).toHaveBeenCalledTimes(2);
  });

  it('renders in zh-CN', async () => {
    const harness = fakeWebHarness(STARTING, 'zh-CN');
    await act(() => render(<HarnessWindowApp />));
    expect(await screen.findByText('正在启动 Hello Web…')).toBeDefined();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeDefined();
    act(() => {
      harness.emit('window.state', {
        ...STARTING,
        state: 'failed',
        reason: 'ready_timeout',
        exitCode: 143,
        logTail: [],
      });
    });
    expect(screen.getByRole('alert').textContent).toContain('Hello Web 启动超时');
    expect(screen.getByRole('alert').textContent).toContain('它没有任何输出。');
    // Open logs in the bar, Show logs in the overlay: both 查看日志.
    expect(screen.getAllByRole('button', { name: '查看日志' })).toHaveLength(2);
  });
});

describe('Open logs that the OS could not open', () => {
  const OPEN_FAILED: IpcResult<null> = {
    ok: false,
    error: {
      code: 'open_failed',
      messageKey: 'error.open_failed',
      params: { path: '/logs/acme/hello/launch-1.log' },
      message: 'unused: the catalog renders it',
    },
  };
  const SAYS =
    'Harness Store could not open "/logs/acme/hello/launch-1.log": no app on this computer opened it. Open it from your file browser instead.';

  it('a terminal window shows why under its top bar', async () => {
    const harness = fakeHarness();
    harness.window.openLogs.mockResolvedValueOnce(OPEN_FAILED);
    await act(() => render(<HarnessWindowApp />));
    fireEvent.click(await screen.findByRole('button', { name: 'Open logs' }));
    expect((await screen.findByRole('alert')).textContent).toBe(SAYS);
    // Trying again clears it once the log opens.
    fireEvent.click(screen.getByRole('button', { name: 'Open logs' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it("a web window shows why under its top bar while the Harness's page is shown", async () => {
    const harness = fakeWebHarness({ ...STARTING, state: 'ready' });
    harness.window.openLogs.mockResolvedValueOnce(OPEN_FAILED);
    await act(() => render(<HarnessWindowApp />));
    fireEvent.click(await screen.findByRole('button', { name: 'Open logs' }));
    expect((await screen.findByRole('alert')).textContent).toBe(SAYS);
  });

  it('an ended web window shows why in its overlay, after Show logs', async () => {
    const harness = fakeWebHarness({
      ...STARTING,
      state: 'failed',
      reason: 'exit_nonzero',
      exitCode: 3,
    });
    harness.window.openLogs.mockResolvedValueOnce(OPEN_FAILED);
    await act(() => render(<HarnessWindowApp />));
    fireEvent.click(await screen.findByRole('button', { name: 'Show logs' }));
    // The overlay is an alert itself; the error is the one inside it, and only there.
    const error = await screen.findByText(SAYS);
    expect(error.closest('.harness-overlay')).not.toBeNull();
    expect(screen.getAllByText(SAYS)).toHaveLength(1);
  });
});
