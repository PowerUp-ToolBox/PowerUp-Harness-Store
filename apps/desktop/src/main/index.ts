/**
 * The Electron main process: the Runtime. This file and ./harness-windows.ts are the only glue to
 * Electron's APIs; the services and IPC handlers live in src/main/runtime/, which never imports
 * Electron, so they are unit-tested under plain Node.
 */
import { join, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { HARNESS_INVOKE_CHANNEL } from '../shared/harness-ipc.js';
import {
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  type IpcEventMessage,
  type IpcEventName,
  type IpcEvents,
} from '../shared/ipc.js';
import { createHarnessWindows } from './harness-windows.js';
import { startRuntime, type Runtime } from './runtime/bootstrap.js';
import { createDispatcher, UntrustedSenderError } from './runtime/dispatcher.js';
import { createHandlers } from './runtime/handlers.js';
import { createHarnessWindowHandlers } from './runtime/harness-window-handlers.js';
import {
  harnessPartition,
  isAllowedExternalUrl,
  mainWindowOptions,
} from './runtime/main-window.js';
import { createSafeStorageCipher } from './runtime/secret-cipher.js';
import { STORE_ASSET_SCHEME, storeAssetSource } from '../shared/store-assets.js';
import { AUTH_SCHEME } from './runtime/store-auth.js';
import { initialWindowBounds } from './runtime/window-state.js';

// A fresh profile for manual runs and E2E: must be set before `ready`.
const userDataDir = process.env.HARNESS_STORE_USER_DATA_DIR;
if (userDataDir) app.setPath('userData', resolve(userDataDir));

let mainWindow: BrowserWindow | null = null;
/** The Runtime from the moment `start` begins it; null before that. */
let runtime: Promise<Runtime> | null = null;
/** The Runtime once it has started and the main window was first opened. */
let startedRuntime: Runtime | null = null;
const harnessWindows = createHarnessWindows();
/** Quitting: 'idle', then 'stopping' while the Runtime shuts down, then 'stopped'. */
let quitState: 'idle' | 'stopping' | 'stopped' = 'idle';

// The Store's images (src/shared/store-assets.ts): a standard, secure scheme, so an <img> of the
// main window loads it like https. Must be registered before `ready`.
protocol.registerSchemesAsPrivileged([
  { scheme: STORE_ASSET_SCHEME, privileges: { standard: true, secure: true } },
]);

// One Runtime per profile: a second launch focuses the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // The Store sign-in comes back from the browser as harnessstore://auth-callback. Packaged builds
  // also declare the scheme in electron-builder.yml; in development the OS must start Electron
  // with this app's entry script.
  if (process.defaultApp && process.argv[1] !== undefined) {
    app.setAsDefaultProtocolClient(AUTH_SCHEME, process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(AUTH_SCHEME);
  }
  // macOS hands the URL to the running app.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    openedWithUrl(url);
  });
  // Windows and Linux start a second instance with the URL in its arguments; it quits at once
  // (no lock) and the running one receives them here.
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((argument) => argument.startsWith(`${AUTH_SCHEME}:`));
    if (url !== undefined) openedWithUrl(url);
    else showMainWindow();
  });
  // Quit with the last window on every platform, macOS included: the main window may close while
  // Harness windows stay open, and the app runs on until those close too.
  app.on('window-all-closed', () => {
    app.quit();
  });
  // macOS: clicking the Dock icon while only Harness windows are open brings the main window back.
  // (Windows and Linux: starting the app again does, through `second-instance`.)
  app.on('activate', () => {
    if (mainWindow === null) showMainWindow();
  });
  // The first quit request is held until the Runtime has stopped: every running Harness stops
  // (SIGTERM, then SIGKILL after 5 s; 10 s at most in all), the Model Gateway stops listening
  // (writing its last Usage Records), then the database closes. Then the app quits.
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
 * Brings the main window to the front, restoring it when minimized. The User may have closed it
 * while Harness windows kept the app running: it opens again then, on the Library.
 */
