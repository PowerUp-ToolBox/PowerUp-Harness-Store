/**
 * The IPC contract between a Harness window's own page (`src/renderer/harness.html`: the top bar
 * and, for a terminal UI Kind, the embedded terminal) and the Runtime. It is separate from the
 * main window's contract (./ipc.ts): its own channels, its own preload exposing only
 * `window.harness`, and every call is scoped to the launch whose window sends it. Main finds that
 * launch from the sender, never from the input, so a Harness window can only ever act on itself.
 * Like ./ipc.ts it is types plus constants, so every process can bundle it.
 */

import type { Locale } from './i18n/locale.js';
import type { BridgeCalls, LaunchStatus, ResolvedSlot } from './ipc.js';

/** Every call a Harness window may make, about its own launch. */
export interface HarnessWindowMethods {
  /** What the window shows: the Harness, the app's language and the launch's state. */
  'window.info': { input: undefined; output: HarnessWindowInfo };
  /**
   * The model each Model Slot of the Harness resolves to now (`bindings.resolveAll`), for the
   * model indicator; read again whenever the window gains focus.
   */
  'window.slots': { input: undefined; output: readonly ResolvedSlot[] };
  /** Opens the Models page at this Harness's card in the main window, opening it if closed. */
  'window.openModels': { input: undefined; output: null };
  /** Opens this launch's log file with the OS (its Harness's logs folder before it has one). */
  'window.openLogs': { input: undefined; output: null };
  /**
   * Launches the Harness again after this launch ended: this window closes and the new launch
   * opens its own. Fails as `launch.start` does.
   */
  'window.relaunch': { input: undefined; output: null };
  /**
   * Closes this window; while the Harness runs, that stops it. The Starting state's Cancel is
   * this call too.
   */
  'window.close': { input: undefined; output: null };
  /**
   * Reloads a ready web Harness's page in place; its process keeps running. Does nothing before
   * the page is shown or after the launch ended.
   */
  'web.reload': { input: undefined; output: null };
  /**
   * Where the Harness's page goes in this window: the rectangle under the top bar, in the page's
   * CSS pixels, sent again whenever it changes. Web UI Kind only.
   */
  'web.layout': { input: WebContentArea; output: null };
  /**
   * The terminal is on screen with this size: the Runtime starts the Harness's process in a pty
   * of that size now, so none of its output is lost. Later calls only resize.
   */
  'terminal.ready': { input: TerminalSize; output: null };
  /** What the User typed, for the pty. */
  'terminal.input': { input: string; output: null };
  /** The terminal's new size, for the pty. */
  'terminal.resize': { input: TerminalSize; output: null };
  /** Puts the terminal's selection on the clipboard (Ctrl+Shift+C on Windows and Linux). */
  'terminal.copy': { input: string; output: null };
  /** The clipboard's text, to paste into the terminal (Ctrl+Shift+V on Windows and Linux). */
  'terminal.paste': { input: undefined; output: string };
}

/** What a Harness window shows about its launch. */
export interface HarnessWindowInfo {
  readonly harnessId: string;
  /** The Manifest's display name. */
  readonly name: string;
  readonly uiKind: 'web' | 'terminal';
  /**
   * How many seconds a web Harness has to accept connections (`ui.readyTimeoutSeconds`, default
   * 30); null for a terminal one.
   */
  readonly readyTimeoutSeconds: number | null;
  /** The Harness's `assets/icon.png` as a `data:` URL; null when it cannot be read. */
  readonly iconDataUrl: string | null;
  /** The app's UI language now; the window's own text follows it. */
  readonly locale: Locale;
  readonly status: LaunchStatus;
}

/** A rectangle of a Harness window's page, in CSS pixels. */
export interface WebContentArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A terminal's size in character cells. */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** Events main pushes to one Harness window: name → payload. */
export interface HarnessWindowEvents {
  /** Output of the Harness's pty, as it came. */
  'terminal.data': string;
  /** Its launch changed state (the process exited, for example). */
  'window.state': LaunchStatus;
  /**
   * The window gained focus. A web Harness's page has the focus then, not the window's own page,
   * which therefore cannot see it by itself.
   */
  'window.focus': null;
}

export type HarnessWindowMethodName = keyof HarnessWindowMethods;
export type HarnessWindowEventName = keyof HarnessWindowEvents;

const HARNESS_METHOD_NAMES: Readonly<Record<HarnessWindowMethodName, true>> = {
  'window.info': true,
  'window.slots': true,
  'window.openModels': true,
  'window.openLogs': true,
  'window.relaunch': true,
  'window.close': true,
  'web.reload': true,
  'web.layout': true,
  'terminal.ready': true,
  'terminal.input': true,
  'terminal.resize': true,
  'terminal.copy': true,
  'terminal.paste': true,
};

/** The method names at runtime; the Harness window's preload builds `window.harness` from them. */
export const HARNESS_WINDOW_METHODS = Object.freeze(
  Object.keys(HARNESS_METHOD_NAMES) as HarnessWindowMethodName[],
);

export function isHarnessWindowEventName(name: string): name is HarnessWindowEventName {
  return name === 'terminal.data' || name === 'window.state' || name === 'window.focus';
}

/** The channel a Harness window's page invokes every method on. */
export const HARNESS_INVOKE_CHANNEL = 'harness-store:harness-invoke';
/** The channel main pushes a Harness window's events on. */
export const HARNESS_EVENT_CHANNEL = 'harness-store:harness-event';

/** Subscribes to one event; returns the function that unsubscribes. */
export type HarnessWindowSubscribe = <E extends HarnessWindowEventName>(
  event: E,
  listener: (payload: HarnessWindowEvents[E]) => void,
) => () => void;

/** The only object a Harness window's page sees: `window.harness.<domain>.<verb>()` plus `on`. */
export type HarnessWindowApi = BridgeCalls<HarnessWindowMethods> & {
  readonly on: HarnessWindowSubscribe;
};
