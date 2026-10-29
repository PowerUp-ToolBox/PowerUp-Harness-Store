import { useEffect, useState } from 'react';
import type { InstalledHarness, IpcError, LastWorkspace } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/I18nProvider.js';

export interface WorkspaceSheetProps {
  /** An installed Harness whose Manifest asks for a Workspace (`required` or `optional`). */
  readonly install: InstalledHarness;
  /**
   * Launches the Harness with this Workspace (null: without one); resolves the error to show in
   * the sheet, or null once the launch began or the card took over (the sheet then closes).
   */
  readonly onLaunch: (workspace: string | null) => Promise<IpcError | null>;
  /** Closes the sheet without launching. */
  readonly onClose: () => void;
}

/**
 * The Workspace sheet (docs/ux/screens.md, Workspace picker): shown before launching a Harness
 * whose Manifest asks for a Workspace. The Harness's last Workspace is preselected while that
 * folder exists ("The last folder no longer exists" otherwise); Choose folder opens the native
 * folder dialog in main (`launch.chooseWorkspace`), Continue launches with the folder, and an
 * `optional` Harness also gets "Continue without a folder". Cancel launches nothing.
 */
export function WorkspaceSheet({ install, onLaunch, onClose }: WorkspaceSheetProps) {
  const { t } = useI18n();
  const { harnessId } = install;
  /** Undefined until `launch.lastWorkspace` answered. */
  const [last, setLast] = useState<LastWorkspace | null | undefined>(undefined);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);

  useEffect(() => {
    let current = true;
    void window.api.launch.lastWorkspace(harnessId).then((result) => {
      if (!current) return;
      const found = result.ok ? result.data : null;
      setLast(found);
      if (found?.exists === true) setChosen((previous) => previous ?? found.path);
    });
    return () => {
      current = false;
    };
  }, [harnessId]);

  const choose = async () => {
    setBusy(true);
    setError(null);
    const result = await window.api.launch.chooseWorkspace(harnessId);
    setBusy(false);
    if (!result.ok) setError(result.error);
    else if (result.data !== null) setChosen(result.data);
  };
  const launch = async (workspace: string | null) => {
    setBusy(true);
    setError(null);
    const failure = await onLaunch(workspace);
    if (failure === null) {
      onClose();
      return;
    }
    setBusy(false);
    setError(failure);
  };

  const lastMissing = last !== undefined && last !== null && !last.exists && chosen === null;
  return (
    <Modal title={t('workspace.title', { name: install.name })} onClose={onClose} busy={busy}>
      <div className="workspace-folder">
        <div className="workspace-folder-text">
          {chosen === null ? (
            <span className="hint">{t('workspace.noFolder')}</span>
          ) : (
            <>
              <code className="workspace-folder-path">{chosen}</code>
              {chosen === last?.path ? (
                <span className="workspace-folder-tag">{t('workspace.lastFolder')}</span>
              ) : null}
            </>
          )}
        </div>
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => void choose()}
        >
          {t('workspace.choose')}
        </button>
      </div>
      {lastMissing ? <p className="consent-note">{t('workspace.lastMissing')}</p> : null}
      <p className="workspace-access">{t('workspace.access')}</p>
      {error === null ? null : <ErrorMessage error={error} />}
      <div className="modal-actions">
        <button type="button" className="button-secondary" disabled={busy} onClick={onClose}>
          {t('workspace.cancel')}
        </button>
        {install.manifest.workspace === 'optional' ? (
          <button
            type="button"
            className="button-secondary"
            disabled={busy}
            onClick={() => void launch(null)}
          >
            {t('workspace.skip')}
          </button>
        ) : null}
        <button
          type="button"
          className="button-primary"
          disabled={busy || chosen === null}
          onClick={() => void launch(chosen)}
        >
          {t('workspace.continue')}
        </button>
      </div>
    </Modal>
  );
}
