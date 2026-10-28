import { useEffect, useState } from 'react';
import { isLocale } from '../../../shared/i18n/locale.js';
import type { IpcError } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n, useSettings } from '../i18n/I18nProvider.js';

// The "System" choice clears the override; the select needs a value for it.
const SYSTEM = 'system';

// Language arrives here in P0-04.2, diagnostics in P0-04.3, the rest of the screen in P0-11. The
// version line comes from the Runtime over IPC (`app.ping`).
export function SettingsPage() {
  const { t } = useI18n();
  const { settings, updateSettings } = useSettings();
  const [error, setError] = useState<IpcError | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void window.api.app.ping().then((result) => {
      if (current && result.ok) setVersion(result.data.version);
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
      {version === null ? null : (
        <p className="placeholder">{t('settings.version', { version })}</p>
      )}
    </div>
  );
}
