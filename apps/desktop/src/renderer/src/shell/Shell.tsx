import { NavLink, Outlet, useLocation } from 'react-router';
import { useI18n } from '../i18n/I18nProvider.js';
import { SECTIONS, sectionFor } from './sections.js';

/** The main window frame: sidebar navigation, the page title header and the current screen. */
export function Shell() {
  const { t } = useI18n();
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
        <header className="page-header">
          <h1>{section === undefined ? null : t(section.labelKey)}</h1>
        </header>
        <div className="page">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
