/**
 * The Harness windows: one Electron window per launch, opened and driven by the Process Supervisor
 * through {@link HarnessWindows}. With src/main/index.ts, the only main file that imports Electron;
 * what can be decided without it (the window options, the IPC handlers) lives in src/main/runtime/.
 *
 * A terminal window loads the app's own `harness.html` (the top bar and xterm.js) with the Harness
 * window preload, which exposes only `window.harness`: calls about this window's launch, on the
 * Harness window channels. {@link ElectronHarnessWindows.launchOf} tells main which launch a call
 * comes from, so a window can never act on another launch, and never reaches `window.api`.
 */
import { join } from 'node:path';
import { app, BrowserWindow, type WebContents } from 'electron';
import { HARNESS_EVENT_CHANNEL } from '../shared/harness-ipc.js';
import type { IpcEventMessage } from '../shared/ipc.js';
import { terminalWindowOptions } from './runtime/main-window.js';
import type { HarnessWindows } from './runtime/supervisor.js';

export interface ElectronHarnessWindows extends HarnessWindows {
  /** The launch whose window `sender` is; null for any other sender. */
  launchOf(sender: WebContents): string | null;
}

export function createHarnessWindows(): ElectronHarnessWindows {
  const windows = new Map<string, BrowserWindow>();
  const live = (launchId: string): BrowserWindow | null => {
    const window = windows.get(launchId);
    return window === undefined || window.isDestroyed() ? null : window;
  };

  return {
    openTerminal(spec, onClosed) {
      const window = new BrowserWindow(
        terminalWindowOptions(spec.name, join(import.meta.dirname, '../preload/harness.cjs')),
      );
      windows.set(spec.launchId, window);
      // No menu bar on Windows and Linux, so Ctrl+C and the other control keys reach the pty;
      // macOS keeps the app menu, whose Edit roles copy and paste in the terminal.
      if (process.platform !== 'darwin') window.removeMenu();
      window.once('ready-to-show', () => {
        window.show();
      });
      window.on('closed', () => {
        windows.delete(spec.launchId);
        onClosed();
      });
      // The page never navigates and opens no window.
      window.webContents.on('will-navigate', (event) => {
        event.preventDefault();
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      const devServerUrl = process.env.ELECTRON_RENDERER_URL;
      if (!app.isPackaged && devServerUrl) {
        void window.loadURL(`${devServerUrl}/harness.html`);
      } else {
        void window.loadFile(join(import.meta.dirname, '../renderer/harness.html'));
      }
    },
    send(launchId, event, payload) {
      const window = live(launchId);
      if (window === null) return;
      const message: IpcEventMessage = { event, payload };
      window.webContents.send(HARNESS_EVENT_CHANNEL, message);
    },
    focus(launchId) {
      const window = live(launchId);
      if (window === null) return false;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return true;
    },
    close(launchId) {
      live(launchId)?.close();
    },
    launchOf(sender) {
      for (const [launchId, window] of windows) {
        if (!window.isDestroyed() && window.webContents === sender) return launchId;
      }
      return null;
    },
  };
}
