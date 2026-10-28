import { useCallback, useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ConnectionSummary, IpcError, ProviderPreset } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { ConnectionDialog } from '../models/ConnectionDialog.js';
import { DefaultModelsSection } from '../models/DefaultModelsSection.js';
import { HarnessOverridesSection } from '../models/HarnessOverridesSection.js';
import { LocalProvidersPanel } from '../models/LocalProvidersPanel.js';
import { connectionName, connectionStatus, CUSTOM_PROVIDER_ID, monogram } from '../models/names.js';
import { RemoveConnectionDialog } from '../models/RemoveConnectionDialog.js';
import { LockIcon } from '../shell/icons.js';

type Dialog =
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly connection: ConnectionSummary }
  | { readonly kind: 'remove'; readonly connection: ConnectionSummary };

/**
 * The Models page: the Connections, then the Default Models, then the Per-Harness Overrides.
 * After every change to the Connections, both binding sections read them again, since a disabled
 * or removed Connection changes what their rows show and resolve to; after a Default Model
 * changes, the Harness cards resolve their Slots again. The deep link `models?harness=<id>` opens
 * that Harness's card and scrolls to it.
 */
export function ModelsPage() {
  const [searchParams] = useSearchParams();
  const focusHarness = searchParams.get('harness');
  const [connectionsRevision, setConnectionsRevision] = useState(0);
  const [bindingsRevision, setBindingsRevision] = useState(0);
  const connectionsChanged = useCallback(() => {
    setConnectionsRevision((current) => current + 1);
  }, []);
  const bindingsChanged = useCallback(() => {
    setBindingsRevision((current) => current + 1);
  }, []);
  return (
    <div className="models">
      <ConnectionsSection onChanged={connectionsChanged} />
      <DefaultModelsSection revision={connectionsRevision} onChanged={bindingsChanged} />
      <HarnessOverridesSection
        revision={connectionsRevision + bindingsRevision}
        focusHarness={focusHarness === '' ? null : focusHarness}
      />
    </div>
  );
}

/**
 * The Connections list: each with its Provider's monogram and name, a status (Disabled, Connection
 * failed with the Provider's text, or the app's own words for a timeout or a reply that is not the
 * API's, Local, Connected, Not tested), where it points or that its key is
 * stored encrypted, how many models it lists, and Test connection, Edit, Enable or Disable, and
 * Remove. Test runs `connections.test`, which records the result on the Connection; where the
 * Provider lists no models, it first asks for the model to test with, starting from the one the
 * last passed test used. A disabled Connection is not tested: its row shows only Disabled, so a
 * result would not show. Tests and Enable or Disable of different Connections may run at once;
 * while a row's own runs, its buttons wait, so it is not edited or removed under them. The list is
 * read from the Runtime when the page opens and again after every change made here. Below it,
 * {@link LocalProvidersPanel} offers the local Providers found running.
 */
function ConnectionsSection({ onChanged }: { readonly onChanged: () => void }) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<readonly ProviderPreset[] | null>(null);
  const [connections, setConnections] = useState<readonly ConnectionSummary[] | null>(null);
  const [error, setError] = useState<IpcError | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** The Connections whose Enable or Disable is running. */
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set());
  /** The Connections whose test is running. */
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());

  /** Reads the Connections again after a change made here, and tells the page. */
  const load = useCallback(async () => {
    onChanged();
    const result = await window.api.connections.list();
    if (result.ok) setConnections(result.data);
    else setError(result.error);
  }, [onChanged]);

  useEffect(() => {
    let current = true;
    void Promise.all([window.api.providers.list(), window.api.connections.list()]).then(
      ([presetsResult, connectionsResult]) => {
        if (!current) return;
        if (presetsResult.ok) setPresets(presetsResult.data);
        else setError(presetsResult.error);
        if (connectionsResult.ok) setConnections(connectionsResult.data);
        else setError(connectionsResult.error);
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const toggle = async (connection: ConnectionSummary) => {
    setToggling((ids) => withId(ids, connection.id));
    setError(null);
    const result = await window.api.connections.update({
      id: connection.id,
      enabled: !connection.enabled,
    });
    setToggling((ids) => withoutId(ids, connection.id));
    if (result.ok) await load();
    else setError(result.error);
  };

  const runTest = async (connection: ConnectionSummary, model?: string) => {
    setTesting((ids) => withId(ids, connection.id));
    setError(null);
    const result = await window.api.connections.test({
      id: connection.id,
      ...(model === undefined ? {} : { model }),
    });
    setTesting((ids) => withoutId(ids, connection.id));
    if (result.ok) await load();
    else setError(result.error);
  };

  const closeAndReload = () => {
    setDialog(null);
    setError(null);
    void load();
  };

  return (
    <section className="models-section" aria-labelledby="models-connections">
      <div className="models-section-header">
        <h2 id="models-connections">{t('models.connections')}</h2>
        <button
          type="button"
          className="button-primary"
          disabled={presets === null}
          onClick={() => {
            setDialog({ kind: 'add' });
          }}
        >
          {t('models.add')}
        </button>
      </div>
      {error === null ? null : <ErrorMessage error={error} />}
      {connections === null ? null : connections.length === 0 ? (
        <div className="empty-panel">
          <p className="empty-panel-title">{t('models.empty')}</p>
          <p className="hint">{t('models.keys_stay')}</p>
        </div>
      ) : (
        <ul className="connection-list">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              needsTestModel={
                presets?.find((preset) => preset.id === connection.providerId)?.needsTestModel ===
                true
              }
              testing={testing.has(connection.id)}
              onTest={(model) => void runTest(connection, model)}
              toggling={toggling.has(connection.id)}
              onEdit={() => {
                setDialog({ kind: 'edit', connection });
              }}
              onToggle={() => void toggle(connection)}
              onRemove={() => {
                setDialog({ kind: 'remove', connection });
              }}
            />
          ))}
        </ul>
      )}
      {connections === null ? null : (
        <LocalProvidersPanel
          connections={connections}
          onAdded={() => {
            setError(null);
            void load();
          }}
        />
      )}
      {dialog?.kind === 'remove' ? (
        <RemoveConnectionDialog
          connection={dialog.connection}
          onClose={() => {
            setDialog(null);
          }}
          onRemoved={closeAndReload}
        />
      ) : null}
      {dialog !== null && dialog.kind !== 'remove' && presets !== null && connections !== null ? (
        <ConnectionDialog
          presets={presets}
          connections={connections}
          {...(dialog.kind === 'edit' ? { editing: dialog.connection } : {})}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={closeAndReload}
        />
      ) : null}
    </section>
  );
}

