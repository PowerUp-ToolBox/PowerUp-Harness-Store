import { useI18n } from '../i18n/I18nProvider.js';

// Placeholder: the Library screen arrives in P0-10.
export function LibraryPage() {
  const { t } = useI18n();
  return <p className="placeholder">{t('library.placeholder')}</p>;
}
