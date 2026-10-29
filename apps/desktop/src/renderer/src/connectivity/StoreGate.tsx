import { Outlet } from 'react-router';
import { useI18n } from '../i18n/I18nProvider.js';
import { OfflineIcon } from '../shell/icons.js';
import { useConnectivity } from './ConnectivityProvider.js';

/**
 * The layout of every `/store*` route: the Store screen, or the offline panel while the Store is
 * unreachable. Only Store routes are gated; Library, Models, Publish, Usage and Settings never
 * wait for the Store. When a Retry succeeds, the Store screen mounts afresh and loads its data
 * again.
 */
export function StoreGate() {
  const { state } = useConnectivity();
  return state === 'offline' ? <OfflinePanel /> : <Outlet />;
}

/** "Can't reach the Store", a hint, and Retry, which re-checks and shows a spinner meanwhile. */
function OfflinePanel() {
  const { t } = useI18n();
  const { checking, retry } = useConnectivity();
  return (
    <section className="offline-panel" aria-labelledby="offline-panel-title">
      <OfflineIcon />
      <h2 id="offline-panel-title">{t('connectivity.store_unreachable')}</h2>
      <p className="hint">{t('connectivity.store_unreachable.hint')}</p>
      <button
        type="button"
        className="button-primary"
        disabled={checking}
        aria-busy={checking}
        onClick={() => void retry()}
      >
        {checking ? <span className="spinner" aria-hidden="true" /> : null}
        {t('connectivity.retry')}
      </button>
    </section>
  );
}
