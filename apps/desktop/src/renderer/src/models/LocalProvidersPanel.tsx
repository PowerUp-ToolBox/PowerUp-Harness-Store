import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionSummary, IpcError, LocalProvider } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { monogram, providerName } from './names.js';

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
export const LM_STUDIO_DOWNLOAD_URL = 'https://lmstudio.ai';

type Detection =
  | { readonly state: 'detecting' }
  | { readonly state: 'done'; readonly found: readonly LocalProvider[] }
  | { readonly state: 'failed'; readonly error: IpcError };

export interface LocalProvidersPanelProps {
  /** The saved Connections: a detected Provider that has one shows Added instead of Add. */
  readonly connections: readonly ConnectionSummary[];
  /** After an Add saved its Connection, so the page lists it. */
  readonly onAdded: () => void;
}

/**
 * Local Provider detection on the Models page: it looks for Ollama and LM Studio
 * (`connections.detectLocal`) when the page opens and on Detect again, never in the background.
 * Each Provider found shows where it answered and its models, with an Add button; nothing is
 * added until the User clicks it. One that already has its Connection shows Added, so its saved
 * base URL is never replaced by the one detected. While the Runtime looks (at most about 1.5
 * seconds), the panel says so; when nothing is found, it explains what Ollama and LM Studio are and
 * links to both installers.
 */
export function LocalProvidersPanel({ connections, onAdded }: LocalProvidersPanelProps) {
  const { t } = useI18n();
  const [detection, setDetection] = useState<Detection>({ state: 'detecting' });
  /** The Provider whose Add is running. */
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<IpcError | null>(null);
  /** Counts the detections started, so only the latest one's answer is shown. */
  const runs = useRef(0);

  const detect = useCallback(async () => {
    runs.current += 1;
    const run = runs.current;
    setDetection({ state: 'detecting' });
    setAddError(null);
    const result = await window.api.connections.detectLocal();
    if (run !== runs.current) return;
    setDetection(
      result.ok ? { state: 'done', found: result.data } : { state: 'failed', error: result.error },
    );
  }, []);

  useEffect(() => {
    void detect();
    return () => {
      // A detection still running when the page closes answers into nothing.
      runs.current += 1;
    };
  }, [detect]);

  const add = async (provider: LocalProvider) => {
    setAdding(provider.providerId);
    setAddError(null);
    const result = await window.api.connections.add({
      providerId: provider.providerId,
      baseUrl: provider.baseUrl,
    });
    setAdding(null);
    if (result.ok) onAdded();
    else setAddError(result.error);
  };

  const found = detection.state === 'done' ? detection.found : [];
  return (
    <div className="local-panel" role="group" aria-labelledby="models-local">
      <div className="local-panel-header">
        <h3 id="models-local">{t('models.local.title')}</h3>
        <button
          type="button"
          className="button-secondary"
          disabled={detection.state === 'detecting'}
          onClick={() => void detect()}
        >
          {t('models.local.detect_again')}
        </button>
      </div>
      {detection.state === 'detecting' ? (
        <p className="local-panel-status" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>{t('onboarding.detect.looking')}</span>
        </p>
      ) : null}
      {detection.state === 'failed' ? <ErrorMessage error={detection.error} /> : null}
      {found.length > 0 ? (
        <ul className="provider-list">
          {found.map((provider) => {
            const name = providerName(t, provider.providerId, provider.displayName);
            const added = connections.some(
              (connection) => connection.providerId === provider.providerId,
            );
            return (
              <li key={provider.providerId} className="provider-row">
                <span className="monogram" aria-hidden="true">
                  {monogram(name)}
                </span>
                <div className="provider-row-text">
                  <span className="provider-row-name">{name}</span>
                  <code className="provider-row-detail">
                    {[provider.baseUrl, ...provider.models].join(' · ')}
                  </code>
                </div>
                {added ? (
                  <span className="status-chip" data-status="connected">
                    {t('models.local.added')}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="button-primary"
                    aria-label={t('models.local.add_named', { name })}
                    disabled={adding !== null}
                    aria-busy={adding === provider.providerId}
                    onClick={() => void add(provider)}
                  >
                    {adding === provider.providerId
                      ? t('models.local.adding')
                      : t('models.local.add')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      {detection.state !== 'detecting' && found.length === 0 ? (
        <div className="empty-panel">
          <p>{t('models.local.none')}</p>
          <p className="install-links">
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
    </div>
  );
}
