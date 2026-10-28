import type { BrowserWindowConstructorOptions } from 'electron';
import { MIN_WINDOW_SIZE, type InitialWindowBounds } from './window-state.js';

/**
 * The main window's constructor options. The renderer is sandboxed with context isolation and no
 * Node integration: its only way into the Runtime is the `window.api` the preload exposes.
 */
export function mainWindowOptions(
  bounds: InitialWindowBounds,
  preloadPath: string,
): BrowserWindowConstructorOptions {
  const { x, y, width, height } = bounds;
  return {
    x,
    y,
    width,
    height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: 'Harness Store',
    // Shown on `ready-to-show`, so the User never sees an empty frame.
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
    },
  };
}

/** A terminal Harness window's size: the P0-05 default, with Settings' font size (P0-11) later. */
export const TERMINAL_WINDOW_SIZE = { width: 960, height: 640 } as const;

/**
 * A terminal Harness window's constructor options: titled "{name} — Harness Store", 960×640, and
 * sandboxed like the main window. Its page (harness.html: the top bar and the terminal) sees only
 * `window.harness`, from the Harness window preload; the Harness itself runs in the pty, never in
 * the page.
 */
export function terminalWindowOptions(
  name: string,
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    ...TERMINAL_WINDOW_SIZE,
    minWidth: 480,
    minHeight: 320,
    title: `${name} — Harness Store`,
    // The terminal's own background, so no white frame flashes before the page paints.
    backgroundColor: '#1b1c1f',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
    },
  };
}

/** Links the renderer may hand to the OS browser (`shell.openExternal`): https only. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
