import { useRef, useState } from 'react';
import type { IpcError } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useToast } from '../components/Toasts.js';
import { useI18n } from '../i18n/I18nProvider.js';

export interface ClearUsageDialogProps {
  /** Cancel, Escape, and the data cleared. */
  readonly onClose: () => void;
  /** The Usage Records are gone; called before `onClose`. */
  readonly onCleared: () => void;
}

/**
 * Confirms clearing usage data (docs/ux/flows.md F7): "Clear usage data?", "This deletes every
 * Usage Record on this machine.", Cancel / Clear usage data. Confirming calls `usage.clear` once;
 * once it is done the toast "Usage data cleared" shows and the dialog closes. There is no partial
 * clear and no Undo. The Usage page opens it, and Settings does too.
 */
export function ClearUsageDialog({ onClose, onCleared }: ClearUsageDialogProps) {
  const { t } = useI18n();
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  /** Set at once, so a second click before the next render sends nothing more. */
  const sending = useRef(false);

  const clear = async () => {
    if (sending.current) return;
    sending.current = true;
    setWorking(true);
    setError(null);
    const result = await window.api.usage.clear();
    sending.current = false;
    setWorking(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast(t('usage.cleared'));
    onCleared();
    onClose();
  };

  return (
    <Modal title={t('usage.clear.title')} onClose={onClose} busy={working}>
      <p>{t('usage.clear.body')}</p>
      {error === null ? null : <ErrorMessage error={error} />}
      <div className="modal-actions">
        <button type="button" className="button-secondary" disabled={working} onClick={onClose}>
          {t('usage.clear.cancel')}
        </button>
        <button
          type="button"
          className="button-danger"
          disabled={working}
          aria-busy={working}
          onClick={() => void clear()}
        >
          {working ? <span className="spinner" aria-hidden="true" /> : null}
          {working ? t('usage.clear.working') : t('usage.clear.confirm')}
        </button>
      </div>
    </Modal>
  );
}
