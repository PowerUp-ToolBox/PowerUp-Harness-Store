import type { IpcError, IpcErrorCode, IpcResult } from '../../shared/ipc.js';

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

/** A failed result; `messageKey` is always the catalog key `error.<code>`. */
export function fail(
  code: IpcErrorCode,
  message: string,
  params?: IpcError['params'],
): { readonly ok: false; readonly error: IpcError } {
  const error: IpcError = { code, messageKey: `error.${code}`, message };
  return { ok: false, error: params === undefined ? error : { ...error, params } };
}
