import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { isLocale } from '../../../shared/i18n/locale.js';
import type { Diagnostics, IpcError } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n, useSettings } from '../i18n/I18nProvider.js';

// The "System" choice clears the override; the select needs a value for it.
const SYSTEM = 'system';

// Language arrives here in P0-04.2, diagnostics in P0-04.3, Re-run setup in P0-04.5, the rest of
// the screen in P0-11. The diagnostics are read from the Runtime (`diagnostics.get`) each time the
// screen opens. Re-run setup only opens the wizard at its first step: it clears no setting,
// Connection or Slot Binding.
export function SettingsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { settings, updateSettings } = useSettings();
  const [error, setError] = useState<IpcError | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);

  useEffect(() => {
    let current = true;
    void window.api.diagnostics.get().then((result) => {
      if (current && result.ok) setDiagnostics(result.data);
    });
    return () => {
      current = false;
    };
  }, []);

  const changeLanguage = async (value: string) => {
    const result = await updateSettings({ locale: isLocale(value) ? value : null });
    setError(result.ok ? null : result.error);
  };

  return (
    <div className="settings">
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
      {diagnostics === null ? null : <DiagnosticsSection diagnostics={diagnostics} />}
    </div>
  );
}

/** Read-only facts for support and debugging: app version, Model Gateway, database file. */
function DiagnosticsSection({ diagnostics }: { readonly diagnostics: Diagnostics }) {
  const { t } = useI18n();
  const { gateway } = diagnostics;
  return (
    <section className="settings-row" aria-labelledby="settings-diagnostics">
      <h2 id="settings-diagnostics" className="settings-heading">
        {t('settings.diagnostics')}
      </h2>
      <dl className="diagnostics">
        <dt>{t('settings.diagnostics.version')}</dt>
        <dd>{diagnostics.version}</dd>
        <dt>{t('settings.diagnostics.gateway')}</dt>
        <dd>
          <span className="status-dot" data-running={gateway.running} aria-hidden="true" />
          {gateway.running
            ? t('settings.diagnostics.gateway.running', { port: gateway.port })
            : t('settings.diagnostics.gateway.stopped')}
        </dd>
        <dt>{t('settings.diagnostics.database')}</dt>
        <dd>
          <code>{diagnostics.databasePath}</code>
        </dd>
      </dl>
    </section>
  );
}
