import type { IpcError } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';

/**
 * An inline error from the Runtime, in the UI language: looked up by its `messageKey`, with the
 * English `message` as the last fallback.
 */
export function ErrorMessage({ error }: { readonly error: IpcError }) {
  const { errorText } = useI18n();
  return (
    <p className="error-message" role="alert">
      {errorText(error)}
    </p>
  );
}
