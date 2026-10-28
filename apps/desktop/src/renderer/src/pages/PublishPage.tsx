import { useEffect, useState } from 'react';
import type { AuthState, IpcError } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';

// Placeholder: the Publish flow arrives in P0-08. Until then the screen only exercises the Store
// sign-in of P0-07.2 (`auth.*`), the only screen that shows it (docs/ux/flows.md, F5): sign in
// with GitHub in the browser, see the login, sign out. P0-08.1 builds the real sign-in card.
export function PublishPage() {
  const { t } = useI18n();
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);

  useEffect(() => {
    let current = true;
    void window.api.auth.whoami().then((result) => {
      if (current && result.ok) setAuth(result.data);
    });
    const unsubscribe = window.api.on('auth.changed', (change) => {
      setAuth(change.signedIn ? change : { signedIn: false });
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);

  const signIn = async () => {
    setSigningIn(true);
    setError(null);
    const result = await window.api.auth.signIn();
    setSigningIn(false);
    if (result.ok) setAuth(result.data);
    else setError(result.error);
  };

  const signOut = async () => {
    setError(null);
    const result = await window.api.auth.signOut();
    if (result.ok) setAuth(result.data);
    else setError(result.error);
  };

  return (
    <div className="publish">
      {auth === null ? null : auth.signedIn ? (
        <section className="publish-account">
          <p>{t('publish.signedInAs', { login: auth.githubLogin })}</p>
          <button type="button" className="button-secondary" onClick={() => void signOut()}>
            {t('publish.signOut')}
          </button>
        </section>
      ) : (
        <section className="publish-account">
          <p className="hint">{t('publish.signIn.explanation')}</p>
          <button
            type="button"
            className="button-primary"
            disabled={signingIn}
            onClick={() => void signIn()}
          >
            {signingIn ? t('publish.signIn.waiting') : t('publish.signIn')}
          </button>
        </section>
      )}
      {error === null ? null : <ErrorMessage error={error} />}
      <p className="placeholder">{t('publish.placeholder')}</p>
    </div>
  );
}
