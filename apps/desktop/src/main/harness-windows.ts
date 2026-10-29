/**
 * The Harness windows: one Electron window per launch, opened and driven by the Process Supervisor
 * through {@link HarnessWindows}. With src/main/index.ts, the only main file that imports Electron;
 * what can be decided without it (the window options, the navigation rules, the IPC handlers)
 * lives in src/main/runtime/.
 *
 * Every Harness window loads the app's own `harness.html` (the top bar and, for a terminal UI
 * Kind, xterm.js) with the Harness window preload, which exposes only `window.harness`: calls
 * about this window's launch, on the Harness window channels. {@link ElectronHarnessWindows.launchOf}
 * tells main which launch a call comes from, so a window can never act on another launch, and
 * never reaches `window.api`.
 *
 * A web Harness's own page is not that page: once its port accepts connections it is loaded in a
 * WebContentsView laid over the window's page under the top bar, with no preload (page script
 * reaches neither Node nor Electron IPC), sandboxed, with context isolation, in a session of its
 * own that denies every permission. Only its origin, `http://127.0.0.1:<port>`, stays in the view;
 * other http(s) URLs open in the User's browser and every other scheme is blocked. That rule
 * guards the main frame; the page's iframes load and redirect as page content.
 */
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  session,
  shell,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron';
import { HARNESS_EVENT_CHANNEL, type WebContentArea } from '../shared/harness-ipc.js';
import type { IpcEventMessage } from '../shared/ipc.js';
import {
  harnessFrameNavigation,
  harnessNavigation,
  terminalWindowOptions,
  webContentPreferences,
  webWindowOptions,
} from './runtime/main-window.js';
import type { HarnessWindows, HarnessWindowSpec } from './runtime/supervisor.js';

export interface ElectronHarnessWindows extends HarnessWindows {
  /** The launch whose window `sender` is; null for any other sender. */
  launchOf(sender: WebContents): string | null;
}

/** One launch's window and, for a web Harness, its page. */
interface HarnessWindow {
  readonly spec: HarnessWindowSpec;
  readonly window: BrowserWindow;
  view: WebContentsView | null;
  /** Where the page goes, as the window's own page last reported it. */
  area: WebContentArea | null;
}

