import { useEffect, useId, useRef, useState } from 'react';
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
  IpcError,
  ProviderPreset,
} from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { connectionName, CUSTOM_PROVIDER_ID, providerName } from '../models/names.js';
import { CheckIcon, LockIcon } from '../shell/icons.js';
import { useMounted } from './use-mounted.js';
import { WizardActions, type WizardNav } from './WizardActions.js';

type Test =
  | { readonly state: 'idle' }
  | { readonly state: 'testing' }
  | { readonly state: 'added' }
  | { readonly state: 'failed'; readonly error: IpcError };

/** What is wrong with a field, shown under it with the `models.invalid.*` message. */
type Problem = 'name_too_long' | 'name_taken' | 'key_invalid' | 'base_url_invalid';

interface Problems {
  readonly displayName?: Problem;
  readonly apiKey?: Problem;
  readonly baseUrl?: Problem;
}

/** The fields in the order they are shown, which is the order a problem is focused in. */
const FIELDS = ['displayName', 'baseUrl', 'apiKey'] as const;

export interface CloudKeyStepProps {
  readonly nav: WizardNav;
  /** The Connections this wizard run added. */
  readonly added: readonly ConnectionSummary[];
  readonly onAdded: (connection: ConnectionSummary) => void;
}

/**
 * The optional remote Provider: a preset from `providers.list` other than the local ones (the
 * custom OpenAI-compatible endpoint also asks for a name and a base URL), an API key, and Test
 * connection, which adds the Connection when the test succeeds (`connections.add`). Before it
 * calls the Runtime, the test checks the fields with the rules of shared/connection-input.ts, as
 * the Models page dialog does, and shows a problem under its field; a custom endpoint's name is
 * checked against the saved Connections (`connections.list`). A failed test shows the error inline
 * with Retry, Edit and Skip, and keeps what the User typed. Continue with an empty form is Skip;
 * Continue waits, like Test connection, while a started form misses a field it needs; Continue
 * with an untested complete form runs the test first and moves on only if it succeeds, so a pasted
 * key is never dropped silently. The form is locked while a test runs, so its result always belongs
 * to what the fields show.
 */
