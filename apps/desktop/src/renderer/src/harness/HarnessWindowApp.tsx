import { useEffect, useState } from 'react';
import type { HarnessWindowInfo } from '../../../shared/harness-ipc.js';
import type { IpcError, LaunchStatus, ResolvedSlot } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { LocaleProvider, useI18n } from '../i18n/I18nProvider.js';
import { TerminalView } from './TerminalView.js';

/**
 * A Harness window's own page (docs/ux/screens.md, Harness terminal window): a thin top bar with
 * the Harness's icon and name, one model indicator per Model Slot and Open logs, then the embedded
 * terminal. Once the process has ended, the terminal stays readable and the bar shows "Exited with
 * code N" (or "Could not start") with Relaunch and Close; the window title adds the exit code. Its
 * text is in the app's language when the window opened.
 */
export function HarnessWindowApp() {
  const [info, setInfo] = useState<HarnessWindowInfo | null>(null);
  useEffect(() => {
    let current = true;
    void window.harness.window.info().then((result) => {
      if (current && result.ok) setInfo(result.data);
    });
    return () => {
      current = false;
    };
  }, []);
  if (info === null) return null;
  return (
    <LocaleProvider locale={info.locale}>
      <HarnessWindow info={info} />
    </LocaleProvider>
  );
}

function HarnessWindow({ info }: { readonly info: HarnessWindowInfo }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<LaunchStatus>(info.status);
  const [error, setError] = useState<IpcError | null>(null);
  useEffect(() => window.harness.on('window.state', setStatus), []);

  const ended = status.state === 'stopped' || status.state === 'failed';
  const { exitCode } = status;
  useEffect(() => {
    document.title =
      ended && exitCode !== undefined
        ? t('harness.title.exited', { name: info.name, code: exitCode })
        : t('harness.title', { name: info.name });
  }, [ended, exitCode, info.name, t]);

  const relaunch = async () => {
    setError(null);
    const result = await window.harness.window.relaunch();
    if (!result.ok) setError(result.error);
  };

  return (
    <div className="harness-window">
      <header className="harness-bar">
        {info.iconDataUrl === null ? (
          <span className="harness-bar-icon monogram" aria-hidden="true">
            {info.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img className="harness-bar-icon" src={info.iconDataUrl} alt="" />
        )}
        <span className="harness-bar-name">{info.name}</span>
        <ModelIndicator name={info.name} />
        <div className="harness-bar-actions">
          {ended ? (
            <span
              className={
                status.state === 'failed' ? 'harness-bar-status failed' : 'harness-bar-status'
              }
              role="status"
            >
              {exitCode === undefined
                ? t('harness.couldNotStart')
                : t('harness.exited', { code: exitCode })}
            </span>
          ) : null}
          <button
            type="button"
            className="button-secondary"
            onClick={() => void window.harness.window.openLogs()}
          >
            {t('harness.openLogs')}
          </button>
          {ended ? (
            <>
              <button type="button" className="button-primary" onClick={() => void relaunch()}>
                {t('harness.relaunch')}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => void window.harness.window.close()}
              >
                {t('harness.close')}
              </button>
            </>
          ) : null}
        </div>
      </header>
      {error === null ? null : (
        <div className="harness-bar-error">
          <ErrorMessage error={error} />
        </div>
      )}
      {info.uiKind === 'terminal' ? <TerminalView name={info.name} /> : null}
    </div>
  );
}

/**
 * One chip per Model Slot with the model it resolves to now, read again whenever the window gains
 * focus (the User may have changed it on the Models page meanwhile). A chip opens the Models page at
 * this Harness's card in the main window.
 */
function ModelIndicator({ name }: { readonly name: string }) {
  const { t } = useI18n();
  const [slots, setSlots] = useState<readonly ResolvedSlot[]>([]);
  useEffect(() => {
    let current = true;
    const load = () => {
      void window.harness.window.slots().then((result) => {
        if (current && result.ok) setSlots(result.data);
      });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      current = false;
      window.removeEventListener('focus', load);
    };
  }, []);
  return (
    <div className="harness-bar-models">
      {slots.map(({ slot, binding }) => (
        <button
          key={slot}
          type="button"
          className="model-chip"
          title={t('harness.model.open', { name })}
          onClick={() => void window.harness.window.openModels()}
        >
          {binding === null
            ? t('harness.model.notSet', { slot })
            : t('harness.model', { slot, model: binding.model })}
        </button>
      ))}
    </div>
  );
}
