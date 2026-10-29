import { useLocation, useNavigate } from 'react-router';
import { useI18n } from '../i18n/I18nProvider.js';

/**
 * Back where the User came from in the app, or the Store home for a page opened directly: the
 * Store's detail and Publisher pages. The Store's search keeps its text, tags and platform toggle.
 */
export function BackButton() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <button
      type="button"
      className="button-link page-back"
      onClick={() => {
        // The first entry of the app's history has the key `default`: there is nothing to go back to.
        if (location.key === 'default') void navigate('/store');
        else void navigate(-1);
      }}
    >
      {t('store.detail.back')}
    </button>
  );
}
