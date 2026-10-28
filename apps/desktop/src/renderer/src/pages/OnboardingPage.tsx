import { Link } from 'react-router';
import { useI18n } from '../i18n/I18nProvider.js';

// Placeholder: the first-run wizard arrives in P0-04.5. It fills the window, without the sidebar.
export function OnboardingPage() {
  const { t } = useI18n();
  return (
    <main className="onboarding">
      <h1>{t('onboarding.welcome.title')}</h1>
      <Link to="/library">{t('onboarding.skip_setup')}</Link>
    </main>
  );
}
