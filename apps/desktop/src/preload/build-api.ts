import {
  IPC_METHODS,
  isIpcEventName,
  type DesktopApi,
  type IpcEventName,
  type IpcRequest,
  type IpcResult,
} from '../shared/ipc.js';

/** Sends one request over the invoke channel (`ipcRenderer.invoke` in the app). */
export type Invoke = (request: IpcRequest) => Promise<IpcResult<unknown>>;

/** Listens on the event channel for one event name; returns the unsubscribe function. */
export type Listen = (event: IpcEventName, listener: (payload: unknown) => void) => () => void;

type MethodCall = (input?: unknown) => Promise<IpcResult<unknown>>;

/**
 * Builds `window.api` from {@link IPC_METHODS}: `'app.ping'` becomes `api.app.ping(input)`. Kept
 * free of Electron so it is unit-tested under Node; src/preload/index.ts passes the real
 * `ipcRenderer` in. Every level is frozen, so a renderer bug cannot swap a method out.
 */
export function buildApi(invoke: Invoke, listen: Listen): DesktopApi {
  const domains: Record<string, Record<string, MethodCall>> = {};
  for (const method of IPC_METHODS) {
    const [domain, verb] = method.split('.') as [string, string];
    domains[domain] ??= {};
    domains[domain][verb] = (input?: unknown) => invoke({ method, input });
  }
  const on = (event: string, listener: (payload: unknown) => void): (() => void) => {
    if (!isIpcEventName(event)) throw new TypeError(`Unknown event: ${event}`);
    return listen(event, listener);
  };
  for (const verbs of Object.values(domains)) Object.freeze(verbs);
  return Object.freeze({ ...domains, on }) as unknown as DesktopApi;
}