export function CloudKeyStep({ nav, added, onAdded }: CloudKeyStepProps) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<readonly ProviderPreset[] | null>(null);
  const [loadError, setLoadError] = useState<IpcError | null>(null);
  const [providerId, setProviderId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [test, setTest] = useState<Test>({ state: 'idle' });
  const [problems, setProblems] = useState<Problems>({});
  const ids = useId();
  const fields = {
    displayName: useRef<HTMLInputElement>(null),
    baseUrl: useRef<HTMLInputElement>(null),
    apiKey: useRef<HTMLInputElement>(null),
  };
  const mounted = useMounted();

  // Focuses the first field with a problem once it is shown, after the form is unlocked again.
  useEffect(() => {
    const first = FIELDS.find((field) => problems[field] !== undefined);
    if (first !== undefined) fields[first].current?.focus();
  }, [problems]);

  useEffect(() => {
    let current = true;
    void window.api.providers.list().then((result) => {
      if (!current) return;
      if (result.ok) {
        // Local Providers are found by the Local Providers step instead.
        const remote = result.data.filter((item) => !item.local);
        setPresets(remote);
        setProviderId((id) => (id === '' ? (remote[0]?.id ?? '') : id));
      } else {
        setLoadError(result.error);
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const preset = presets?.find((item) => item.id === providerId);
  /** Only the fields the chosen preset shows count: hidden custom fields are not sent. */
  const formEmpty =
    apiKey.trim() === '' &&
    (preset?.custom !== true || (displayName.trim() === '' && baseUrl.trim() === ''));
  const formComplete =
    preset !== undefined &&
    (!preset.requiresKey || apiKey.trim() !== '') &&
    (!preset.custom || (displayName.trim() !== '' && baseUrl.trim() !== ''));
  const testing = test.state === 'testing';
  const alreadyAdded = test.state === 'added';
  /** The remote Connections this run added, kept when the User comes back to this step. */
  const remote = added.filter((connection) => !connection.local);

  /**
   * Any edit after a test starts over: the result belonged to what was typed before. No edit can
   * happen during a test, because the fields are disabled until it ends.
   */
  const edit = (apply: () => void) => {
    apply();
    setTest({ state: 'idle' });
    setProblems((current) => (Object.keys(current).length === 0 ? current : {}));
  };

  /**
   * The problems of a complete form, by the rules the Runtime checks again: without them, a typo
   * would come back as `invalid_input`, whose message is about an internal error.
   */
  const check = async (custom: boolean): Promise<Problems> => {
    const found: { -readonly [K in keyof Problems]: Problems[K] } = {};
    if (parseApiKey(apiKey) === null) found.apiKey = 'key_invalid';
    if (!custom) return found;
    if (parseBaseUrl(baseUrl) === null) found.baseUrl = 'base_url_invalid';
    const name = parseConnectionName(displayName);
    if (name === null) {
      found.displayName = 'name_too_long';
    } else {
      // The saved Connections hold the ones this run added; `added` covers a failed listing.
      const saved = await window.api.connections.list();
      const names = [...(saved.ok ? saved.data : []), ...added]
        .filter((connection) => connection.providerId === CUSTOM_PROVIDER_ID)
        .map((connection) => connection.displayName);
      if (isNameTaken(name, names)) found.displayName = 'name_taken';
    }
    return found;
  };

  const runTest = async (): Promise<boolean> => {
    if (preset === undefined || !formComplete) return false;
    setProblems({});
    setTest({ state: 'testing' });
    const found = await check(preset.custom);
    if (!mounted.current) return false;
    if (Object.keys(found).length > 0) {
      setTest({ state: 'idle' });
      setProblems(found);
      return false;
    }
    return addConnection(preset);
  };

  /** Adds the checked form's Connection, which the Runtime tests first; true when it was added. */
  const addConnection = async (preset: ProviderPreset): Promise<boolean> => {
    const key = parseApiKey(apiKey) ?? undefined;
    const draft: ConnectionDraft = {
      providerId: preset.id,
      ...(key === undefined ? {} : { apiKey: key }),
      ...(preset.custom ? { displayName: displayName.trim(), baseUrl: baseUrl.trim() } : {}),
    };
    const result = await window.api.connections.add(draft);
    if (result.ok) onAdded(result.data);
    if (!mounted.current) return false;
    setTest(result.ok ? { state: 'added' } : { state: 'failed', error: result.error });
    return result.ok;
  };

  const continueStep = async () => {
    if (alreadyAdded || formEmpty) {
      nav.next();
      return;
    }
    if (await runTest()) nav.next();
  };

  /** The accessibility attributes and message of a field that may have a problem. */
  const fieldProblem = (field: keyof Problems) => {
    const problem = problems[field];
    const errorId = `${ids}-${field}-error`;
    return {
      input: {
        'aria-invalid': problem !== undefined,
        ...(problem === undefined ? {} : { 'aria-describedby': errorId }),
      },
      message:
        problem === undefined ? null : (
          <p id={errorId} className="field-error">
            {t(`models.invalid.${problem}`, { max: MAX_CONNECTION_NAME_LENGTH })}
          </p>
        ),
    };
  };
  const nameField = fieldProblem('displayName');
  const urlField = fieldProblem('baseUrl');
  const keyField = fieldProblem('apiKey');

  const presetName = (item: ProviderPreset) =>
    item.custom ? t('onboarding.cloud.custom') : providerName(t, item.id, item.displayName);

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding.step.cloud-key')}</h1>
      <p className="wizard-lead">{t('onboarding.cloud.hint')}</p>
      {loadError === null ? null : <ErrorMessage error={loadError} />}
      {presets === null ? null : (
        <div className="field-row">
          <div className="field">
            <label htmlFor="onboarding-provider">{t('onboarding.cloud.provider')}</label>
            <select
              id="onboarding-provider"
              value={providerId}
              disabled={testing}
              onChange={(event) => {
                edit(() => {
                  setProviderId(event.target.value);
                });
              }}
            >
              {presets.map((item) => (
                <option key={item.id} value={item.id}>
                  {presetName(item)}
                </option>
              ))}
            </select>
          </div>
          {preset?.custom === true ? (
            <>
              <div className="field">
                <label htmlFor="onboarding-display-name">
                  {t('onboarding.cloud.display_name')}
                </label>
                <input
                  id="onboarding-display-name"
                  ref={fields.displayName}
                  value={displayName}
                  disabled={testing}
                  onChange={(event) => {
                    edit(() => {
                      setDisplayName(event.target.value);
                    });
                  }}
                  {...nameField.input}
                />
                {nameField.message}
              </div>
              <div className="field">
                <label htmlFor="onboarding-base-url">{t('onboarding.cloud.base_url')}</label>
                <input
                  id="onboarding-base-url"
                  ref={fields.baseUrl}
                  type="url"
                  spellCheck={false}
                  value={baseUrl}
                  disabled={testing}
                  placeholder={t('onboarding.cloud.base_url_placeholder')}
                  onChange={(event) => {
                    edit(() => {
                      setBaseUrl(event.target.value);
                    });
                  }}
                  {...urlField.input}
                />
                {urlField.message}
              </div>
            </>
          ) : null}
          <div className="field field-wide">
            <label htmlFor="onboarding-api-key">
              {preset?.requiresKey === false
                ? t('onboarding.cloud.api_key_optional')
                : t('onboarding.cloud.api_key')}
            </label>
            <input
              id="onboarding-api-key"
              ref={fields.apiKey}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              disabled={testing}
              placeholder={preset?.keyPlaceholder}
              onChange={(event) => {
                edit(() => {
                  setApiKey(event.target.value);
                });
              }}
              {...keyField.input}
            />
            {keyField.message}
          </div>
        </div>
      )}
      <div className="wizard-test">
        <button
          type="button"
          className="button-secondary"
          disabled={!formComplete || testing || alreadyAdded}
          aria-busy={testing}
          onClick={() => void runTest()}
        >
          {testing ? <span className="spinner" aria-hidden="true" /> : null}
          {testing ? t('onboarding.cloud.testing') : t('onboarding.cloud.test')}
        </button>
      </div>
      {remote.length > 0 ? (
        <ul className="success-list" role="status">
          {remote.map((connection) => (
            <li key={connection.id}>
              <CheckIcon />
              {t('onboarding.cloud.added', { name: connectionName(t, connection) })}
            </li>
          ))}
        </ul>
      ) : null}
      {test.state === 'failed' ? (
        <div className="error-panel" role="group" aria-labelledby="onboarding-test-failed">
          <p id="onboarding-test-failed" className="error-panel-title">
            {t('onboarding.cloud.failed')}
          </p>
          <ErrorMessage error={test.error} />
          <div className="error-panel-actions">
            <button type="button" className="button-secondary" onClick={() => void runTest()}>
              {t('onboarding.cloud.retry')}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                setTest({ state: 'idle' });
                fields.apiKey.current?.focus();
              }}
            >
              {t('onboarding.cloud.edit')}
            </button>
            <button type="button" className="button-secondary" onClick={nav.skip}>
              {t('onboarding.skip')}
            </button>
          </div>
        </div>
      ) : null}
      <p className="wizard-info">
        <LockIcon />
        <span>{t('onboarding.cloud.keys_stay')}</span>
      </p>
      <WizardActions
        nav={nav}
        onPrimary={() => void continueStep()}
        primaryDisabled={!alreadyAdded && !formEmpty && !formComplete}
        busy={testing}
      />
    </>
  );
}
