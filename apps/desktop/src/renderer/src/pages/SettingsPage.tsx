import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { isLocale } from '../../../shared/i18n/locale.js';
import {
  UPDATE_CHECK_INTERVALS,
  type AppFolder,
  type Diagnostics,
  type IpcError,
  type UpdateCheckInterval,
} from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useToast } from '../components/Toasts.js';
import { useConnectivity } from '../connectivity/ConnectivityProvider.js';
import { useI18n, useSettings } from '../i18n/I18nProvider.js';
import { useMounted } from '../onboarding/use-mounted.js';
import { offeredUpdate } from '../store/primary-action.js';
import { ClearUsageDialog } from '../usage/ClearUsageDialog.js';

// The "System" choice clears the override; the select needs a value for it.
const SYSTEM = 'system';

/**
 * The Settings screen (docs/ux/screens.md, Settings; P0-11.2): Language, Check for Harness updates
 * (interval and Check now), Data location (Open folder, Open logs folder), the Store URL under a
 * collapsed Advanced section, Re-run setup, Clear usage data and Diagnostics with Copy. Every value
 * applies the moment it changes, with no Save button; the Store URL alone waits for Apply, since
 * applying it signs the Publisher out. The diagnostics are read from the Runtime each time the
 * screen opens and again on Copy, so the Model Gateway's status is never a stale one. Re-run setup
 * only opens the wizard at its first step: it clears no setting, Connection or Slot Binding.
 */
export function SettingsPage() {
  const mounted = useMounted();
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  const loadDiagnostics = useCallback(async () => {
    const result = await window.api.diagnostics.get();
    if (mounted.current && result.ok) setDiagnostics(result.data);
  }, [mounted]);
  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  return (
    <div className="settings">
      <LanguageSection />
      <UpdatesSection />
      <DataSection dataRoot={diagnostics?.dataRoot ?? null} />
      <AdvancedSection />
      <SetupSection />
      <UsageSection />
      {diagnostics === null ? null : (
        <DiagnosticsSection diagnostics={diagnostics} onCopied={loadDiagnostics} />
      )}
    </div>
  );
}

/** System, English or 简体中文; the UI switches at once, running Harnesses keep theirs. */
function LanguageSection() {
  const { t } = useI18n();
  const { settings, updateSettings } = useSettings();
  const [error, setError] = useState<IpcError | null>(null);

  const changeLanguage = async (value: string) => {
    const result = await updateSettings({ locale: isLocale(value) ? value : null });
    setError(result.ok ? null : result.error);
  };

  return (
    <section className="settings-row">
      <label htmlFor="settings-language">{t('settings.language')}</label>
      <div className="settings-control">
        <select
          id="settings-language"
          value={settings.locale ?? SYSTEM}
          onChange={(event) => void changeLanguage(event.target.value)}
        >
          <option value={SYSTEM}>{t('settings.language.system')}</option>
          <option value="en">{t('language.en')}</option>
          <option value="zh-CN">{t('language.zh-CN')}</option>
        </select>
        <p className="hint">{t('settings.language.note')}</p>
        {error === null ? null : <ErrorMessage error={error} />}
      </div>
    </section>
  );
}

/**
 * How often the Runtime asks the Store about updates (1 hour, 6 hours, 24 hours, Never), and
 * Check now, which checks whatever the interval and is off while the Store is offline. When it is
 * done, a toast says how many installed Harnesses now have an update.
 */
