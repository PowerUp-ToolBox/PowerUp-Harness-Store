import { useEffect } from 'react';
import { InstallFolderPanel } from '../install/InstallFolderPanel.js';
import { AccountCard, SignInCard } from '../publish/AccountCards.js';
import { NewVersion } from '../publish/NewVersion.js';
import { usePublish } from '../publish/PublishProvider.js';

/**
 * The Publish screen (docs/ux/screens.md, Publish; flow F5). Signed out: the GitHub sign-in card.
 * Signed in: the Publisher's account and "New version", which validates a folder and previews its
 * listing (P0-08.1); the upload (P0-08.2) and My Harnesses (P0-08.3) come next. The state lives
 * in the PublishProvider above the screens, so it survives leaving the screen. "Install this
 * folder locally" (P0-05.1) is its own panel with its own folder picker, and works signed out and
 * offline too.
 */
export function PublishPage() {
  const { auth, loadAuth } = usePublish();
  useEffect(loadAuth, [loadAuth]);
  return (
    <div className="publish">
      {auth === null ? null : auth.signedIn ? (
        <>
          <AccountCard
            login={auth.githubLogin}
            displayName={auth.displayName}
            avatarUrl={auth.avatarUrl}
          />
          <NewVersion publisher={{ login: auth.githubLogin, avatarUrl: auth.avatarUrl }} />
        </>
      ) : (
        <SignInCard />
      )}
      <InstallFolderPanel />
    </div>
  );
}
