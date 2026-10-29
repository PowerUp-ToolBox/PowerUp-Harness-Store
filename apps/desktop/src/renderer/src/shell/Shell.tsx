import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { ToastProvider } from '../components/Toasts.js';
import { useConnectivity } from '../connectivity/ConnectivityProvider.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { InstallJobsProvider } from '../install/InstallJobsProvider.js';
import { PublishProvider } from '../publish/PublishProvider.js';
import { offeredUpdate } from '../store/primary-action.js';
import { StoreSearchProvider } from '../store/StoreSearchProvider.js';
import { OfflineIcon } from './icons.js';
import { SECTIONS, sectionFor } from './sections.js';

/**
 * The main window frame: sidebar navigation, the offline banner while the Store is unreachable,
 * the page title header, the current screen and the toast area. The Publish flow's state, the
 * Store search's and the Store installs' live here, above the screens, so they outlast a visit to
 * another screen; a Store install's consent dialog and the update prompt open over whichever
 * screen is shown. The Library item carries a badge with the number of installed Harnesses that
 * have an update (docs/ux/screens.md, main window shell).
 */
export function Shell() {
  const { t } = useI18n();
  const { state } = useConnectivity();
  const { pathname } = useLocation();
  const section = sectionFor(pathname);
  const updates = useUpdateCount();
  return (
    <div className="shell">
      <nav className="sidebar" aria-label={t('nav.label')}>
        {SECTIONS.map((item) => (
          <NavLink key={item.path} to={item.path} className="sidebar-item">
            {item.icon}
            <span>{t(item.labelKey)}</span>
            {item.path === '/library' && updates > 0 ? (
              <span
                className="nav-badge"
                role="img"
                aria-label={t('nav.updates', { count: updates })}
              >
                {updates}
              </span>
            ) : null}
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

/**
 * How many installed Harnesses have an update the update check found: `installs.list`, read again
 * on `installs.changed`.
 */
function useUpdateCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let current = true;
    const load = () => {
      void window.api.installs.list().then((result) => {
        if (current && result.ok) {
          setCount(result.data.filter((install) => offeredUpdate(install) !== null).length);
        }
      });
    };
    load();
    const unsubscribe = window.api.on('installs.changed', load);
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  return count;
}
