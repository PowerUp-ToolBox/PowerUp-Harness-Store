import type { IpcRequest, IpcResult } from '../../shared/ipc.js';
import { fail } from './ipc-result.js';

/** One handler per method: the main window's (./handlers.ts) or a Harness window's. */
export type HandlerTable = Readonly<Record<string, (input: unknown) => unknown>>;

export interface DispatcherOptions {
  readonly handlers: HandlerTable;
  /**
   * True only for the window the handlers serve (the main window's webContents); every other
   * sender is refused.
   */
  readonly isTrustedSender: (sender: unknown) => boolean;
  /** Called with the error a handler threw before it is turned into `internal_error`. */
  readonly onHandlerError?: (method: string, error: unknown) => void;
}

/** Thrown (so the caller's `invoke` rejects) when the request comes from an untrusted sender. */
export class UntrustedSenderError extends Error {
  constructor() {
    super('IPC request from a sender other than the window these handlers serve was refused.');
    this.name = 'UntrustedSenderError';
  }
}

export type Dispatch = (sender: unknown, request: unknown) => Promise<IpcResult<unknown>>;

/**
 * Routes one `{ method, input }` request to its handler. For the trusted sender the returned promise
 * never rejects: a malformed request or an unknown method is `invalid_input`, and a handler that
 * throws becomes `internal_error`.
 */
export function createDispatcher(options: DispatcherOptions): Dispatch {
  const { handlers, isTrustedSender, onHandlerError } = options;
  return async (sender, request) => {
    if (!isTrustedSender(sender)) throw new UntrustedSenderError();
    if (!isRequest(request)) {
      return fail('invalid_input');
    }
    const { method, input } = request;
    if (!Object.hasOwn(handlers, method)) {
      return fail('invalid_input', { method });
    }
    const handler = handlers[method] as (input: unknown) => unknown;
    try {
      return (await handler(input)) as IpcResult<unknown>;
    } catch (error) {
      onHandlerError?.(method, error);
      return fail('internal_error', { method });
    }
  };
}

function isRequest(value: unknown): value is IpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { method?: unknown }).method === 'string'
  );
}
