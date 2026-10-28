import { useId, useRef, useState } from 'react';
import {
  MAX_CONNECTION_NAME_LENGTH,
  isNameTaken,
  parseApiKey,
  parseBaseUrl,
  parseConnectionName,
} from '../../../shared/connection-input.js';
import type {
  ConnectionDraft,
  ConnectionSummary,
  ConnectionUpdate,
  IpcError,
  IpcResult,
  ProviderPreset,
} from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { LockIcon } from '../shell/icons.js';
import { connectionName, CUSTOM_PROVIDER_ID, monogram, providerName } from './names.js';

/** What the dialog is doing: choosing a Provider, adding a Connection for one, or editing one. */
type Mode =
  | { readonly kind: 'pick' }
  | { readonly kind: 'add'; readonly preset: ProviderPreset }
  | {
      readonly kind: 'edit';
      readonly preset: ProviderPreset;
      readonly connection: ConnectionSummary;
    };

type Problem =
  | 'name_required'
  | 'name_too_long'
  | 'name_taken'
  | 'key_required'
  | 'key_invalid'
  | 'base_url_required'
  | 'base_url_invalid';

interface Problems {
  readonly name?: Problem;
  readonly apiKey?: Problem;
  readonly baseUrl?: Problem;
}

export interface ConnectionDialogProps {
  readonly presets: readonly ProviderPreset[];
  /** The saved Connections: to mark single-instance Providers already added and to check names. */
  readonly connections: readonly ConnectionSummary[];
  /** The Connection to edit; absent to add one, starting with the Provider picker. */
  readonly editing?: ConnectionSummary;
  readonly onClose: () => void;
  readonly onSaved: (connection: ConnectionSummary) => void;
}

/**
 * Adds or edits a Connection, in a modal. Adding starts with a grid of every Provider; picking a
 * Provider that allows one Connection and already has it opens that Connection to edit, since
 * adding it again would edit it anyway. The form shows a name for the custom endpoint, the key
 * field where the Provider takes one (optional for the custom endpoint), and the base URL with the
 * Provider's default as its placeholder. A saved key is never shown: the field stays empty, and a
 * new key replaces it. Save checks the fields first (the rules of shared/connection-input.ts,
 * which the Runtime checks again), then calls `connections.add` or `connections.update`, which
 * test the Connection before saving it; a failure stays inline and keeps what was typed.
 */
export function ConnectionDialog({
  presets,
  connections,
  editing,
  onClose,
  onSaved,
}: ConnectionDialogProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>(() => {
    if (editing === undefined) return { kind: 'pick' };
    const preset = presets.find((item) => item.id === editing.providerId);
    return preset === undefined ? { kind: 'pick' } : { kind: 'edit', preset, connection: editing };
  });

  const title =
    mode.kind === 'pick'
      ? t('models.dialog.add_title')
      : mode.kind === 'add'
        ? t('models.dialog.add_title_named', {
            name: providerName(t, mode.preset.id, mode.preset.displayName),
          })
        : t('models.dialog.edit_title', { name: connectionName(t, mode.connection) });

  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      {mode.kind === 'pick' ? (
        <PresetPicker
          presets={presets}
          connections={connections}
          onPick={(preset) => {
            const existing = preset.custom
              ? undefined
              : connections.find((connection) => connection.id === preset.id);
            setMode(
              existing === undefined
                ? { kind: 'add', preset }
                : { kind: 'edit', preset, connection: existing },
            );
          }}
          onCancel={onClose}
        />
      ) : (
        <ConnectionForm
          // A new form, with empty fields, for each Provider picked.
          key={mode.kind === 'edit' ? mode.connection.id : mode.preset.id}
          mode={mode}
          connections={connections}
          onBack={
            editing === undefined
              ? () => {
                  setMode({ kind: 'pick' });
                }
              : undefined
          }
          onCancel={onClose}
          onBusy={setBusy}
          onSaved={onSaved}
        />
      )}
    </Modal>
  );
}

