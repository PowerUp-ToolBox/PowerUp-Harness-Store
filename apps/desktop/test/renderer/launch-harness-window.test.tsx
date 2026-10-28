// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-empty-function -- stand-ins for xterm.js and the DOM */
/**
 * Ticket P0-05.2: a terminal Harness window's own page, over a fake `window.harness`, with
 * xterm.js replaced by a stand-in (jsdom cannot lay a terminal out). The top bar shows the Harness,
 * its models and Open logs; after the process ended, "Exited with code N" with Relaunch and Close,
 * and the window title adds the exit code.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessWindowApp } from '../../src/renderer/src/harness/HarnessWindowApp.js';
import type { HarnessWindowEvents, HarnessWindowInfo } from '../../src/shared/harness-ipc.js';
import type { LaunchStatus } from '../../src/shared/ipc.js';

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

function fakeHarness(locale: 'en' | 'zh-CN' = 'en') {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const info: HarnessWindowInfo = {
    harnessId: 'acme/hello-term',
    name: 'Hello Term',
    uiKind: 'terminal',
    iconDataUrl: null,
    locale,
    status: RUNNING,
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
      openLogs: vi.fn(() => ok(null)),
      relaunch: vi.fn(() => ok(null)),
      close: vi.fn(() => ok(null)),
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
