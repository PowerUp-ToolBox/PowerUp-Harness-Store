import { useEffect, useState } from 'react';
import type { ConnectionSummary, IpcError, LocalProvider } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { useMounted } from './use-mounted.js';
import { WizardActions, type WizardNav } from './WizardActions.js';

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
const LM_STUDIO_DOWNLOAD_URL = 'https://lmstudio.ai';

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
 * Looks for Ollama and LM Studio (`connections.detectLocal`) each time the step opens. Every
 * Provider found gets an Add checkbox, on by default; Continue adds the checked ones. While the
 * Runtime looks, Continue waits and Skip stays available. When nothing is found, the step says so
 * and links to both installers instead of showing an empty list.
 */
export function DetectLocalStep({ nav, added, onAdded }: DetectLocalStepProps) {
  const { t } = useI18n();
  const [detection, setDetection] = useState<Detection>({ state: 'detecting' });
  /** Provider ids whose Add checkbox is off. */
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<IpcError | null>(null);
  const mounted = useMounted();

  useEffect(() => {
    let current = true;
    void window.api.connections.detectLocal().then((result) => {
      if (!current) return;
      setDetection(
        result.ok
          ? { state: 'done', found: result.data }
          : { state: 'failed', error: result.error },
      );
    });
    return () => {
      current = false;
    };
  }, []);

  const toggle = (providerId: string) => {
    setUnchecked((ids) => {
      const next = new Set(ids);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  };

  const addCheckedAndContinue = async () => {
    if (detection.state !== 'done') return;
    const toAdd = detection.found.filter(
      (provider) =>
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

  const found = detection.state === 'done' ? detection.found : [];
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
            {found.map((provider) => (
              <li key={provider.providerId} className="provider-row">
                <div className="provider-row-text">
                  <span className="provider-row-name">{provider.displayName}</span>
                  <code className="provider-row-detail">
                    {[provider.baseUrl, ...provider.models].join(' · ')}
                  </code>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={!unchecked.has(provider.providerId)}
                    onChange={() => {
                      toggle(provider.providerId);
                    }}
                    aria-label={t('onboarding.detect.add_named', { name: provider.displayName })}
                  />
                  <span aria-hidden="true">{t('onboarding.detect.add')}</span>
                </label>
              </li>
            ))}
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
