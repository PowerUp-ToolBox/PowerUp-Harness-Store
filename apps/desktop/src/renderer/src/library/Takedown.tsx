import { useState } from 'react';
import type { InstalledHarness } from '../../../shared/ipc.js';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/I18nProvider.js';

/**
 * What the update check found taken down of an install: the whole Harness (`storeStatus`
 * `taken_down`), only its installed version (P0-12.2 follow-up), or nothing (null). A whole-Harness
 * Takedown wins when both are.
 */
export type TakedownKind = 'harness' | 'version';

/** What the takedown warning and confirmation read of an install. */
type TakedownInstall = Pick<
  InstalledHarness,
  'storeStatus' | 'installedVersionTakenDown' | 'version'
>;

/** What of the install was taken down, if anything ({@link TakedownKind}). */
export function takedownOf(install: TakedownInstall): TakedownKind | null {
  if (install.storeStatus === 'taken_down') return 'harness';
  return install.installedVersionTakenDown ? 'version' : null;
}

/** The warning and the confirmation's question for a taken-down install, in the UI language. */
function useTakedownText(install: TakedownInstall): { warning: string; confirm: string } {
  const { t } = useI18n();
  return takedownOf(install) === 'version'
    ? {
        warning: t('takedown.versionWarning', { version: install.version }),
        confirm: t('takedown.versionConfirm', { version: install.version }),
      }
    : { warning: t('takedown.warning'), confirm: t('takedown.confirm') };
}

/**
 * The red warning of an installed Harness the update check found taken down (P0-12.2), on its
 * Library card and its detail page: "A Store administrator took this Harness down. It may be
 * harmful: launch it only if you trust it.", or "A Store administrator took down the installed
 * version, {version}. …" when only the installed version was. It replaces the neutral "No longer
 * available in the Store", which an Unpublished one keeps. Render it only for a taken-down install
 * ({@link takedownOf}).
 */
export function TakedownWarning({ install }: { readonly install: TakedownInstall }) {
  return <p className="takedown-warning">{useTakedownText(install).warning}</p>;
}

/**
 * The confirmation Launch asks for a taken-down Harness or installed version, once per Takedown
 * (P0-12.2): "This Harness was removed from the Store. Launch anyway?" (or "The installed version,
 * {version}, was removed …"), the warning, Cancel and "Launch anyway". Cancel and Escape launch
 * nothing and record nothing; `onConfirm` records the acknowledgement and launches, the dialog
 * waiting for it.
 */
export function TakedownConfirm({
  install,
  onConfirm,
  onClose,
}: {
  readonly install: TakedownInstall;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const text = useTakedownText(install);
  const [working, setWorking] = useState(false);
  return (
    <Modal title={text.confirm} onClose={onClose} busy={working}>
      <p>{text.warning}</p>
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
