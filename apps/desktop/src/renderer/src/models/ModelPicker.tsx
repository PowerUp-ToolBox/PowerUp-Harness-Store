import { useEffect, useId, useState } from 'react';
import type { ConnectionSummary, IpcError, ModelInfo } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n, type I18n } from '../i18n/I18nProvider.js';
import { connectionName } from './names.js';

/** A model of one Connection: what a picker chooses, and what a Slot Binding stores. */
export interface ModelChoice {
  readonly connectionId: string;
  /** The model name at that Connection's Provider, without the Provider prefix. */
  readonly model: string;
}

type Listing =
  | { readonly state: 'loading' }
  | { readonly state: 'listed'; readonly models: readonly ModelInfo[] }
  | { readonly state: 'failed'; readonly error: IpcError };

type TypedProblem = 'format' | 'connection';

export interface ModelPickerProps {
  /** The select's id, for an outside `<label htmlFor>`. */
  readonly id: string;
  /** The select's accessible name, where no `<label>` names it. */
  readonly label?: string;
  /** The Connections whose models it offers; disabled ones are left out. */
  readonly connections: readonly ConnectionSummary[];
  readonly value: ModelChoice | null;
  readonly onChange: (value: ModelChoice) => void;
  /**
   * Offers a "Not set" choice, which calls this: for a binding the User may clear. Without it, an
   * empty picker only asks to choose a model.
   */
  readonly onClear?: () => void;
  /** The text of the choice that calls `onClear`. Default: "Not set". */
  readonly clearLabel?: string;
  /** While the choice is being saved: the controls wait. */
  readonly disabled?: boolean;
}

/**
 * A model picker: one select over the models of every enabled Connection, grouped by Connection,
 * each annotated with what is known of it (context window, tool calling, vision: the catalogue's
 * models for Anthropic and Google). The models come from `connections.models` when the picker
 * opens (the Runtime reuses a live listing for 10 minutes), joined with those the Connection
 * summary already names. A listing that fails is said so, with the Provider's text.
 *
 * "Type a model name" always offers a free-text `provider/model` entry (split at the first `/`,
 * like the Gateway's explicit ids), for models a Provider does not list. A typed model has unknown
 * capabilities, and stays in its Connection's group, marked as typed. A value on a disabled
 * Connection (a saved binding the User paused) is still shown, in that Connection's group, but no
 * other model of it is offered.
 */
