import { NavLink, Outlet, useLocation } from 'react-router';
import { SECTIONS, sectionFor } from './sections.js';

/** The main window frame: sidebar navigation, the page title header and the current screen. */
export function Shell() {
  const { pathname } = useLocation();
  const section = sectionFor(pathname);
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        {SECTIONS.map((item) => (
          <NavLink key={item.path} to={item.path} className="sidebar-item">
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <main className="content">
        <header className="page-header">
          <h1>{section?.label}</h1>
        </header>
        <div className="page">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
