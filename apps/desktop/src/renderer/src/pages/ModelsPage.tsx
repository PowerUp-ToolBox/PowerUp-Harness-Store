import { useI18n } from '../i18n/I18nProvider.js';

// Placeholder: Connections and Slot Bindings arrive in P0-03.
export function ModelsPage() {
  const { t } = useI18n();
  return <p className="placeholder">{t('models.placeholder')}</p>;
}
