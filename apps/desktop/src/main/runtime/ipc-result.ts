import { translatorFor } from '../../shared/i18n/translate.js';
import type { IpcError, IpcErrorCode, IpcResult } from '../../shared/ipc.js';

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

/**
 * A failed result. `messageKey` is always the catalog key `error.<code>`, and the English
 * `message` is that key rendered from the en catalog with `params`, so the fallback text the
 * renderer may show is the same copy the catalog holds.
 */
export function fail(
  code: IpcErrorCode,
  params?: IpcError['params'],
): { readonly ok: false; readonly error: IpcError } {
  const messageKey = `error.${code}` as const;
  const message = translatorFor('en').t(messageKey, params);
  const error: IpcError = { code, messageKey, message };
  return { ok: false, error: params === undefined ? error : { ...error, params } };
}