function UpdatesSection() {
  const { t } = useI18n();
  const { settings, updateSettings } = useSettings();
  const { state } = useConnectivity();
  const toast = useToast();
  const mounted = useMounted();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);

  const changeInterval = async (value: string) => {
    const interval = UPDATE_CHECK_INTERVALS.find((each) => each === value);
    if (interval === undefined) return;
    const result = await updateSettings({ updateCheckInterval: interval });
    if (mounted.current) setError(result.ok ? null : result.error);
  };

  const checkNow = async () => {
    setChecking(true);
    setError(null);
    const result = await window.api.installs.checkUpdates();
    if (result.ok) {
      const installs = await window.api.installs.list();
      const count = installs.ok
        ? installs.data.filter((install) => offeredUpdate(install) !== null).length
        : 0;
      toast(t('settings.updates.checked', { count }));
    }
    if (!mounted.current) return;
    setChecking(false);
    if (!result.ok) setError(result.error);
  };

  return (
    <section className="settings-row">
      <label htmlFor="settings-updates">{t('settings.updates')}</label>
      <div className="settings-control">
        <div className="settings-inline">
          <select
            id="settings-updates"
            value={settings.updateCheckInterval}
            onChange={(event) => void changeInterval(event.target.value)}
          >
            {UPDATE_CHECK_INTERVALS.map((interval) => (
              <option key={interval} value={interval}>
                {t(INTERVAL_LABELS[interval])}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button-secondary"
            disabled={checking || state === 'offline'}
            aria-busy={checking}
            onClick={() => void checkNow()}
          >
            {checking ? <span className="spinner" aria-hidden="true" /> : null}
            {checking ? t('settings.updates.checking') : t('settings.updates.check_now')}
          </button>
        </div>
        <p className="hint">{t('settings.updates.note')}</p>
        {error === null ? null : <ErrorMessage error={error} />}
      </div>
    </section>
  );
}

const INTERVAL_LABELS = {
  '1h': 'settings.updates.1h',
  '6h': 'settings.updates.6h',
  '24h': 'settings.updates.24h',
  never: 'settings.updates.never',
} as const satisfies Record<UpdateCheckInterval, string>;

/** The app data root's path, opened in the OS file browser, and its logs folder. */
function DataSection({ dataRoot }: { readonly dataRoot: string | null }) {
  const { t } = useI18n();
  const mounted = useMounted();
  const [error, setError] = useState<IpcError | null>(null);

  const open = async (folder: AppFolder) => {
    const result = await window.api.app.openFolder(folder);
    if (mounted.current) setError(result.ok ? null : result.error);
  };

  return (
    <section className="settings-row" aria-labelledby="settings-data">
      <h2 id="settings-data" className="settings-heading">
        {t('settings.data')}
      </h2>
      <div className="settings-control">
        {dataRoot === null ? null : <code className="settings-path">{dataRoot}</code>}
        <div className="settings-inline">
          <button type="button" className="button-secondary" onClick={() => void open('dataRoot')}>
            {t('settings.data.open')}
          </button>
          <button type="button" className="button-secondary" onClick={() => void open('logs')}>
            {t('settings.data.open_logs')}
          </button>
        </div>
        {error === null ? null : <ErrorMessage error={error} />}
      </div>
    </section>
  );
}

/**
 * The Store URL, collapsed under Advanced. It is applied with Apply, not as it is typed: applying
 * signs the Publisher out of the old Store. Use default goes back to the build's Store. Main
 * checks the URL; one it refuses is explained beside the field.
 */
function AdvancedSection() {
  const { t } = useI18n();
  const { settings, updateSettings } = useSettings();
  const toast = useToast();
  const mounted = useMounted();
  const current = settings.storeBaseUrl ?? settings.defaultStoreBaseUrl;
  const [draft, setDraft] = useState(current);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);

  // A URL applied elsewhere, or Use default, shows in the field.
  useEffect(() => {
    setDraft(current);
  }, [current]);

  const apply = async (storeBaseUrl: string | null) => {
    setApplying(true);
    setError(null);
    const result = await updateSettings({ storeBaseUrl });
    if (result.ok) toast(t('settings.store_url.changed'));
    if (!mounted.current) return;
    setApplying(false);
    if (!result.ok) setError(result.error);
  };

  const invalid = error?.code === 'invalid_input';
  return (
    <details className="settings-advanced">
      <summary>{t('settings.advanced')}</summary>
      <section className="settings-row">
        <label htmlFor="settings-store-url">{t('settings.store_url')}</label>
        {/* noValidate: main checks the URL, and its refusal is explained in the UI language. */}
        <form
          className="settings-control"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void apply(draft.trim());
          }}
        >
          <input
            id="settings-store-url"
            className="settings-url"
            type="url"
            value={draft}
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby="settings-store-url-note"
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
          />
          <div className="settings-inline">
            <button
              type="submit"
              className="button-secondary"
              disabled={applying || draft.trim() === current}
              aria-busy={applying}
            >
              {applying ? t('settings.store_url.applying') : t('settings.store_url.apply')}
            </button>
            {settings.storeBaseUrl === undefined ? null : (
              <button
                type="button"
                className="button-link"
                disabled={applying}
                onClick={() => void apply(null)}
              >
                {t('settings.store_url.use_default')}
              </button>
            )}
          </div>
          <p id="settings-store-url-note" className="hint">
            {t('settings.store_url.note')}{' '}
            {t('settings.store_url.default_hint', { url: settings.defaultStoreBaseUrl })}
          </p>
          {error === null ? null : invalid ? (
            <p className="error-message" role="alert">
              {t('settings.store_url.invalid')}
            </p>
          ) : (
            <ErrorMessage error={error} />
          )}
        </form>
      </section>
    </details>
  );
}

