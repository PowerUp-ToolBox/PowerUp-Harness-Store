import { useEffect, useId, useState } from 'react';
import type { ConnectionSummary, IpcError, IpcResult } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { connectionName } from './names.js';

export interface RemoveConnectionDialogProps {
  readonly connection: ConnectionSummary;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}

/** A Slot Binding that uses the Connection: a Default Model, or a Harness's Model Override. */
interface AffectedBinding {
  readonly slot: string;
  readonly model: string;
  /** The Harness's display name, for a Model Override; null for a Default Model. */
  readonly harness: string | null;
}

/**
 * Confirms removing a Connection, naming the Slot Bindings that use it (the Default Models from
 * `bindings.getGlobal`, then each installed Harness's Model Overrides from
 * `bindings.getForHarness`) and that its key is deleted. Remove waits until they are known; if
 * they cannot be read, the error is shown and Remove still works. It calls `connections.remove`,
 * which deletes the Connection, its secret and those Slot Bindings at once.
 */
export function RemoveConnectionDialog({
  connection,
  onClose,
  onRemoved,
}: RemoveConnectionDialogProps) {
  const { t } = useI18n();
  const ids = useId();
  /** The Slot Bindings that use the Connection; null until known (or when they could not be read). */
  const [affected, setAffected] = useState<readonly AffectedBinding[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);

  useEffect(() => {
    let current = true;
    void affectedBindings(connection.id).then((result) => {
      if (!current) return;
      setLoaded(true);
      if (result.ok) setAffected(result.data);
      else setError(result.error);
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
              <li key={`${binding.harness ?? ''}\n${binding.slot}`}>
                {binding.harness === null ? null : <span>{binding.harness}</span>}
                <code>{binding.slot}</code>
                <span className="binding-list-model">
                  {connection.id}/{binding.model}
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

/** The Default Models, then each installed Harness's Model Overrides, that use a Connection. */
async function affectedBindings(
  connectionId: string,
): Promise<IpcResult<readonly AffectedBinding[]>> {
  const uses = (binding: { connectionId: string }) => binding.connectionId === connectionId;
  const [global, installs] = await Promise.all([
    window.api.bindings.getGlobal(),
    window.api.installs.list(),
  ]);
  if (!global.ok) return global;
  if (!installs.ok) return installs;
  const found: AffectedBinding[] = global.data
    .filter(uses)
    .map((binding) => ({ ...binding, harness: null }));
  for (const install of installs.data) {
    const overrides = await window.api.bindings.getForHarness(install.harnessId);
    if (!overrides.ok) return overrides;
    found.push(...overrides.data.filter(uses).map((row) => ({ ...row, harness: install.name })));
  }
  return { ok: true, data: found };
}
