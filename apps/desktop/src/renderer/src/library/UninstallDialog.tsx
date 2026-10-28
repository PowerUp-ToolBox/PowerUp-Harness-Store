import { useEffect, useRef, useState } from 'react';
import type { InstalledHarness, IpcError } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useToast } from '../components/Toasts.js';
import { useI18n } from '../i18n/I18nProvider.js';

export interface UninstallDialogProps {
  readonly install: InstalledHarness;
  /** Whether the Harness runs now (its launch has a process, or is about to). */
  readonly running: boolean;
  /** Cancel, Close, Escape, and the Harness uninstalled. */
  readonly onClose: () => void;
}

/** The Data Directory's size: `loading` until `installs.dataSize` answers. */
type DataSize =
  { readonly status: 'loading' } | { readonly status: 'known'; readonly bytes: number };

/**
 * Confirms uninstalling a Harness (docs/ux/flows.md F9), from the Library card's menu and the
 * detail page's Uninstall: "Uninstall <name>?", what it deletes ("This deletes its data directory
 * (<size>). Files in your own folders are not touched."), and Cancel / Uninstall. The Data
 * Directory's size is read only now, when the dialog opens (`installs.dataSize`), never for every
 * card. Uninstall calls `installs.uninstall` once; once it is done the toast "Uninstalled <name>"
 * shows and the dialog closes, as the Harness leaves the Library (`installs.changed`). There is no
 * Undo: the deletion is immediate, which is why it is confirmed.
 *
 * While the Harness runs, or when the uninstall was refused because it started meanwhile, the
 * dialog says "Close the Harness first" with only Close, and nothing is deleted. Any other refusal
 * (an install or update of it under way) shows under the text, and the dialog stays open.
 */
export function UninstallDialog({ install, running, onClose }: UninstallDialogProps) {
  const { t, formatBytes } = useI18n();
  const toast = useToast();
  const { harnessId, name } = install;
  /** Null when the size could not be read: the text then says it without one. */
  const [size, setSize] = useState<DataSize | null>({ status: 'loading' });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  const [refusedRunning, setRefusedRunning] = useState(false);
  /** Set at once, so a second click before the next render sends nothing more. */
  const sending = useRef(false);
  const blocked = running || refusedRunning;

  useEffect(() => {
    if (blocked) return undefined;
    let current = true;
    setSize({ status: 'loading' });
    window.api.installs.dataSize(harnessId).then(
      (result) => {
        if (current) setSize(result.ok ? { status: 'known', bytes: result.data } : null);
      },
      () => {
        if (current) setSize(null);
      },
    );
    return () => {
      current = false;
    };
  }, [blocked, harnessId]);

  const uninstall = async () => {
    if (sending.current) return;
    sending.current = true;
    setWorking(true);
    setError(null);
    const result = await window.api.installs.uninstall(harnessId);
    sending.current = false;
    setWorking(false);
    if (result.ok) {
      toast(t('toast.uninstalled', { name }));
      onClose();
    } else if (result.error.code === 'harness_running') {
      setRefusedRunning(true);
    } else {
      setError(result.error);
    }
  };

  const title = t('uninstall.title', { name });
  if (blocked) {
    return (
      <Modal title={title} onClose={onClose}>
        <p>{t('uninstall.closeFirst')}</p>
        <div className="modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('uninstall.close')}
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={title} onClose={onClose} busy={working}>
      {size?.status === 'loading' ? (
        <p className="hint" role="status">
          {t('uninstall.sizing')}
        </p>
      ) : (
        <p>
          {size === null
            ? t('uninstall.bodyNoSize')
            : t('uninstall.body', { size: formatBytes(size.bytes) })}
        </p>
      )}
      {error === null ? null : <ErrorMessage error={error} />}
      <div className="modal-actions">
        <button type="button" className="button-secondary" disabled={working} onClick={onClose}>
          {t('uninstall.cancel')}
        </button>
        <button
          type="button"
          className="button-danger"
          disabled={working || size?.status === 'loading'}
          aria-busy={working}
          onClick={() => void uninstall()}
        >
          {working ? <span className="spinner" aria-hidden="true" /> : null}
          {working ? t('uninstall.working') : t('uninstall.confirm')}
        </button>
      </div>
    </Modal>
  );
}
