import { useEffect, useId, useState } from 'react';
import type { ConnectionSummary, GlobalBinding, IpcError } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { connectionName } from './names.js';

export interface RemoveConnectionDialogProps {
  readonly connection: ConnectionSummary;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}

/**
 * Confirms removing a Connection, naming the Slot Bindings that use it (from
 * `bindings.getGlobal`) and that its key is deleted. Remove waits until they are known; if they
 * cannot be read, the error is shown and Remove still works. It calls `connections.remove`, which
 * deletes the Connection, its secret and those Slot Bindings at once.
 */
export function RemoveConnectionDialog({
  connection,
  onClose,
  onRemoved,
}: RemoveConnectionDialogProps) {
  const { t } = useI18n();
  const ids = useId();
  /** The Slot Bindings that use the Connection; null until known (or when they could not be read). */
  const [affected, setAffected] = useState<readonly GlobalBinding[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);

  useEffect(() => {
    let current = true;
    void window.api.bindings.getGlobal().then((result) => {
      if (!current) return;
      setLoaded(true);
      if (result.ok) {
        setAffected(result.data.filter((binding) => binding.connectionId === connection.id));
      } else {
        setError(result.error);
      }
    });
    return () => {
      current = false;
    };
  }, [connection.id]);

  const remove = async () => {
    setRemoving(true);
    setError(null);
    const result = await window.api.connections.remove(connection.id);
    setRemoving(false);
    if (result.ok) onRemoved();
    else setError(result.error);
  };

  return (
    <Modal
      title={t('models.remove.title', { name: connectionName(t, connection) })}
      onClose={onClose}
      busy={removing}
    >
      {affected === null ? null : affected.length === 0 ? (
        <p>{t('models.remove.none')}</p>
      ) : (
        <>
          <p id={`${ids}-affected`}>{t('models.remove.body')}</p>
          <ul className="binding-list" aria-labelledby={`${ids}-affected`}>
            {affected.map((binding) => (
              <li key={binding.slot}>
                <code>{binding.slot}</code>
                <span className="binding-list-model">
                  {binding.connectionId}/{binding.model}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {connection.keyHint === null ? null : <p className="hint">{t('models.remove.secret')}</p>}
      {error === null ? null : <ErrorMessage error={error} />}
      <div className="modal-actions">
        <button type="button" className="button-secondary" disabled={removing} onClick={onClose}>
          {t('models.dialog.cancel')}
        </button>
        <button
          type="button"
          className="button-danger"
          disabled={removing || !loaded}
          aria-busy={removing}
          onClick={() => void remove()}
        >
          {removing ? <span className="spinner" aria-hidden="true" /> : null}
          {removing ? t('models.remove.removing') : t('models.remove.confirm')}
        </button>
      </div>
    </Modal>
  );
}