export function createHarnessWindows(): ElectronHarnessWindows {
  const windows = new Map<string, HarnessWindow>();
  /** The partitions whose sessions already deny every permission. */
  const lockedSessions = new Set<string>();
  const live = (launchId: string): HarnessWindow | null => {
    const entry = windows.get(launchId);
    return entry === undefined || entry.window.isDestroyed() ? null : entry;
  };

  const open = (
    spec: HarnessWindowSpec,
    options: BrowserWindowConstructorOptions,
    onClosed: () => void,
  ) => {
    const window = new BrowserWindow(options);
    const entry: HarnessWindow = { spec, window, view: null, area: null };
    windows.set(spec.launchId, entry);
    // No menu bar on Windows and Linux, so Ctrl+C and the other control keys reach the pty;
    // macOS keeps the app menu, whose Edit roles copy and paste in the terminal.
    if (process.platform !== 'darwin') window.removeMenu();
    window.once('ready-to-show', () => {
      window.show();
    });
    window.on('resize', () => {
      layout(entry);
    });
    window.on('focus', () => {
      const message: IpcEventMessage = { event: 'window.focus', payload: null };
      window.webContents.send(HARNESS_EVENT_CHANNEL, message);
    });
    window.on('closed', () => {
      windows.delete(spec.launchId);
      closeView(entry);
      onClosed();
    });
    // The window's own page never navigates and opens no window.
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
  };

  /** Puts a web Harness's page where the window's own page measured the room for it. */
  const layout = (entry: HarnessWindow) => {
    const { view, area, window } = entry;
    if (view === null || area === null || window.isDestroyed()) return;
    // The page measures in CSS pixels; its zoom (the View menu) scales them.
    const zoom = window.webContents.getZoomFactor();
    view.setBounds({
      x: Math.round(area.x * zoom),
      y: Math.round(area.y * zoom),
      width: Math.round(area.width * zoom),
      height: Math.round(area.height * zoom),
    });
  };

  const closeView = (entry: HarnessWindow) => {
    const { view } = entry;
    if (view === null) return;
    entry.view = null;
    if (!entry.window.isDestroyed()) entry.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };

  /** A Harness's session asks for nothing: camera, microphone, notifications, location, devices. */
  const lockSession = (partition: string) => {
    if (lockedSessions.has(partition)) return;
    lockedSessions.add(partition);
    const harnessSession = session.fromPartition(partition);
    harnessSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    harnessSession.setPermissionCheckHandler(() => false);
    harnessSession.setDevicePermissionHandler(() => false);
    // Downloads stay allowed, through Electron's save dialog, so the User picks where each file
    // goes. Blocking them would protect nothing (the Harness process already runs unsandboxed
    // with the User's permissions) and would break a web Harness's Export.
  };

  return {
    openTerminal(spec, onClosed) {
      open(
        spec,
        terminalWindowOptions(spec.name, join(import.meta.dirname, '../preload/harness.cjs')),
        onClosed,
      );
    },
    openWeb(spec, onClosed) {
      open(
        spec,
        webWindowOptions(spec.name, join(import.meta.dirname, '../preload/harness.cjs'), spec.size),
        onClosed,
      );
    },
    showWeb(launchId, url) {
      const entry = live(launchId);
      if (entry?.view !== null) return;
      const { origin } = new URL(url);
      const preferences = webContentPreferences(entry.spec.harnessId);
      lockSession(preferences.partition);
      const view = new WebContentsView({ webPreferences: preferences });
      view.setBackgroundColor('#ffffff');
      const contents = view.webContents;
      // `will-redirect` fires for iframes too; their redirects are left alone.
      const guard = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
        const where = harnessFrameNavigation(event, origin);
        if (where === 'inside') return;
        event.preventDefault();
        if (where === 'external') void shell.openExternal(event.url);
      };
      contents.on('will-navigate', guard);
      contents.on('will-redirect', guard);
      // window.open and target="_blank": the Harness's own pages replace this one, as the
      // window is the Harness's only one; other http(s) URLs open in the User's browser.
      contents.setWindowOpenHandler(({ url: target }) => {
        const where = harnessNavigation(target, origin);
        if (where === 'inside') void contents.loadURL(target);
        else if (where === 'external') void shell.openExternal(target);
        return { action: 'deny' };
      });
      contents.on('will-attach-webview', (event) => {
        event.preventDefault();
      });
      entry.view = view;
      entry.window.contentView.addChildView(view);
      layout(entry);
      void contents.loadURL(url).then(
        () => {
          if (entry.window.isFocused()) contents.focus();
        },
        () => undefined,
      );
    },
    hideWeb(launchId) {
      const entry = live(launchId);
      if (entry !== null) closeView(entry);
    },
    reloadWeb(launchId) {
      live(launchId)?.view?.webContents.reload();
    },
    layoutWeb(launchId, area) {
      const entry = live(launchId);
      if (entry === null) return;
      entry.area = area;
      layout(entry);
    },
    send(launchId, event, payload) {
      const entry = live(launchId);
      if (entry === null) return;
      const message: IpcEventMessage = { event, payload };
      entry.window.webContents.send(HARNESS_EVENT_CHANNEL, message);
    },
    focus(launchId) {
      const entry = live(launchId);
      if (entry === null) return false;
      const { window } = entry;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return true;
    },
    close(launchId) {
      live(launchId)?.window.close();
    },
    launchOf(sender) {
      for (const [launchId, { window }] of windows) {
        if (!window.isDestroyed() && window.webContents === sender) return launchId;
      }
      return null;
    },
  };
}
