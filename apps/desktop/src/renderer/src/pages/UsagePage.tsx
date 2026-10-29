import { useI18n } from '../i18n/I18nProvider.js';

// Placeholder: Usage arrives in P0-11.
export function UsagePage() {
  const { t } = useI18n();
  return <p className="placeholder">{t('usage.placeholder')}</p>;
}
