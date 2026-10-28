import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { IpcError, ManifestSummary } from '../../../shared/ipc.js';
import {
  harnessFacts,
  permissionItems,
  SEVERITY_LABEL,
  type PermissionSeverity,
} from '../../../shared/permissions.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { SeverityHighIcon, SeverityLowIcon, SeverityMediumIcon } from '../shell/icons.js';

/** How long Install stays disabled after the dialog opens, so the User reads it first. */
export const CONSENT_READ_DELAY_MS = 1000;

const SEVERITY_ICON: Readonly<Record<PermissionSeverity, ComponentType>> = {
  low: SeverityLowIcon,
  medium: SeverityMediumIcon,
  high: SeverityHighIcon,
};

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
 * The install consent dialog (docs/ux/screens.md, "Install consent dialog"), minimal and shared:
 * local installs use it now, Store installs reuse it in P0-10. It lists the Declared Permissions
 * on the low/medium/high scale, each with an icon, a label and a plain sentence (colour is never
 * the only signal), then the facts row (runtime kind, UI Kind, Workspace, platforms), the Harness
 * ID, version and Entry, and the standing no-sandbox sentence. Install is enabled one second after
 * the dialog opens; Cancel and Escape close it.
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
      <ul className="permission-list" aria-label={t('consent.permissions')}>
        {permissionItems(summary.permissions).map((item) => {
          const SeverityIcon = SEVERITY_ICON[item.severity];
          return (
            <li key={item.messageKey} className="permission-item" data-severity={item.severity}>
              <SeverityIcon />
              <span className="permission-text">
                <span className="permission-label">
                  {t(SEVERITY_LABEL[item.severity])} · {t(item.messageKey, item.params)}
                </span>
                {item.consequenceKey === undefined ? null : (
                  <span className="permission-consequence">{t(item.consequenceKey)}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="hint">{t('consent.informational')}</p>
      <ul className="fact-chips" aria-label={t('consent.facts')}>
        {harnessFacts(summary).map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
        {summary.platforms.map((platform) => (
          <li key={platform}>{platform}</li>
        ))}
      </ul>
      <p className="consent-id">
        {summary.harnessId} · {summary.version}
        {summary.entry === null ? null : ` · ${summary.entry}`}
      </p>
      {summary.platformSupported ? null : (
        <p className="consent-note">{t('consent.unsupported')}</p>
      )}
      <p className="no-sandbox">{t('consent.noSandbox')}</p>
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
