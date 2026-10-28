/**
 * The Electron main process: the Runtime. This file is the only glue to Electron's APIs; the
 * services and IPC handlers live in src/main/runtime/, which never imports Electron, so they are
 * unit-tested under plain Node.
 */
import { join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, net, safeStorage, screen, session, shell } from 'electron';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL, type IpcEventMessage } from '../shared/ipc.js';
import { startRuntime, type Runtime } from './runtime/bootstrap.js';
import { createDispatcher } from './runtime/dispatcher.js';
import { createHandlers } from './runtime/handlers.js';
import { isAllowedExternalUrl, mainWindowOptions } from './runtime/main-window.js';
import { createSafeStorageCipher } from './runtime/secret-cipher.js';
import { initialWindowBounds } from './runtime/window-state.js';

// A fresh profile for manual runs and E2E: must be set before `ready`.
const userDataDir = process.env.HARNESS_STORE_USER_DATA_DIR;
if (userDataDir) app.setPath('userData', resolve(userDataDir));

let mainWindow: BrowserWindow | null = null;
/** The Runtime from the moment `start` begins it; null before that. */
let runtime: Promise<Runtime> | null = null;
/** Quitting: 'idle', then 'stopping' while the Runtime shuts down, then 'stopped'. */
let quitState: 'idle' | 'stopping' | 'stopped' = 'idle';

// One Runtime per profile: a second launch focuses the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  // Quit with the last window on every platform, macOS included (no Harness windows yet).
  app.on('window-all-closed', () => {
    app.quit();
  });
  // The first quit request is held until the Runtime has stopped: the Model Gateway stops
  // listening (writing its last Usage Records), then the database closes. Then the app quits.
  app.on('before-quit', (event) => {
    if (runtime === null || quitState === 'stopped') return;
    event.preventDefault();
    if (quitState === 'stopping') return;
    quitState = 'stopping';
    void runtime
      .then((started) => {
        if (mainWindow !== null) saveWindowState(mainWindow, started);
        return started.shutdown();
      })
      .catch((error: unknown) => {
        console.error('The Runtime did not shut down cleanly', error);
      })
      .finally(() => {
        quitState = 'stopped';
        app.quit();
      });
  });
  // startRuntime never rejects, so this is the last resort for a bug in the glue below: quit
  // rather than stay running without a window while holding the single-instance lock.
  void app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      console.error('The app could not start', error);
      app.quit();
    });
}

/**
 * Starts the Runtime (SQLite, then the Model Gateway) before the window exists, then opens the
 * window. A failed step still opens it: the renderer asks `app.status` first and shows a blocking
 * error screen instead of the app.
 */
async function start(): Promise<void> {
  runtime = startRuntime({
    dataDir: app.getPath('userData'),
    version: app.getVersion(),
    // On Linux app.getLocale() follows LANG; on macOS and Windows the OS language, or `--lang`.
    osLocale: () => app.getLocale(),
    quit: () => {
      app.quit();
    },
    // net.fetch goes through Chromium's network stack, so the OS proxy settings apply.
    fetch: (url, init) => net.fetch(url, init),
    // safeStorage is usable from `ready` on, which start() runs after.
    secretCipher: createSafeStorageCipher(safeStorage, process.platform),
    emit: (event, payload) => {
      if (mainWindow === null || mainWindow.isDestroyed()) return;
      const message: IpcEventMessage = { event, payload };
      mainWindow.webContents.send(IPC_EVENT_CHANNEL, message);
    },
  });
  const started = await runtime;
  // Quit while starting: the Runtime is already shutting down.
  if (quitState !== 'idle') return;
  const dispatch = createDispatcher({
    handlers: createHandlers(started.services),
    isTrustedSender: (sender) => mainWindow !== null && sender === mainWindow.webContents,
    onHandlerError: (method, error) => {
      console.error(`IPC handler ${method} threw`, error);
    },
  });
  ipcMain.handle(IPC_INVOKE_CHANNEL, (event, request: unknown) => dispatch(event.sender, request));
  // The renderer never needs camera, notifications, geolocation and the like.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  mainWindow = createMainWindow(started);
}

function createMainWindow(started: Runtime): BrowserWindow {
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const bounds = initialWindowBounds(started.windowState.read(), workAreas);
  const window = new BrowserWindow(
    mainWindowOptions(bounds, join(import.meta.dirname, '../preload/index.cjs')),
  );

  window.once('ready-to-show', () => {
    if (bounds.isMaximized) window.maximize();
    window.show();
  });
  window.on('close', () => {
    saveWindowState(window, started);
  });
  window.on('closed', () => {
    mainWindow = null;
  });

  // The renderer is a single page with hash routes: it never navigates away, and every new
  // window is refused. https links open in the User's browser instead.
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
}

/**
 * Saves the window's geometry for the next launch: on close, and on quit before the database
 * closes (after that, saving does nothing).
 */
function saveWindowState(window: BrowserWindow, started: Runtime): void {
  try {
    started.windowState.save({ ...window.getNormalBounds(), isMaximized: window.isMaximized() });
  } catch (error) {
    console.error('Could not save the window state', error);
  }
}
