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

/** A web Harness's content size when its Manifest gives no `ui.window` hint. */
export const WEB_CONTENT_SIZE = { width: 1100, height: 760 } as const;
/** Room for the top bar above a web Harness's page, in the window's first size. */
export const HARNESS_BAR_ALLOWANCE = 44;

/**
 * A web Harness window's constructor options: titled "{name} — Harness Store", the `ui.window`
 * hints (default 1100×760) as the size of the Harness's page plus the top bar, and sandboxed like
 * the terminal window. The window's own page is harness.html (the top bar and the Starting,
 * Crashed and Timed-out states); the Harness's page is a separate view on top of it
 * ({@link webContentPreferences}), which never sees `window.harness`.
 */
export function webWindowOptions(
  name: string,
  preloadPath: string,
  hints: { readonly width?: number; readonly height?: number } = {},
): BrowserWindowConstructorOptions {
  return {
    ...terminalWindowOptions(name, preloadPath),
    width: hints.width ?? WEB_CONTENT_SIZE.width,
    height: (hints.height ?? WEB_CONTENT_SIZE.height) + HARNESS_BAR_ALLOWANCE,
    useContentSize: true,
    backgroundColor: '#ffffff',
  };
}

/**
 * The web preferences of a web Harness's own page (a WebContentsView of its window): no preload,
 * so page script reaches neither Node nor Electron IPC; sandboxed, with context isolation; and a
 * session of its own per Harness ({@link harnessPartition}), so a port another Harness used before
 * never hands it that Harness's storage.
 */
export function webContentPreferences(harnessId: string) {
  return {
    partition: harnessPartition(harnessId),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    webviewTag: false,
    safeDialogs: true,
  } as const;
}

/**
 * The persistent session of a web Harness's page: `persist:harness:<publisher>/<slug>`. Its
 * origin, `http://127.0.0.1:<port>`, still changes with the port of each launch, so storage the
 * page keeps by origin does not carry over between launches (a known limitation of P0).
 */
export function harnessPartition(harnessId: string): string {
  return `persist:harness:${harnessId}`;
}

/** Where a URL a web Harness's page navigates to, or opens, goes. */
export type HarnessNavigation = 'inside' | 'external' | 'blocked';

/**
 * Navigation of a web Harness's page: only its own origin, exactly `http://127.0.0.1:<port>`,
 * stays in the window; any other http or https URL (`localhost:<port>` included) opens in the
 * User's browser; every other scheme (file:, javascript:, data:, a custom protocol) is blocked.
 */
export function harnessNavigation(url: string, origin: string): HarnessNavigation {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'blocked';
  }
  if (parsed.origin === origin) return 'inside';
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? 'external' : 'blocked';
}

/**
 * Where a navigation of a web Harness's view goes, as `will-navigate` and `will-redirect` report
 * it. Only the main frame follows {@link harnessNavigation}: `will-redirect` also fires for the
 * page's iframes, whose loads are page content (sandboxed like the page itself), so a subframe's
 * redirect stays `inside`; it is neither cancelled nor opened in the User's browser.
 */
export function harnessFrameNavigation(
  navigation: { readonly url: string; readonly isMainFrame: boolean },
  origin: string,
): HarnessNavigation {
  return navigation.isMainFrame ? harnessNavigation(navigation.url, origin) : 'inside';
}

/** Links the renderer may hand to the OS browser (`shell.openExternal`): https only. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