function PresetPicker({
  presets,
  connections,
  onPick,
  onCancel,
}: {
  readonly presets: readonly ProviderPreset[];
  readonly connections: readonly ConnectionSummary[];
  readonly onPick: (preset: ProviderPreset) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const detail = (preset: ProviderPreset) => {
    if (!preset.custom && connections.some((connection) => connection.id === preset.id)) {
      return t('models.dialog.preset_added');
    }
    if (preset.custom) return t('models.dialog.preset_custom');
    return preset.local ? t('models.dialog.preset_local') : t('models.dialog.preset_key');
  };
  return (
    <>
      <p className="hint">{t('models.dialog.choose')}</p>
      <ul className="preset-grid">
        {presets.map((preset) => {
          const name = providerName(t, preset.id, preset.displayName);
          return (
            <li key={preset.id}>
              <button
                type="button"
                className="preset-button"
                aria-labelledby={`${ids}-${preset.id}-name`}
                aria-describedby={`${ids}-${preset.id}-detail`}
                onClick={() => {
                  onPick(preset);
                }}
              >
                <span className="monogram" aria-hidden="true">
                  {monogram(name)}
                </span>
                <span className="preset-button-text">
                  <span id={`${ids}-${preset.id}-name`} className="preset-button-name">
                    {name}
                  </span>
                  <span id={`${ids}-${preset.id}-detail`} className="preset-button-detail">
                    {detail(preset)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="modal-actions">
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('models.dialog.cancel')}
        </button>
      </div>
    </>
  );
}

function ConnectionForm({
  mode,
  connections,
  onBack,
  onCancel,
  onBusy,
  onSaved,
}: {
  readonly mode: Exclude<Mode, { kind: 'pick' }>;
  readonly connections: readonly ConnectionSummary[];
  readonly onBack: (() => void) | undefined;
  readonly onCancel: () => void;
  readonly onBusy: (busy: boolean) => void;
  readonly onSaved: (connection: ConnectionSummary) => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const { preset } = mode;
  const editing = mode.kind === 'edit' ? mode.connection : undefined;
  /** The base URL field starts empty when the Connection uses the Provider's default. */
  const initialBaseUrl =
    editing === undefined || editing.baseUrl === preset.baseUrl ? '' : editing.baseUrl;
  const [name, setName] = useState(editing?.displayName ?? '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [problems, setProblems] = useState<Problems>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  const fields = {
    name: useRef<HTMLInputElement>(null),
    apiKey: useRef<HTMLInputElement>(null),
    baseUrl: useRef<HTMLInputElement>(null),
  };

  const showKey = preset.requiresKey || preset.custom;
  const hasStoredKey = editing !== undefined && editing.keyHint !== null;

  const check = (): Problems => {
    const found: { -readonly [K in keyof Problems]: Problems[K] } = {};
    if (preset.custom) {
      const parsed = parseConnectionName(name);
      const others = connections
        .filter((item) => item.providerId === CUSTOM_PROVIDER_ID && item.id !== editing?.id)
        .map((item) => item.displayName);
      if (parsed === null) {
        found.name = name.trim() === '' ? 'name_required' : 'name_too_long';
      } else if (isNameTaken(parsed, others)) {
        found.name = 'name_taken';
      }
    }
    if (showKey) {
      const key = parseApiKey(apiKey);
      if (key === null) found.apiKey = 'key_invalid';
      else if (key === undefined && preset.requiresKey && !hasStoredKey) {
        found.apiKey = 'key_required';
      }
    }
    const url = parseBaseUrl(baseUrl);
    if (url === null) found.baseUrl = 'base_url_invalid';
    else if (url === undefined && preset.custom) found.baseUrl = 'base_url_required';
    return found;
  };

  const save = async () => {
    const found = check();
    setProblems(found);
    setError(null);
    const firstInvalid = (['name', 'apiKey', 'baseUrl'] as const).find(
      (field) => found[field] !== undefined,
    );
    if (firstInvalid !== undefined) {
      fields[firstInvalid].current?.focus();
      return;
    }
    const key = parseApiKey(apiKey) ?? undefined;
    let call: Promise<IpcResult<ConnectionSummary>>;
    if (editing === undefined) {
      const draft: ConnectionDraft = {
        providerId: preset.id,
        ...(key === undefined ? {} : { apiKey: key }),
        ...(preset.custom ? { displayName: name.trim() } : {}),
        ...(baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
      };
      call = window.api.connections.add(draft);
    } else {
      const update: ConnectionUpdate = {
        id: editing.id,
        ...(key === undefined ? {} : { apiKey: key }),
        ...(preset.custom && name.trim() !== editing.displayName
          ? { displayName: name.trim() }
          : {}),
        ...(baseUrl.trim() === initialBaseUrl ? {} : { baseUrl: baseUrl.trim() }),
      };
      if (Object.keys(update).length === 1) {
        onCancel();
        return;
      }
      call = window.api.connections.update(update);
    }
    setSaving(true);
    onBusy(true);
    const result = await call;
    setSaving(false);
    onBusy(false);
    if (result.ok) onSaved(result.data);
    else setError(result.error);
  };

  const problemText = (problem: Problem | undefined) =>
    problem === undefined
      ? null
      : t(`models.invalid.${problem}`, { max: MAX_CONNECTION_NAME_LENGTH });

  /** The accessibility attributes and message of a field that may have a problem. */
  const fieldProblem = (field: keyof Problems, hintId?: string) => {
    const problem = problems[field];
    const errorId = `${ids}-${field}-error`;
    const describedBy = [problem === undefined ? undefined : errorId, hintId]
      .filter((id) => id !== undefined)
      .join(' ');
    return {
      input: {
        'aria-invalid': problem !== undefined,
        ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
      },
      message:
        problem === undefined ? null : (
          <p id={errorId} className="field-error">
            {problemText(problem)}
          </p>
        ),
    };
  };

  const providerLabel = providerName(t, preset.id, preset.displayName);
  const nameField = fieldProblem('name', `${ids}-name-hint`);
  const keyField = fieldProblem('apiKey', hasStoredKey ? `${ids}-key-hint` : undefined);
  const urlField = fieldProblem('baseUrl', preset.baseUrl === null ? undefined : `${ids}-url-hint`);

  return (
    <form
      className="modal-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="modal-fields" disabled={saving}>
        {preset.custom ? (
          <div className="field">
            <label htmlFor={`${ids}-name`}>{t('models.dialog.name')}</label>
            <input
              id={`${ids}-name`}
              ref={fields.name}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              {...nameField.input}
            />
            <p id={`${ids}-name-hint`} className="field-hint">
              {t('models.dialog.name_hint')}
            </p>
            {nameField.message}
          </div>
        ) : null}
        {showKey ? (
          <div className="field">
            <label htmlFor={`${ids}-key`}>
              {preset.requiresKey
                ? t('models.dialog.api_key')
                : t('models.dialog.api_key_optional')}
            </label>
            <input
              id={`${ids}-key`}
              ref={fields.apiKey}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder={hasStoredKey ? `••••${editing.keyHint}` : preset.keyPlaceholder}
              onChange={(event) => {
                setApiKey(event.target.value);
              }}
              {...keyField.input}
            />
            {hasStoredKey ? (
              <p id={`${ids}-key-hint`} className="field-hint">
                <LockIcon />
                <span>{t('models.dialog.api_key_keep')}</span>
              </p>
            ) : null}
            {keyField.message}
          </div>
        ) : null}
        <div className="field">
          <label htmlFor={`${ids}-url`}>
            {preset.custom ? t('models.dialog.base_url') : t('models.dialog.base_url_optional')}
          </label>
          <input
            id={`${ids}-url`}
            ref={fields.baseUrl}
            type="url"
            spellCheck={false}
            value={baseUrl}
            placeholder={preset.baseUrl ?? t('onboarding.cloud.base_url_placeholder')}
            onChange={(event) => {
              setBaseUrl(event.target.value);
            }}
            {...urlField.input}
          />
          {preset.baseUrl === null ? null : (
            <p id={`${ids}-url-hint`} className="field-hint">
              {t('models.dialog.base_url_default', { url: preset.baseUrl })}
            </p>
          )}
          {urlField.message}
        </div>
      </fieldset>
      <p className="modal-links">
        <a href={preset.docsUrl} target="_blank" rel="noreferrer">
          {t('models.dialog.docs', { name: providerLabel })}
        </a>
      </p>
      {error === null ? null : (
        <div className="error-panel" role="group" aria-labelledby={`${ids}-failed`}>
          <p id={`${ids}-failed`} className="error-panel-title">
            {t('models.dialog.failed')}
          </p>
          <ErrorMessage error={error} />
        </div>
      )}
      <p className="wizard-info">
        <LockIcon />
        <span>{t('models.keys_stay')}</span>
      </p>
      <div className="modal-actions">
        {onBack === undefined ? null : (
          <button
            type="button"
            className="button-link modal-actions-start"
            disabled={saving}
            onClick={onBack}
          >
            {t('models.dialog.back')}
          </button>
        )}
        <button type="button" className="button-secondary" disabled={saving} onClick={onCancel}>
          {t('models.dialog.cancel')}
        </button>
        <button type="submit" className="button-primary" disabled={saving} aria-busy={saving}>
          {saving ? <span className="spinner" aria-hidden="true" /> : null}
          {saving ? t('models.dialog.saving') : t('models.dialog.save')}
        </button>
      </div>
    </form>
  );
}
