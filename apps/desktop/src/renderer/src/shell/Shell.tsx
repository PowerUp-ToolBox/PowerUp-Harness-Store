import { NavLink, Outlet, useLocation } from 'react-router';
import { ToastProvider } from '../components/Toasts.js';
import { useConnectivity } from '../connectivity/ConnectivityProvider.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { InstallJobsProvider } from '../install/InstallJobsProvider.js';
import { PublishProvider } from '../publish/PublishProvider.js';
import { StoreSearchProvider } from '../store/StoreSearchProvider.js';
import { OfflineIcon } from './icons.js';
import { SECTIONS, sectionFor } from './sections.js';

/**
 * The main window frame: sidebar navigation, the offline banner while the Store is unreachable,
 * the page title header, the current screen and the toast area. The Publish flow's state, the
 * Store search's and the Store installs' live here, above the screens, so they outlast a visit to
 * another screen; a Store install's consent dialog opens over whichever screen is shown.
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
          <ToastProvider>
            <PublishProvider>
              <InstallJobsProvider>
                <StoreSearchProvider>
                  <Outlet />
                </StoreSearchProvider>
              </InstallJobsProvider>
            </PublishProvider>
          </ToastProvider>
        </div>
      </main>
    </div>
  );
}
