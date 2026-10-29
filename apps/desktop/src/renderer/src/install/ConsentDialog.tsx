import { useEffect, useState, type ReactNode } from 'react';
import type { IpcError, ManifestSummary } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { TrustBlock } from '../listing/TrustBlock.js';

/** How long Install stays disabled after the dialog opens, so the User reads it first. */
export const CONSENT_READ_DELAY_MS = 1000;

export interface ConsentDialogProps {
  readonly summary: ManifestSummary;
  /** While true the install runs: the buttons wait and the dialog cannot be dismissed. */
  readonly installing: boolean;
  /** Why the last Install failed, shown above the buttons. */
  readonly error: IpcError | null;
  readonly onInstall: () => void;
  readonly onCancel: () => void;
  /** What the caller adds above the buttons, such as a local folder's validation warnings. */
  readonly children?: ReactNode;
}

/**
 * The install consent dialog (docs/ux/screens.md, "Install consent dialog"), shared by both
 * entry points of the one install path: local installs ("Install this folder locally") and
 * Store installs (./InstallJobsProvider.tsx), the same component with the same facts. Its body is the trust block
 * (../listing/TrustBlock.tsx), the one the Store detail page and the Publish preview show: the
 * Declared Permissions, the facts row (runtime kind, UI Kind, Workspace, here with the
 * platforms), then the Harness ID, version and Entry, and the standing no-sandbox sentence.
 * Install is enabled one second after the dialog opens; Cancel and Escape close it.
 */
export function ConsentDialog({
  summary,
  installing,
  error,
  onInstall,
  onCancel,
  children,
}: ConsentDialogProps) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setArmed(true);
    }, CONSENT_READ_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  return (
    <Modal
      title={t('consent.title', { name: summary.name, version: summary.version })}
      onClose={onCancel}
      busy={installing}
    >
      <TrustBlock facts={summary} platforms={summary.platforms}>
        <p className="consent-id">
          {summary.harnessId} · {summary.version}
          {summary.entry === null ? null : ` · ${summary.entry}`}
        </p>
        {summary.platformSupported ? null : (
          <p className="consent-note">{t('consent.unsupported')}</p>
        )}
      </TrustBlock>
      {children}
      {error === null ? null : <ErrorMessage error={error} />}
      <div className="modal-actions">
        <button type="button" className="button-secondary" disabled={installing} onClick={onCancel}>
          {t('consent.cancel')}
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={!armed || installing}
          onClick={onInstall}
        >
          {t('consent.install')}
        </button>
      </div>
    </Modal>
  );
}
