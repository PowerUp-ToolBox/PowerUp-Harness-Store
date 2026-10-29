import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionSummary, IpcError, LocalProvider } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { LM_STUDIO_DOWNLOAD_URL, OLLAMA_DOWNLOAD_URL } from '../models/LocalProvidersPanel.js';
import { providerName } from '../models/names.js';
import { useMounted } from './use-mounted.js';
import { WizardActions, type WizardNav } from './WizardActions.js';

type Detection =
  | { readonly state: 'detecting' }
  | { readonly state: 'done'; readonly found: readonly LocalProvider[] }
  | { readonly state: 'failed'; readonly error: IpcError };

export interface DetectLocalStepProps {
  readonly nav: WizardNav;
  /** The Connections this wizard run added; a Provider already among them is not added twice. */
  readonly added: readonly ConnectionSummary[];
  readonly onAdded: (connection: ConnectionSummary) => void;
}

/**
 * Looks for Ollama and LM Studio (`connections.detectLocal`) each time the step opens, and again
 * on Detect again. Every Provider found gets an Add checkbox, on by default; Continue adds the
 * checked ones, which is the User's explicit action: nothing is added before it. A Provider that
 * already has its Connection (setup run again) shows Added with no checkbox and is not added
 * again, so Continue neither re-enables a Connection the User disabled nor touches its saved base
 * URL; the Models page edits it. While the Runtime looks (at most about 1.5 seconds),
 * Continue waits and Skip stays available. When nothing is found, the step says so, links to both
 * installers and offers Detect again, instead of showing an empty list. A failed search shows its
 * error above the same links and is treated like an empty one: Continue moves on.
 */
export function DetectLocalStep({ nav, added, onAdded }: DetectLocalStepProps) {
  const { t } = useI18n();
  const [detection, setDetection] = useState<Detection>({ state: 'detecting' });
  /** Provider ids whose Add checkbox is off. */
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<IpcError | null>(null);
  const mounted = useMounted();
  /** Counts the detections started, so only the latest one's answer is shown. */
  const runs = useRef(0);

  const detect = useCallback(async () => {
    runs.current += 1;
    const run = runs.current;
    setDetection({ state: 'detecting' });
    const result = await window.api.connections.detectLocal();
    if (run !== runs.current) return;
    setDetection(
      result.ok ? { state: 'done', found: result.data } : { state: 'failed', error: result.error },
    );
  }, []);

  useEffect(() => {
    void detect();
    return () => {
      // A detection still running when the step closes answers into nothing.
      runs.current += 1;
    };
  }, [detect]);

  const toggle = (providerId: string) => {
    setUnchecked((ids) => {
      const next = new Set(ids);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

  const found = detection.state === 'done' ? detection.found : [];
  const addCheckedAndContinue = async () => {
    if (detection.state === 'detecting') return;
    const toAdd = found.filter(
      (provider) =>
        !provider.added &&
        !unchecked.has(provider.providerId) &&
        !added.some((connection) => connection.providerId === provider.providerId),
    );
    setAdding(true);
    setAddError(null);
    for (const provider of toAdd) {
      const result = await window.api.connections.add({
        providerId: provider.providerId,
        baseUrl: provider.baseUrl,
      });
      // A Connection added while the User skipped ahead still counts; the wizard does not move.
      if (result.ok) onAdded(result.data);
      if (!mounted.current) return;
      if (!result.ok) {
        setAdding(false);
        setAddError(result.error);
        return;
      }
    }
    setAdding(false);
    nav.next();
  };

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding.step.detect-local')}</h1>
      {detection.state === 'detecting' ? (
        <div className="wizard-panel" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>{t('onboarding.detect.looking')}</span>
        </div>
      ) : null}
      {detection.state === 'failed' ? <ErrorMessage error={detection.error} /> : null}
      {found.length > 0 ? (
        <>
          <p className="wizard-lead">{t('onboarding.detect.found_hint')}</p>
          <ul className="provider-list">
            {found.map((provider) => {
              const name = providerName(t, provider.providerId, provider.displayName);
              return (
                <li key={provider.providerId} className="provider-row">
                  <div className="provider-row-text">
                    <span className="provider-row-name">{name}</span>
                    <code className="provider-row-detail">
                      {[provider.baseUrl, ...provider.models].join(' · ')}
                    </code>
                  </div>
                  {provider.added ? (
                    <span className="status-chip" data-status="connected">
                      {t('onboarding.detect.added')}
                    </span>
                  ) : (
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={!unchecked.has(provider.providerId)}
                        onChange={() => {
                          toggle(provider.providerId);
                        }}
                        aria-label={t('onboarding.detect.add_named', { name })}
                      />
                      <span aria-hidden="true">{t('onboarding.detect.add')}</span>
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {detection.state !== 'detecting' && found.length === 0 ? (
        <div className="wizard-panel wizard-panel-column">
          <p>{t('onboarding.detect.none')}</p>
          <p className="wizard-links">
            <a href={OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer">
              {t('onboarding.detect.install_ollama')}
            </a>
            <a href={LM_STUDIO_DOWNLOAD_URL} target="_blank" rel="noreferrer">
              {t('onboarding.detect.install_lmstudio')}
            </a>
          </p>
          <button type="button" className="button-secondary" onClick={() => void detect()}>
            {t('onboarding.detect.again')}
          </button>
        </div>
      ) : null}
      {addError === null ? null : <ErrorMessage error={addError} />}
      <WizardActions
        nav={nav}
        onPrimary={() => void addCheckedAndContinue()}
        primaryDisabled={detection.state === 'detecting'}
        busy={adding}
      />
    </>
  );
}
