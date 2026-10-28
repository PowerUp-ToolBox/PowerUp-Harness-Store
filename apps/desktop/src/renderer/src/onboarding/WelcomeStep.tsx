import { useState } from 'react';
import { isLocale } from '../../../shared/i18n/locale.js';
import type { IpcError } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n, useSettings } from '../i18n/I18nProvider.js';
import { WizardActions, type WizardNav } from './WizardActions.js';

/**
 * What Harness Store is and does not do (no sandbox), and the language, prefilled from the locale
 * the UI renders in. Picking a language sets the override at once, as Settings does, so the whole
 * wizard switches before the next step.
 */
export function WelcomeStep({ nav }: { readonly nav: WizardNav }) {
  const { t, locale } = useI18n();
  const { updateSettings } = useSettings();
  const [error, setError] = useState<IpcError | null>(null);

  const changeLanguage = async (value: string) => {
    if (!isLocale(value)) return;
    const result = await updateSettings({ locale: value });
    setError(result.ok ? null : result.error);
  };

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding.welcome.tagline')}</h1>
      <p className="wizard-lead">{t('onboarding.welcome.intro')}</p>
      <p className="wizard-note">{t('onboarding.welcome.no_sandbox')}</p>
      <div className="field">
        <label htmlFor="onboarding-language">{t('onboarding.welcome.language')}</label>
        <select
          id="onboarding-language"
          value={locale}
          onChange={(event) => void changeLanguage(event.target.value)}
        >
          <option value="en">{t('language.en')}</option>
          <option value="zh-CN">{t('language.zh-CN')}</option>
        </select>
        {error === null ? null : <ErrorMessage error={error} />}
      </div>
      <WizardActions nav={nav} skipSetup />
    </>
  );
}
