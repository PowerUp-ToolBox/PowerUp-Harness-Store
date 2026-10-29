import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { StartupStatus } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';

/**
 * Asks the Runtime how its startup went (`app.status`) before anything else renders. When opening
 * the database or starting the Model Gateway failed, the whole window shows {@link StartupError}
 * instead of the app, so the User never meets a silently broken UI.
 */
export function StartupGate({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<StartupStatus | null>(null);

  useEffect(() => {
    let current = true;
    // app.status only reads what startup recorded; were the call itself to fail, the app renders
    // and each screen shows its own IPC errors.
    const ready: StartupStatus = { state: 'ready' };
    void window.api.app.status().then(
      (result) => {
        if (current) setStatus(result.ok ? result.data : ready);
      },
      () => {
        if (current) setStatus(ready);
      },
    );
    return () => {
      current = false;
    };
  }, []);

  if (status === null) return null;
  if (status.state === 'failed') return <StartupError status={status} />;
  return children;
}

/** The blocking error screen: which step failed, the technical details, and Quit. */
function StartupError({
  status,
}: {
  readonly status: Extract<StartupStatus, { state: 'failed' }>;
}) {
  const { t } = useI18n();
  return (
    <main className="startup-error" aria-labelledby="startup-error-title">
      <div className="startup-error-card">
        <h1 id="startup-error-title">{t('startup.title')}</h1>
        <p role="alert">{t(`startup.stage.${status.stage}`)}</p>
        <p className="hint">{t('startup.hint')}</p>
        <details>
          <summary>{t('startup.details')}</summary>
          <pre>{status.detail}</pre>
        </details>
        <button type="button" className="button-primary" onClick={() => void window.api.app.quit()}>
          {t('startup.quit')}
        </button>
      </div>
    </main>
  );
}