export function ModelPicker({
  id,
  label,
  connections,
  value,
  onChange,
  onClear,
  clearLabel,
  disabled = false,
}: ModelPickerProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const ids = useId();
  const enabled = connections.filter((connection) => connection.enabled);
  const enabledIds = enabled.map((connection) => connection.id).join('\n');
  const [listings, setListings] = useState<Readonly<Record<string, Listing>>>({});
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [typedProblem, setTypedProblem] = useState<TypedProblem | null>(null);

  useEffect(() => {
    let current = true;
    const wanted = enabledIds === '' ? [] : enabledIds.split('\n');
    setListings(
      Object.fromEntries(wanted.map((connectionId) => [connectionId, { state: 'loading' }])),
    );
    for (const connectionId of wanted) {
      void window.api.connections.models(connectionId).then((result) => {
        if (!current) return;
        const listing: Listing = result.ok
          ? { state: 'listed', models: result.data }
          : { state: 'failed', error: result.error };
        setListings((all) => ({ ...all, [connectionId]: listing }));
      });
    }
    return () => {
      current = false;
    };
  }, [enabledIds]);

  /** A Connection's models: the listed ones with what is known, then those only the summary names. */
  const modelsOf = (connection: ConnectionSummary): readonly ModelInfo[] => {
    const listing = listings[connection.id];
    const listed = listing?.state === 'listed' ? listing.models : [];
    const known = new Set(listed.map((model) => model.id));
    return [
      ...listed,
      ...connection.models.filter((model) => !known.has(model)).map((model) => ({ id: model })),
    ];
  };

  const applyTyped = () => {
    const slash = typed.indexOf('/');
    const connectionId = typed.slice(0, slash).trim();
    const model = typed.slice(slash + 1).trim();
    if (slash <= 0 || model === '' || /\s/.test(model)) {
      setTypedProblem('format');
      return;
    }
    if (!enabled.some((connection) => connection.id === connectionId)) {
      setTypedProblem('connection');
      return;
    }
    setTypedProblem(null);
    setTyping(false);
    setTyped('');
    onChange({ connectionId, model });
  };

  const selected = value === null ? '' : choiceValue(value);
  /** The Connection of a value that no enabled Connection offers. */
  const pausedConnection =
    value === null || enabled.some((connection) => connection.id === value.connectionId)
      ? undefined
      : connections.find((connection) => connection.id === value.connectionId);
  const failed = enabled.filter((connection) => listings[connection.id]?.state === 'failed');
  const loading = enabled.some((connection) => listings[connection.id]?.state === 'loading');
  const typedId = `${ids}-typed`;
  const typedErrorId = `${ids}-typed-error`;

  return (
    <div className="model-picker">
      <div className="model-picker-row">
        <select
          id={id}
          value={selected}
          aria-label={label}
          aria-busy={loading}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === '') {
              onClear?.();
              return;
            }
            const choice = parseChoice(event.target.value);
            if (choice !== null) onChange(choice);
          }}
        >
          {onClear !== undefined ? (
            <option value="">{clearLabel ?? t('models.picker.not_set')}</option>
          ) : value === null ? (
            <option value="" disabled>
              {loading ? t('models.picker.loading') : t('models.picker.choose')}
            </option>
          ) : null}
          {pausedConnection === undefined || value === null ? null : (
            <optgroup label={connectionName(t, pausedConnection)}>
              <option value={selected}>{value.model}</option>
            </optgroup>
          )}
          {enabled.map((connection) => {
            const models = modelsOf(connection);
            const typedHere =
              value?.connectionId === connection.id &&
              !models.some((model) => model.id === value.model);
            return (
              <optgroup key={connection.id} label={connectionName(t, connection)}>
                {models.map((model) => (
                  <option
                    key={model.id}
                    value={choiceValue({ connectionId: connection.id, model: model.id })}
                  >
                    {modelLabel(i18n, model)}
                  </option>
                ))}
                {typedHere ? (
                  <option value={selected}>
                    {t('models.picker.typed', { model: value.model })}
                  </option>
                ) : null}
                {models.length === 0 && !typedHere ? (
                  <option value="" disabled>
                    {listings[connection.id]?.state === 'loading'
                      ? t('models.picker.loading')
                      : t('models.picker.none')}
                  </option>
                ) : null}
              </optgroup>
            );
          })}
        </select>
        <button
          type="button"
          className="button-link"
          disabled={disabled}
          aria-expanded={typing}
          aria-controls={typing ? typedId : undefined}
          onClick={() => {
            setTyping((open) => !open);
            setTypedProblem(null);
          }}
        >
          {t('models.picker.type')}
        </button>
      </div>
      {typing ? (
        <div className="model-picker-typed">
          <input
            id={typedId}
            aria-label={t('models.picker.type')}
            spellCheck={false}
            autoComplete="off"
            value={typed}
            placeholder={t('models.picker.type_placeholder')}
            aria-invalid={typedProblem !== null}
            {...(typedProblem === null ? {} : { 'aria-describedby': typedErrorId })}
            onChange={(event) => {
              setTyped(event.target.value);
              setTypedProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyTyped();
              }
            }}
          />
          <button
            type="button"
            className="button-secondary"
            disabled={disabled}
            onClick={applyTyped}
          >
            {t('models.picker.use')}
          </button>
          {typedProblem === null ? null : (
            <p id={typedErrorId} className="field-error">
              {typedProblem === 'format'
                ? t('models.picker.invalid_format')
                : t('models.picker.invalid_connection', {
                    id: typed.slice(0, typed.indexOf('/')).trim(),
                  })}
            </p>
          )}
        </div>
      ) : null}
      {failed.map((connection) => {
        const listing = listings[connection.id];
        return listing?.state === 'failed' ? (
          <div key={connection.id} className="model-picker-failed">
            <p className="field-hint">
              {t('models.picker.list_failed', { name: connectionName(t, connection) })}
            </p>
            <ErrorMessage error={listing.error} />
          </div>
        ) : null;
      })}
    </div>
  );
}

/** A choice as a select value: `<connectionId>/<model>`, as typed. */
function choiceValue(choice: ModelChoice): string {
  return `${choice.connectionId}/${choice.model}`;
}

/** The choice of a select value: split at the first `/` (Connection ids hold none). */
function parseChoice(value: string): ModelChoice | null {
  const slash = value.indexOf('/');
  if (slash <= 0) return null;
  return { connectionId: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** A model's name, then what is known of it: `claude-sonnet-5-5 · 1M context · tools · vision`. */
export function modelLabel({ t, formatNumber }: I18n, model: ModelInfo): string {
  const parts = [model.id];
  if (model.contextWindow !== undefined) {
    parts.push(
      t('models.picker.context', {
        context: formatNumber(model.contextWindow, { notation: 'compact' }),
      }),
    );
  }
  if (model.tools === true) parts.push(t('models.picker.tools'));
  if (model.vision === true) parts.push(t('models.picker.vision'));
  return parts.join(' · ');
}