/** Opens the first-run wizard at Welcome, keeping every Connection and Slot Binding. */
function SetupSection() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <section className="settings-row" aria-labelledby="settings-setup">
      <h2 id="settings-setup" className="settings-heading">
        {t('settings.setup')}
      </h2>
      <div className="settings-control">
        <button
          type="button"
          className="button-secondary"
          onClick={() => void navigate('/onboarding')}
        >
          {t('settings.setup.rerun')}
        </button>
        <p className="hint">{t('settings.setup.note')}</p>
      </div>
    </section>
  );
}

/** Clear usage data, through the Usage page's own confirmation. */
function UsageSection() {
  const { t } = useI18n();
  const [clearing, setClearing] = useState(false);
  return (
    <section className="settings-row" aria-labelledby="settings-usage">
      <h2 id="settings-usage" className="settings-heading">
        {t('settings.usage')}
      </h2>
      <div className="settings-control">
        <button
          type="button"
          className="button-secondary button-secondary-danger"
          onClick={() => {
            setClearing(true);
          }}
        >
          {t('usage.clear')}
        </button>
        <p className="hint">{t('settings.usage.note')}</p>
      </div>
      {clearing ? (
        <ClearUsageDialog
          onClose={() => {
            setClearing(false);
          }}
          onCleared={() => undefined}
        />
      ) : null}
    </section>
  );
}

/**
 * Read-only facts for support and debugging: app version, the Model Gateway's port and whether it
 * answers now, the bundled Node, the data root and the database file. Copy diagnostics has main
 * put them on the clipboard as plain text; the block is read again afterwards.
 */
function DiagnosticsSection({
  diagnostics,
  onCopied,
}: {
  readonly diagnostics: Diagnostics;
  readonly onCopied: () => Promise<void>;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const mounted = useMounted();
  const [error, setError] = useState<IpcError | null>(null);
  const { gateway } = diagnostics;

  const copy = async () => {
    const result = await window.api.diagnostics.copy();
    if (result.ok) toast(t('settings.diagnostics.copied'));
    if (!mounted.current) return;
    setError(result.ok ? null : result.error);
    await onCopied();
  };

  return (
    <section className="settings-row" aria-labelledby="settings-diagnostics">
      <h2 id="settings-diagnostics" className="settings-heading">
        {t('settings.diagnostics')}
      </h2>
      <div className="settings-control">
        <dl className="diagnostics">
          <dt>{t('settings.diagnostics.version')}</dt>
          <dd>{diagnostics.version}</dd>
          <dt>{t('settings.diagnostics.gateway')}</dt>
          <dd>
            <span
              className="status-dot"
              data-running={gateway.running && gateway.reachable}
              aria-hidden="true"
            />
            {!gateway.running
              ? t('settings.diagnostics.gateway.stopped')
              : gateway.reachable
                ? t('settings.diagnostics.gateway.running', { port: gateway.port })
                : t('settings.diagnostics.gateway.unreachable', { port: gateway.port })}
          </dd>
          <dt>{t('settings.diagnostics.node')}</dt>
          <dd>{diagnostics.nodeVersion}</dd>
          <dt>{t('settings.diagnostics.data_root')}</dt>
          <dd>
            <code>{diagnostics.dataRoot}</code>
          </dd>
          <dt>{t('settings.diagnostics.database')}</dt>
          <dd>
            <code>{diagnostics.databasePath}</code>
          </dd>
        </dl>
        <button type="button" className="button-secondary" onClick={() => void copy()}>
          {t('settings.diagnostics.copy')}
        </button>
        {error === null ? null : <ErrorMessage error={error} />}
      </div>
    </section>
  );
}