function showMainWindow(): void {
  if (mainWindow === null) {
    if (startedRuntime !== null && quitState === 'idle') {
      mainWindow = createMainWindow(startedRuntime);
    }
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/** Pushes an event to the main window's renderer; dropped while there is none. */
function emitToMainWindow<E extends IpcEventName>(event: E, payload: IpcEvents[E]): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  const message: IpcEventMessage = { event, payload };
  mainWindow.webContents.send(IPC_EVENT_CHANNEL, message);
}

/**
 * A Harness window's model indicator: the Models page at that Harness's card, in the main window,
 * which opens again if the User closed it while Harnesses ran.
 */
function openModelsPage(harnessId: string): void {
  const path = `/models?harness=${encodeURIComponent(harnessId)}`;
  if (mainWindow !== null) {
    showMainWindow();
    emitToMainWindow('app.navigate', { path });
  } else if (startedRuntime !== null && quitState === 'idle') {
    mainWindow = createMainWindow(startedRuntime, path);
  }
}

/**
 * A `harnessstore:` URL the OS opened the app with: the Store sign-in callback, which completes
 * the sign-in waiting for it (one that arrives with none waiting is ignored). The app comes to
 * the front either way, since the User just left the browser for it.
 */
function openedWithUrl(url: string): void {
  showMainWindow();
  if (process.platform === 'darwin') app.focus({ steal: true });
  void runtime?.then((started) => started.auth.handleCallback(url));
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
    storeFetch: (url, init) => net.fetch(url, init),
    // The Store's GitHub sign-in opens in the User's own browser, never in a window of the app:
    // no GitHub password is ever typed into Harness Store.
    openExternal: (url) => shell.openExternal(url),
    // Connection tests, model listings and local detection use Node's fetch, as the Model
    // Gateway's upstream calls do, so a passing test means the Gateway reaches the same place.
    providerFetch: (input, init) => globalThis.fetch(input, init),
    // safeStorage is usable from `ready` on, which start() runs after.
    secretCipher: createSafeStorageCipher(safeStorage, process.platform),
    // "Install this folder locally" and the Workspace sheet: the native folder picker, as a sheet
    // of the main window, at the last Workspace when there is one.
    pickFolder: async (defaultPath) => {
      const options: OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
        ...(defaultPath === undefined || defaultPath === null ? {} : { defaultPath }),
      };
      const result =
        mainWindow === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(mainWindow, options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    // The Usage page's CSV export: the native save dialog, as a sheet of the main window.
    pickSaveFile: async (defaultName) => {
      const options: SaveDialogOptions = {
        defaultPath: defaultName,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      };
      const result =
        mainWindow === null
          ? await dialog.showSaveDialog(options)
          : await dialog.showSaveDialog(mainWindow, options);
      return result.canceled || result.filePath === '' ? null : result.filePath;
    },
    // `launch.state`, `installs.changed` and `usage.recorded` go to the main window only, which
    // shows every Harness. A Harness window hears about its own launch alone, as `window.state` on its own
    // channel (./harness-windows.ts); its page has no use for other launches.
    emit: emitToMainWindow,
    // Every Harness runs in a window of its own (./harness-windows.ts).
    harnessWindows,
    // A launch's log, a Harness's logs folder or its Data Directory, in the OS's own app for it.
    // A failure is the User's to see (`open_failed` on the card or in the Harness window).
    openPath: async (path) => {
      const error = await shell.openPath(path);
      if (error !== '') console.error(`Could not open ${path}: ${error}`);
      return error === '';
    },
    // What a web Harness's page kept in its own session goes with it on uninstall.
    clearHarnessSession: (harnessId) =>
      session.fromPartition(harnessPartition(harnessId)).clearStorageData(),
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
  // A Harness window's calls act on its own launch only, found from the window that sent them.
  ipcMain.handle(HARNESS_INVOKE_CHANNEL, (event, request: unknown) => {
    const launchId = harnessWindows.launchOf(event.sender);
    if (launchId === null) throw new UntrustedSenderError();
    return createDispatcher({
      handlers: createHarnessWindowHandlers(launchId, {
        supervisor: started.supervisor,
        bindings: started.services.bindings,
        clipboard,
        openModels: openModelsPage,
      }),
      isTrustedSender: () => true,
      onHandlerError: (method, error) => {
        console.error(`Harness window handler ${method} threw`, error);
      },
    })(event.sender, request);
  });
  // The Store's images, fetched from the Store's asset bucket only; anything else is not found.
  protocol.handle(STORE_ASSET_SCHEME, (request) => {
    const source =
      request.method === 'GET' ? storeAssetSource(request.url, started.storeBaseUrl()) : null;
    return source === null ? new Response(null, { status: 404 }) : net.fetch(source);
  });
  // The renderer never needs camera, notifications, geolocation and the like.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  startedRuntime = started;
  mainWindow = createMainWindow(started);
}

/** Opens the main window, on the Library or on `route` (a hash route such as `/models`). */
function createMainWindow(started: Runtime, route?: string): BrowserWindow {
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
  // Only this page knows the job IDs of its Store installs: once it is gone (the window closed
  // while a Harness window keeps the app running, or its renderer crashed) or loads again, nothing
  // would confirm or cancel them, so their downloads and rows are discarded now. Hash routes are
  // same-document navigations and keep them.
  const dropStoreInstalls = () => {
    void started.services.installs.cancelAll();
  };
  window.webContents.on('destroyed', dropStoreInstalls);
  window.webContents.on('render-process-gone', dropStoreInstalls);
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) dropStoreInstalls();
  });

  // The renderer is a single page with hash routes: it never navigates away, and every new
  // window is refused. http(s) links (README, homepage, source) open in the User's browser instead.
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(route === undefined ? devServerUrl : `${devServerUrl}#${route}`);
  } else {
    void window.loadFile(
      join(import.meta.dirname, '../renderer/index.html'),
      route === undefined ? {} : { hash: route },
    );
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
