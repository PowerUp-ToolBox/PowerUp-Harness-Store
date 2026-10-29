import { useState } from 'react';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/I18nProvider.js';

/**
 * The red warning of an installed Harness the update check found taken down (P0-12.2), on its
 * Library card and its detail page: "A Store administrator took this Harness down. It may be
 * harmful: launch it only if you trust it." It replaces the neutral "No longer available in the
 * Store", which an Unpublished one keeps.
 */
export function TakedownWarning() {
  const { t } = useI18n();
  return <p className="takedown-warning">{t('takedown.warning')}</p>;
}

/**
 * The confirmation Launch asks for a taken-down Harness, once per Takedown (P0-12.2): "This
 * Harness was removed from the Store. Launch anyway?", the warning, Cancel and "Launch anyway".
 * Cancel and Escape launch nothing and record nothing; `onConfirm` records the acknowledgement and
 * launches, the dialog waiting for it.
 */
export function TakedownConfirm({
  onConfirm,
  onClose,
}: {
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [working, setWorking] = useState(false);
  return (
    <Modal title={t('takedown.confirm')} onClose={onClose} busy={working}>
      <p>{t('takedown.warning')}</p>
      <div className="modal-actions">
        <button type="button" className="button-secondary" disabled={working} onClick={onClose}>
          {t('takedown.cancel')}
        </button>
        <button
          type="button"
          className="button-danger"
          disabled={working}
          onClick={() => {
            setWorking(true);
            void onConfirm();
          }}
        >
          {t('takedown.launchAnyway')}
        </button>
      </div>
    </Modal>
  );
}
