/**
 * The Electron main process: the Runtime. This file is the only glue to Electron's APIs; the
 * services and IPC handlers live in src/main/runtime/, which never imports Electron, so they are
 * unit-tested under plain Node.
 */
import { join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, screen, session, shell } from 'electron';
import { IPC_INVOKE_CHANNEL } from '../shared/ipc.js';
import {
  APP_STATE_FILE_NAME,
  createAppStateFile,
  type AppStateFile,
} from './runtime/app-state-file.js';
import { createDispatcher } from './runtime/dispatcher.js';
import { createHandlers } from './runtime/handlers.js';
import { isAllowedExternalUrl, mainWindowOptions } from './runtime/main-window.js';
import type { Services } from './runtime/services.js';
import { createSettingsService } from './runtime/settings.js';
import { initialWindowBounds } from './runtime/window-state.js';

// A fresh profile for manual runs and E2E: must be set before `ready`.
const userDataDir = process.env.HARNESS_STORE_USER_DATA_DIR;
if (userDataDir) app.setPath('userData', resolve(userDataDir));

let mainWindow: BrowserWindow | null = null;

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
  void app.whenReady().then(start);
}

function start(): void {
  const appState = createAppStateFile(join(app.getPath('userData'), APP_STATE_FILE_NAME));
  const services: Services = {
    app: { version: app.getVersion() },
    // On Linux app.getLocale() follows LANG; on macOS and Windows the OS language, or `--lang`.
    settings: createSettingsService(appState, () => app.getLocale()),
  };
  const dispatch = createDispatcher({
    handlers: createHandlers(services),
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
  mainWindow = createMainWindow(appState);
}

function createMainWindow(appState: AppStateFile): BrowserWindow {
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const bounds = initialWindowBounds(appState.read().windowState ?? null, workAreas);
  const window = new BrowserWindow(
    mainWindowOptions(bounds, join(import.meta.dirname, '../preload/index.cjs')),
  );

  window.once('ready-to-show', () => {
    if (bounds.isMaximized) window.maximize();
    window.show();
  });
  window.on('close', () => {
    try {
      appState.update({
        windowState: { ...window.getNormalBounds(), isMaximized: window.isMaximized() },
      });
    } catch (error) {
      console.error('Could not save the window state', error);
    }
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
