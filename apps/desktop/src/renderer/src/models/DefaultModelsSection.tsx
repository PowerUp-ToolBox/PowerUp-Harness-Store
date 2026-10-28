import { useEffect, useId, useState } from 'react';
import type {
  BindingTarget,
  ConnectionSummary,
  GlobalBinding,
  InstalledHarness,
  IpcError,
  ModelInfo,
} from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { useMounted } from '../onboarding/use-mounted.js';
import { ModelPicker } from './ModelPicker.js';
import { connectionName } from './names.js';
import { RequirementNote, useModelInfo } from './requirements.js';

/** The Model Slot every Harness has; its Default Model is the User's Default Model. */
const DEFAULT_SLOT = 'default';

export interface DefaultModelsSectionProps {
  /**
   * Changes after every change the Connections section makes (an add, a disable, a removal), so
   * the rows read the Connections and Slot Bindings again.
   */
  readonly revision: number;
  /** After a Default Model was set or cleared, which changes what Harness Slots resolve to. */
  readonly onChanged?: () => void;
}

/**
 * The Default Models (global Slot Bindings): a row for `default`, always, then one per other Slot
 * name that has a Default Model or that an installed Harness declares, by name (docs/ux F6). Each
 * row has a {@link ModelPicker} over the enabled Connections with "Not set" and "Type a model
 * name"; a choice is saved at once with `bindings.setGlobal`, and the Model Gateway uses it from
 * its next request. A row cleared here stays until the page is left, saying it falls back to
 * `default`. A Default Model whose Connection is disabled is marked, since requests skip it until
 * the Connection is enabled again. A Default Model is checked against the Model Requirements of
 * the Slot of the same name of every installed Harness; a warning is advisory only.
 */
export function DefaultModelsSection({ revision, onChanged }: DefaultModelsSectionProps) {
  const { t } = useI18n();
  const [connections, setConnections] = useState<readonly ConnectionSummary[] | null>(null);
  const [bindings, setBindings] = useState<readonly GlobalBinding[] | null>(null);
  const [installs, setInstalls] = useState<readonly InstalledHarness[]>([]);
  const [installsRevision, setInstallsRevision] = useState(0);
  /** The Slot names shown: `default`, those bound, and those cleared during this visit. */
  const [slots, setSlots] = useState<readonly string[]>([DEFAULT_SLOT]);
  const [error, setError] = useState<IpcError | null>(null);
  const modelInfo = useModelInfo(connections);

  const applyBindings = (next: readonly GlobalBinding[]) => {
    setBindings(next);
    setSlots((shown) => slotNames(shown, next));
    onChanged?.();
  };

  useEffect(
    () =>
      window.api.on('installs.changed', () => {
        setInstallsRevision((current) => current + 1);
      }),
    [],
  );

  useEffect(() => {
    let current = true;
    void Promise.all([
      window.api.connections.list(),
      window.api.bindings.getGlobal(),
      window.api.installs.list(),
    ]).then(([connectionsResult, bindingsResult, installsResult]) => {
      if (!current) return;
      setError(null);
      if (connectionsResult.ok) setConnections(connectionsResult.data);
      else setError(connectionsResult.error);
      // Without the installs the rows still work; only their Slot names and warnings are missing.
      if (installsResult.ok) setInstalls(installsResult.data);
      if (bindingsResult.ok) {
        setBindings(bindingsResult.data);
        setSlots((shown) => slotNames(shown, bindingsResult.data));
      } else {
        setError(bindingsResult.error);
      }
    });
    return () => {
      current = false;
    };
  }, [revision, installsRevision]);

  const declared = installs.flatMap((install) => Object.keys(install.manifest.models.slots));
  const rows = slotNames([...slots, ...declared], []);
  return (
    <section className="models-section" aria-labelledby="models-defaults">
      <div className="models-section-header">
        <h2 id="models-defaults">{t('models.defaults.title')}</h2>
      </div>
      <p className="hint">{t('models.defaults.order')}</p>
      {error === null ? null : <ErrorMessage error={error} />}
      {connections === null || bindings === null ? null : (
        <>
          {connections.some((connection) => connection.enabled) ? null : (
            <p className="hint">{t('models.defaults.no_connection')}</p>
          )}
          <ul className="default-model-list">
            {rows.map((slot) => (
              <DefaultModelRow
                key={slot}
                slot={slot}
                binding={bindings.find((binding) => binding.slot === slot) ?? null}
                connections={connections}
                installs={installs}
                modelInfo={modelInfo}
                onSaved={applyBindings}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function DefaultModelRow({
  slot,
  binding,
  connections,
  installs,
  modelInfo,
  onSaved,
}: {
  readonly slot: string;
  readonly binding: GlobalBinding | null;
  readonly connections: readonly ConnectionSummary[];
  /** The installed Harnesses: those declaring this Slot name check the model's requirements. */
  readonly installs: readonly InstalledHarness[];
  readonly modelInfo: (target: BindingTarget) => ModelInfo | null;
  readonly onSaved: (bindings: readonly GlobalBinding[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const mounted = useMounted();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);

  const save = async (target: BindingTarget | null) => {
    setSaving(true);
    setError(null);
    const result = await window.api.bindings.setGlobal({ slot, target });
    if (!mounted.current) return;
    setSaving(false);
    if (result.ok) onSaved(result.data);
    else setError(result.error);
  };

  const connection =
    binding === null ? undefined : connections.find((item) => item.id === binding.connectionId);
  return (
    <li className="default-model-row" aria-busy={saving}>
      <code className="default-model-slot">{slot}</code>
      <div className="default-model-body">
        <ModelPicker
          id={id}
          label={t('models.defaults.picker', { slot })}
          connections={connections}
          value={
            binding === null ? null : { connectionId: binding.connectionId, model: binding.model }
          }
          onChange={(choice) => void save(choice)}
          onClear={() => void save(null)}
          disabled={saving}
        />
        {binding === null && slot !== DEFAULT_SLOT ? (
          <p className="field-hint">{t('models.defaults.falls_back')}</p>
        ) : null}
        {connection === undefined || connection.enabled ? null : (
          <p className="default-model-warning" role="note">
            <span className="status-chip" data-status="warning">
              {t('models.defaults.connection_disabled')}
            </span>
            <span>
              {t('models.defaults.connection_disabled_hint', {
                name: connectionName(t, connection),
              })}
            </span>
          </p>
        )}
        {binding === null
          ? null
          : installs.map((install) =>
              Object.hasOwn(install.manifest.models.slots, slot) ? (
                <RequirementNote
                  key={install.harnessId}
                  harness={install.name}
                  slot={slot}
                  requirements={install.manifest.models.slots[slot]?.requirements}
                  model={modelInfo(binding)}
                />
              ) : null,
            )}
        {error === null ? null : <ErrorMessage error={error} />}
      </div>
    </li>
  );
}

/** `default`, then every other Slot name shown or bound, by name, each once. */
function slotNames(shown: readonly string[], bindings: readonly GlobalBinding[]): string[] {
  const others = new Set([...shown, ...bindings.map((binding) => binding.slot)]);
  others.delete(DEFAULT_SLOT);
  return [DEFAULT_SLOT, ...[...others].sort()];
}
