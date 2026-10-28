import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider.js';
import { InstallFolderPanel } from '../install/InstallFolderPanel.js';
import { AccountCard, SignInCard } from '../publish/AccountCards.js';
import { MyHarnesses } from '../publish/MyHarnesses.js';
import { NewVersion } from '../publish/NewVersion.js';
import { usePublish, type PublishTab } from '../publish/PublishProvider.js';

const TABS: readonly PublishTab[] = ['new', 'mine'];

/**
 * The Publish screen (docs/ux/screens.md, Publish; flow F5). Signed out: the GitHub sign-in card.
 * Signed in: the Publisher's account, then the tabs "New version", which validates a folder,
 * previews its listing (P0-08.1) and publishes it (P0-08.2), and "My Harnesses", their Harnesses
 * and versions with Unpublish (P0-08.3). The state lives in the PublishProvider above the
 * screens, so it survives leaving the screen. "Install this folder locally" (P0-05.1) is its own
 * panel with its own folder picker, and works signed out and offline too.
 */
export function PublishPage() {
  const { t } = useI18n();
  const { auth, loadAuth, tab, setTab } = usePublish();
  const tabs = useRef<Partial<Record<PublishTab, HTMLButtonElement | null>>>({});
  useEffect(loadAuth, [loadAuth]);

  /** Left and right arrows move between the tabs, as in every tab list. */
  const onTabKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + 1) % TABS.length] ?? 'new';
    setTab(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="publish">
      {auth === null ? null : auth.signedIn ? (
        <>
          <AccountCard
            login={auth.githubLogin}
            displayName={auth.displayName}
            avatarUrl={auth.avatarUrl}
          />
          <div className="tabs" role="tablist" aria-label={t('publish.tabs')} onKeyDown={onTabKey}>
            {TABS.map((id) => (
              <button
                key={id}
                ref={(element) => {
                  tabs.current[id] = element;
                }}
                type="button"
                role="tab"
                id={`publish-tab-${id}`}
                className="tab"
                aria-selected={tab === id}
                aria-controls={`publish-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => {
                  setTab(id);
                }}
              >
                {id === 'new' ? t('publish.tab.new') : t('publish.tab.mine')}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`publish-panel-${tab}`} aria-labelledby={`publish-tab-${tab}`}>
            {tab === 'new' ? (
              <NewVersion publisher={{ login: auth.githubLogin, avatarUrl: auth.avatarUrl }} />
            ) : (
              <MyHarnesses />
            )}
          </div>
        </>
      ) : (
        <SignInCard />
      )}
      <InstallFolderPanel />
    </div>
  );
}
