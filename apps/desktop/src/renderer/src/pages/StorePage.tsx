import { useI18n } from '../i18n/I18nProvider.js';

// Placeholder: Store home and search arrive in P0-09.
export function StorePage() {
  const { t } = useI18n();
  return <p className="placeholder">{t('store.placeholder')}</p>;
}
