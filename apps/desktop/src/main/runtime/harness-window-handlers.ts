import type {
  HarnessWindowMethodName,
  HarnessWindowMethods,
  TerminalSize,
  WebContentArea,
} from '../../shared/harness-ipc.js';
import type { IpcResult } from '../../shared/ipc.js';
import type { BindingsService } from './bindings.js';
import { fail, ok } from './ipc-result.js';
import type { Supervisor } from './supervisor.js';

/** One handler per Harness window method, for one launch's window. */
export type HarnessWindowHandlers = {
  readonly [M in HarnessWindowMethodName]: (
    input: unknown,
  ) =>
    | IpcResult<HarnessWindowMethods[M]['output']>
    | Promise<IpcResult<HarnessWindowMethods[M]['output']>>;
};

export interface HarnessWindowHandlerOptions {
  readonly supervisor: Supervisor;
  readonly bindings: Pick<BindingsService, 'resolveAll'>;
  /** The system clipboard (Electron's `clipboard`): a sandboxed page has none of its own. */
  readonly clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  /** Shows the Models page at this Harness's card in the main window, opening it when closed. */
  readonly openModels: (harnessId: string) => void;
}

/** The longest text one `terminal.input` or `terminal.copy` call carries. */
const MAX_TEXT = 1024 * 1024;

/**
 * The handlers of the window of `launchId`: main finds that launch from the window that sent the
 * request (src/main/harness-windows.ts), so a call can only act on its own launch. Inputs are
 * checked as the main window's are. A launch the Supervisor no longer knows answers
 * `invalid_input`; it cannot normally happen, as a newer launch closes the older one's window.
 */
export function createHarnessWindowHandlers(
  launchId: string,
  options: HarnessWindowHandlerOptions,
): HarnessWindowHandlers {
  const { supervisor } = options;
  const unknownLaunch = (method: HarnessWindowMethodName) => fail('invalid_input', { method });
  const withWindow = <T>(
    method: HarnessWindowMethodName,
    input: unknown,
    valid: (input: unknown) => boolean,
    act: (window: NonNullable<ReturnType<Supervisor['window']>>) => T,
  ): T | ReturnType<typeof unknownLaunch> => {
    if (!valid(input)) return fail('invalid_input', { method });
    const window = supervisor.window(launchId);
    return window === null ? unknownLaunch(method) : act(window);
  };
  const none = (input: unknown) => input === undefined;
  return {
    'window.info': (input) =>
      withWindow('window.info', input, none, async (window) => ok(await window.info())),
    'window.slots': (input) =>
      withWindow('window.slots', input, none, (window) =>
        options.bindings.resolveAll(window.harnessId),
      ),
    'window.openModels': (input) =>
      withWindow('window.openModels', input, none, (window) => {
        options.openModels(window.harnessId);
        return ok(null);
      }),
    'window.openLogs': (input) =>
      withWindow('window.openLogs', input, none, async (window) => {
        await window.openLogs();
        return ok(null);
      }),
    'window.relaunch': (input) =>
      withWindow('window.relaunch', input, none, (window) => {
        const result = window.relaunch();
        return result.ok ? ok(null) : result;
      }),
    'window.close': (input) =>
      withWindow('window.close', input, none, (window) => {
        window.close();
        return ok(null);
      }),
    'web.reload': (input) =>
      withWindow('web.reload', input, none, (window) => {
        window.reload();
        return ok(null);
      }),
    'web.layout': (input) =>
      withWindow('web.layout', input, isContentArea, (window) => {
        window.webLayout(input as WebContentArea);
        return ok(null);
      }),
    'terminal.ready': (input) =>
      withWindow('terminal.ready', input, isTerminalSize, (window) => {
        window.terminalReady(input as TerminalSize);
        return ok(null);
      }),
    'terminal.input': (input) =>
      withWindow('terminal.input', input, isText, (window) => {
        window.terminalInput(input as string);
        return ok(null);
      }),
    'terminal.resize': (input) =>
      withWindow('terminal.resize', input, isTerminalSize, (window) => {
        window.terminalResize(input as TerminalSize);
        return ok(null);
      }),
    'terminal.copy': (input) =>
      withWindow('terminal.copy', input, isText, async () => {
        await options.clipboard.writeText(input as string);
        return ok(null);
      }),
    'terminal.paste': (input) =>
      withWindow('terminal.paste', input, none, async () => ok(await options.clipboard.readText())),
  };
}

function isText(input: unknown): boolean {
  return typeof input === 'string' && input.length <= MAX_TEXT;
}

/** A rectangle of the window's page: finite, not negative, at most 100000 CSS pixels each way. */
function isContentArea(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const { x, y, width, height } = input as Record<string, unknown>;
  return (
    Object.keys(input).length === 4 &&
    [x, y, width, height].every(
      (value) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000,
    )
  );
}

/** A pty size: whole numbers of cells, 1 to 1000 each way. */
function isTerminalSize(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const { cols, rows } = input as Record<string, unknown>;
  return (
    Object.keys(input).length === 2 &&
    [cols, rows].every(
      (value) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000,
    )
  );
}
