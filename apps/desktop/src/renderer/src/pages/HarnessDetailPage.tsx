import { useParams } from 'react-router';
import { useI18n } from '../i18n/I18nProvider.js';

// Placeholder: the Harness detail page arrives in P0-09. The splat holds the Harness ID
// (`publisher/slug`).
export function HarnessDetailPage() {
  const { t } = useI18n();
  const harnessId = useParams()['*'] ?? '';
  return <p className="placeholder">{t('store.harness.placeholder', { harnessId })}</p>;
}
