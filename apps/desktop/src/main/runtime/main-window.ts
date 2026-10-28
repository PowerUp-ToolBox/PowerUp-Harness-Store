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

/** Links the renderer may hand to the OS browser (`shell.openExternal`): https only. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
