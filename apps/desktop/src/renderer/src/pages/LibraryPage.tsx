import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { InstalledHarness } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { LibraryIcon } from '../shell/icons.js';

/**
 * The Library (docs/ux/screens.md): one card per installed Harness, the most recently launched
 * first, then by name, as `installs.list` orders them. It reloads on `installs.changed`. P0-05
 * builds the basic card (icon, name, Publisher, version, the Local badge, the primary button);
 * P0-10 adds sort and filter, the overflow menu and update states.
 */
export function LibraryPage() {
  const { t } = useI18n();
  const [installs, setInstalls] = useState<readonly InstalledHarness[] | null>(null);

  useEffect(() => {
    let current = true;
    const load = () => {
      void window.api.installs.list().then((result) => {
        if (current && result.ok) setInstalls(result.data);
      });
    };
    load();
    const unsubscribe = window.api.on('installs.changed', load);
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);

  if (installs === null) return null;
  if (installs.length === 0) {
    return (
      <div className="empty-panel library-empty">
        <LibraryIcon />
        <p className="empty-panel-title">{t('library.empty')}</p>
        <Link to="/store" className="button-primary">
          {t('library.empty.browse')}
        </Link>
      </div>
    );
  }
  return (
    <ul className="library-grid">
      {installs.map((install) => (
        <li key={install.harnessId}>
          <HarnessCard install={install} />
        </li>
      ))}
    </ul>
  );
}

function HarnessCard({ install }: { readonly install: InstalledHarness }) {
  const { t } = useI18n();
  return (
    <article className="harness-card" aria-label={install.name}>
      <div className="harness-card-header">
        {install.iconDataUrl === null ? (
          <span className="harness-icon monogram" aria-hidden="true">
            {install.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img className="harness-icon" src={install.iconDataUrl} alt="" />
        )}
        <div className="harness-card-text">
          <div className="harness-card-title">
            <h2 className="harness-card-name">{install.name}</h2>
            {install.source === 'local' ? (
              <span className="badge">{t('library.local')}</span>
            ) : null}
          </div>
          <p className="harness-card-subtitle">
            {t('library.card.subtitle', { publisher: install.publisher, version: install.version })}
          </p>
        </div>
      </div>
      <div className="harness-card-actions">
        {/* P0-05.2 starts the Harness from here. */}
        <button type="button" className="button-primary" disabled>
          {install.platformSupported ? t('library.launch') : t('library.unsupported')}
        </button>
      </div>
    </article>
  );
}
