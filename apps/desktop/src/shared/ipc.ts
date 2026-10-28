/**
 * The IPC contract between the renderer and the Runtime (main process), defined once and used by
 * the main handlers, the preload bridge and the renderer. It is types plus two constant lists; it
 * imports nothing, so every process can bundle it.
 *
 * Transport: one `ipcMain.handle` channel carries `{ method, input }` and always resolves to an
 * {@link IpcResult}; one event channel carries `{ event, payload }` from main to the renderer.
 */

/** Error codes the Runtime returns over IPC. Later tickets add the Gateway and service codes. */
export type IpcErrorCode = 'internal_error' | 'invalid_input' | 'not_implemented';

export interface IpcError {
  readonly code: IpcErrorCode;
  /** The catalog key the renderer looks up, always `error.<code>`. */
  readonly messageKey: `error.${IpcErrorCode}`;
  readonly params?: Readonly<Record<string, string | number>>;
  /** English text, the last fallback when the catalog cannot render `messageKey`. */
  readonly message: string;
}

export type IpcResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: IpcError };

/**
 * Every request/response method: name (`<domain>.<verb>`) → input and output types. `input:
 * undefined` means the renderer calls it with no argument. Each handler checks its own input at
 * runtime.
 */
export interface IpcMethods {
  'app.ping': { input: undefined; output: { version: string } };
}

export type IpcMethodName = keyof IpcMethods;
export type IpcInput<M extends IpcMethodName> = IpcMethods[M]['input'];
export type IpcOutput<M extends IpcMethodName> = IpcMethods[M]['output'];

// A record keyed by every method name fails to compile when a method is added to IpcMethods but
// not here, or listed here but not in IpcMethods.
const METHOD_NAMES: Readonly<Record<IpcMethodName, true>> = { 'app.ping': true };

/** The method names at runtime; the preload builds `window.api` from this list. */
export const IPC_METHODS = Object.freeze(Object.keys(METHOD_NAMES) as IpcMethodName[]);

/**
 * Events main pushes to the renderer: name → payload. `progress:<jobId>` is reserved for
 * long-running jobs (downloads, uploads, launch readiness); its payload is defined by its first
 * producer.
 */
export type IpcEvents = Record<`progress:${string}`, unknown>;

export type IpcEventName = keyof IpcEvents;

export interface IpcRequest {
  readonly method: string;
  readonly input?: unknown;
}

export interface IpcEventMessage {
  readonly event: string;
  readonly payload: unknown;
}

/** The single channel `ipcRenderer.invoke` uses for every method. */
export const IPC_INVOKE_CHANNEL = 'harness-store:invoke';
/** The single channel main uses to push every event. */
export const IPC_EVENT_CHANNEL = 'harness-store:event';

export function isIpcEventName(name: string): name is IpcEventName {
  return /^progress:.+$/.test(name);
}

type Domain<M extends string> = M extends `${infer D}.${string}` ? D : never;
type Verb<M extends string, D extends string> = M extends `${D}.${infer V}` ? V : never;

type MethodFunction<M extends IpcMethodName> = [IpcInput<M>] extends [undefined]
  ? () => Promise<IpcResult<IpcOutput<M>>>
  : (input: IpcInput<M>) => Promise<IpcResult<IpcOutput<M>>>;

/** Subscribes to one event; returns the function that unsubscribes. */
export type IpcSubscribe = <E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEvents[E]) => void,
) => () => void;

/** The only object the renderer sees: `window.api.<domain>.<verb>(input)` plus `on`. */
export type DesktopApi = {
  readonly [D in Domain<IpcMethodName>]: {
    readonly [V in Verb<IpcMethodName, D>]: MethodFunction<Extract<`${D}.${V}`, IpcMethodName>>;
  };
} & { readonly on: IpcSubscribe };
