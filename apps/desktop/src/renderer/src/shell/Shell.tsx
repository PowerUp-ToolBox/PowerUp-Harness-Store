import { NavLink, Outlet, useLocation } from 'react-router';
import { useConnectivity } from '../connectivity/ConnectivityProvider.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { PublishProvider } from '../publish/PublishProvider.js';
import { StoreSearchProvider } from '../store/StoreSearchProvider.js';
import { OfflineIcon } from './icons.js';
import { SECTIONS, sectionFor } from './sections.js';

/**
 * The main window frame: sidebar navigation, the offline banner while the Store is unreachable,
 * the page title header and the current screen. The Publish flow's state and the Store search's
 * live here, above the screens, so they outlast a visit to another screen.
 */
export function Shell() {
  const { t } = useI18n();
  const { state } = useConnectivity();
  const { pathname } = useLocation();
  const section = sectionFor(pathname);
  return (
    <div className="shell">
      <nav className="sidebar" aria-label={t('nav.label')}>
        {SECTIONS.map((item) => (
          <NavLink key={item.path} to={item.path} className="sidebar-item">
            {item.icon}
            <span>{t(item.labelKey)}</span>
          </NavLink>
        ))}
      </nav>
      <main className="content">
        {state === 'offline' ? (
          <div className="offline-banner" role="status">
            <OfflineIcon />
            <span>{t('connectivity.offline_banner')}</span>
          </div>
        ) : null}
        <header className="page-header">
          <h1>{section === undefined ? null : t(section.labelKey)}</h1>
        </header>
        <div className="page">
          <PublishProvider>
            <StoreSearchProvider>
              <Outlet />
            </StoreSearchProvider>
          </PublishProvider>
        </div>
      </main>
    </div>
  );
}
