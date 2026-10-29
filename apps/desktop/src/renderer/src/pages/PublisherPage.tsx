import { useParams } from 'react-router';
import { useI18n } from '../i18n/I18nProvider.js';

// Placeholder: the Publisher page arrives in P0-09.
export function PublisherPage() {
  const { t } = useI18n();
  const login = useParams().login ?? '';
  return <p className="placeholder">{t('store.publisher.placeholder', { login })}</p>;
}
