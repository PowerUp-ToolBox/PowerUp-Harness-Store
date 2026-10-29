import { useConnectivity } from '../connectivity/ConnectivityProvider.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { GitHubIcon } from '../shell/icons.js';
import { usePublish } from './PublishProvider.js';

/**
 * The GitHub sign-in card, for a User who is not signed in (docs/ux/screens.md, Publish): why only
 * Publishers need an account, and Sign in with GitHub, which opens the User's browser. While the
 * browser has not come back it says so, with Cancel. After an expired session it asks to sign in
 * again, and the folder chosen for publishing stays. Signing in needs the Store: offline, the
 * button is disabled and says why.
 */
export function SignInCard() {
  const { t } = useI18n();
  const { state } = useConnectivity();
  const { signingIn, authError, sessionExpired, signIn, cancelSignIn } = usePublish();
  const offline = state === 'offline';
  return (
    <section className="publish-card publish-sign-in" aria-labelledby="publish-sign-in-title">
      <p id="publish-sign-in-title" className="publish-card-text">
        {sessionExpired ? t('publish.sessionExpired') : t('publish.signIn.explanation')}
      </p>
      {signingIn ? (
        <div className="publish-card-row" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>{t('publish.signIn.waiting')}</span>
          <button type="button" className="button-secondary" onClick={() => void cancelSignIn()}>
            {t('publish.signIn.cancel')}
          </button>
        </div>
      ) : (
        <div className="publish-card-row">
          <button
            type="button"
            className="button-primary button-github"
            disabled={offline}
            onClick={() => void signIn()}
          >
            <GitHubIcon />
            <span>{sessionExpired ? t('publish.signInAgain') : t('publish.signIn')}</span>
          </button>
          {offline ? <span className="hint">{t('publish.signIn.offline')}</span> : null}
        </div>
      )}
      {authError === null ? null : <ErrorMessage error={authError} />}
    </section>
  );
}

/**
 * The signed-in Publisher: their GitHub avatar and login, the prefix their Harness IDs must start
 * with, and Sign out (which keeps the folder chosen for publishing).
 */
export function AccountCard({
  login,
  displayName,
  avatarUrl,
}: {
  readonly login: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}) {
  const { t } = useI18n();
  const { authError, signOut } = usePublish();
  return (
    <section
      className="publish-card publish-account"
      aria-label={t('publish.signedInAs', { login })}
    >
      <div className="publish-card-row">
        {avatarUrl === null ? (
          <span className="avatar monogram" aria-hidden="true">
            {login.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img className="avatar" src={avatarUrl} alt="" />
        )}
        <div className="publish-account-text">
          <span className="publish-account-name">{t('publish.signedInAs', { login })}</span>
          {displayName === null ? null : <span className="hint">{displayName}</span>}
          <span className="hint">{t('publish.idPrefix', { prefix: `${login}/` })}</span>
        </div>
        <button type="button" className="button-secondary" onClick={() => void signOut()}>
          {t('publish.signOut')}
        </button>
      </div>
      {authError === null ? null : <ErrorMessage error={authError} />}
    </section>
  );
}
