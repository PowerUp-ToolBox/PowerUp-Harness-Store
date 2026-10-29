import { useRef, useState } from 'react';
import type { IpcError, UnpublishedVersion } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useConnectivity } from '../connectivity/ConnectivityProvider.js';
import { useI18n } from '../i18n/I18nProvider.js';

export interface UnpublishDialogProps {
  readonly harnessId: string;
  /** The Harness's display name. */
  readonly name: string;
  readonly version: string;
  readonly onClose: () => void;
  readonly onUnpublished: (result: UnpublishedVersion) => void;
  /** The Store refused the Unpublish; the dialog stays open and shows why. */
  readonly onRefused?: (error: IpcError) => void;
}

/**
 * Confirms Unpublishing one Harness Version (docs/ux/flows.md, F5 "Unpublish"): it names the
 * Harness and the version, and says plainly that existing installs keep working while the version
 * can no longer be downloaded, since Unpublish is not a Takedown. Unpublish calls
 * `publish.unpublish` once (the button is off while it runs, and offline); the Store treats a version already
 * Unpublished as a success, so a stale list shows no error either.
 */
export function UnpublishDialog({
  harnessId,
  name,
  version,
  onClose,
  onUnpublished,
  onRefused,
}: UnpublishDialogProps) {
  const { t } = useI18n();
  const offline = useConnectivity().state === 'offline';
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  /** Set at once, so a second click before the next render sends nothing more. */
  const sending = useRef(false);

  const unpublish = async () => {
    if (sending.current) return;
    sending.current = true;
    setWorking(true);
    setError(null);
    const result = await window.api.publish.unpublish({ harnessId, version });
    sending.current = false;
    setWorking(false);
    if (result.ok) onUnpublished(result.data);
    else {
      setError(result.error);
      onRefused?.(result.error);
    }
  };

  return (
    <Modal title={t('publish.unpublish.title', { name, version })} onClose={onClose} busy={working}>
      <p>{t('publish.unpublish.body')}</p>
      {offline ? (
        <p className="hint" role="note">
          {t('publish.mine.offline')}
        </p>
      ) : null}
      {error === null ? null : <ErrorMessage error={error} />}
      <div className="modal-actions">
        <button type="button" className="button-secondary" disabled={working} onClick={onClose}>
          {t('publish.unpublish.cancel')}
        </button>
        <button
          type="button"
          className="button-danger"
          disabled={working || offline}
          aria-busy={working}
          onClick={() => void unpublish()}
        >
          {working ? <span className="spinner" aria-hidden="true" /> : null}
          {working ? t('publish.unpublish.working') : t('publish.unpublish')}
        </button>
      </div>
    </Modal>
  );
}