function ConnectionRow({
  connection,
  needsTestModel,
  testing,
  onTest,
  toggling,
  onEdit,
  onToggle,
  onRemove,
}: {
  readonly connection: ConnectionSummary;
  /** Whether its test needs a model name: the Provider lists none and is not catalogued. */
  readonly needsTestModel: boolean;
  readonly testing: boolean;
  readonly onTest: (model?: string) => void;
  readonly toggling: boolean;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const name = connectionName(t, connection);
  const status = testing ? 'testing' : connectionStatus(connection);
  /** Its own test or Enable or Disable is running. */
  const busy = testing || toggling;
  /** The inline "Model to test with", open while the User names one. */
  const [askModel, setAskModel] = useState(false);
  const [testModel, setTestModel] = useState(connection.testModel ?? '');
  const [modelProblem, setModelProblem] = useState<'required' | 'invalid' | null>(null);

  const submitTestModel = () => {
    const model = testModel.trim();
    if (model === '' || /\s/.test(model)) {
      setModelProblem(model === '' ? 'required' : 'invalid');
      return;
    }
    setModelProblem(null);
    setAskModel(false);
    onTest(model);
  };
  // Where a local Provider or a custom endpoint runs is what tells it apart; a cloud Provider is
  // told apart by its name.
  const showUrl = connection.local || connection.providerId === CUSTOM_PROVIDER_ID;
  return (
    <li className="connection-row" data-enabled={connection.enabled}>
      <span className="monogram" aria-hidden="true">
        {monogram(name)}
      </span>
      <div className="connection-row-text">
        <p className="connection-row-title">
          <span className="connection-row-name">{name}</span>
          <span className="status-chip" data-status={status}>
            {t(`models.status.${status}`)}
          </span>
        </p>
        {showUrl ? <p className="connection-row-detail">{connection.baseUrl}</p> : null}
        {connection.models.length > 0 ? (
          <p className="connection-row-detail">
            {t('models.models_loaded', { count: connection.models.length })}
          </p>
        ) : null}
        {connection.keyHint === null ? null : (
          <p className="connection-row-detail">
            <LockIcon />
            <span>
              {connection.keyHint === ''
                ? t('models.key_stored')
                : t('models.key_stored_hint', { hint: connection.keyHint })}
            </span>
          </p>
        )}
        {status !== 'failed' ? null : connection.lastTestError !== null ? (
          <code className="connection-row-error">{connection.lastTestError}</code>
        ) : connection.lastTestFailure !== null ? (
          <p className="connection-row-failure">{t(`error.${connection.lastTestFailure}`)}</p>
        ) : null}
      </div>
      <div className="connection-row-actions">
        <button
          type="button"
          className="button-secondary"
          aria-label={t('models.test_named', { name })}
          aria-expanded={needsTestModel ? askModel : undefined}
          disabled={busy || !connection.enabled}
          aria-busy={testing}
          onClick={() => {
            if (needsTestModel) setAskModel((open) => !open);
            else onTest();
          }}
        >
          {testing ? t('models.testing') : t('models.test')}
        </button>
        <button
          type="button"
          className="button-secondary"
          aria-label={t('models.edit_named', { name })}
          disabled={busy}
          onClick={onEdit}
        >
          {t('models.edit')}
        </button>
        <button
          type="button"
          className="button-secondary"
          aria-label={
            connection.enabled
              ? t('models.disable_named', { name })
              : t('models.enable_named', { name })
          }
          disabled={busy}
          aria-busy={toggling}
          onClick={onToggle}
        >
          {connection.enabled ? t('models.disable') : t('models.enable')}
        </button>
        <button
          type="button"
          className="button-secondary button-secondary-danger"
          aria-label={t('models.remove_named', { name })}
          disabled={busy}
          onClick={onRemove}
        >
          {t('models.remove')}
        </button>
      </div>
      {askModel && connection.enabled ? (
        <form
          className="connection-row-test"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submitTestModel();
          }}
        >
          <div className="field">
            <label htmlFor={`${ids}-test-model`}>{t('models.test_model_for', { name })}</label>
            <input
              id={`${ids}-test-model`}
              spellCheck={false}
              autoComplete="off"
              value={testModel}
              aria-invalid={modelProblem !== null}
              {...(modelProblem === null ? {} : { 'aria-describedby': `${ids}-test-model-error` })}
              onChange={(event) => {
                setTestModel(event.target.value);
                setModelProblem(null);
              }}
            />
            {modelProblem === null ? null : (
              <p id={`${ids}-test-model-error`} className="field-error">
                {t(`models.invalid.test_model_${modelProblem}`)}
              </p>
            )}
          </div>
          <button type="submit" className="button-secondary">
            {t('models.test')}
          </button>
        </form>
      ) : null}
    </li>
  );
}

function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set(ids).add(id);
}

function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.delete(id);
  return next;
}
