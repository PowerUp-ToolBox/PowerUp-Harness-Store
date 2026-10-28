import { useI18n } from '../i18n/I18nProvider.js';

// Placeholder: the Publish flow arrives in P0-08.
export function PublishPage() {
  const { t } = useI18n();
  return <p className="placeholder">{t('publish.placeholder')}</p>;
}
