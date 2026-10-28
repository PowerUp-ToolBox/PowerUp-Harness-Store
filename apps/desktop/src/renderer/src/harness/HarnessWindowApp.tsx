import { useEffect, useState } from 'react';
import type { HarnessWindowInfo } from '../../../shared/harness-ipc.js';
import type { IpcError, LaunchStatus, ResolvedSlot } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { LocaleProvider, useI18n } from '../i18n/I18nProvider.js';
import { TerminalView } from './TerminalView.js';
import { WebArea } from './WebArea.js';

/**
 * A Harness window's own page (docs/ux/screens.md, Harness web window chrome and Harness terminal
 * window): a thin top bar with the Harness's icon and name, one model indicator per Model Slot,
 * Reload (web) and Open logs, then the embedded terminal or the room for the web Harness's page.
 *
 * A terminal stays readable once the process has ended, and the bar shows "Exited with code N" (or
 * "Could not start") with Relaunch and Close; the window title adds the exit code. A web window
 * shows its Starting, Crashed and Timed-out states in that room ({@link WebArea}). Its text is in
 * the app's language when the window opened.
 */
export function HarnessWindowApp() {
  const [info, setInfo] = useState<HarnessWindowInfo | null>(null);
  const [status, setStatus] = useState<LaunchStatus | null>(null);
  useEffect(() => {
    let current = true;
    // Listening before asking: main does not keep the states it sends, so one sent while the
    // answer is on its way would be lost (a web Harness that exits at once, say). The answer has
    // the state when main made it, newer than any sent before it; the ones after it follow.
    const unsubscribe = window.harness.on('window.state', (next) => {
      if (current) setStatus(next);
    });
    void window.harness.window.info().then((result) => {
      if (!current || !result.ok) return;
      setInfo(result.data);
      setStatus(result.data.status);
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);
  if (info === null || status === null) return null;
  return (
    <LocaleProvider locale={info.locale}>
      <HarnessWindow info={info} status={status} />
    </LocaleProvider>
  );
}

interface HarnessWindowProps {
  readonly info: HarnessWindowInfo;
  readonly status: LaunchStatus;
}

function HarnessWindow({ info, status }: HarnessWindowProps) {
  const { t } = useI18n();
  const [error, setError] = useState<IpcError | null>(null);

  const ended = status.state === 'stopped' || status.state === 'failed';
  const terminal = info.uiKind === 'terminal';
  const { exitCode } = status;
  useEffect(() => {
    document.title =
      terminal && ended && exitCode !== undefined
        ? t('harness.title.exited', { name: info.name, code: exitCode })
        : t('harness.title', { name: info.name });
  }, [terminal, ended, exitCode, info.name, t]);

  const relaunch = async () => {
    setError(null);
    const result = await window.harness.window.relaunch();
    if (!result.ok) setError(result.error);
  };
  const openLogs = async () => {
    setError(null);
    const result = await window.harness.window.openLogs();
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
          {terminal && ended ? (
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
          {terminal ? null : (
            <button
              type="button"
              className="button-secondary"
              disabled={status.state !== 'ready'}
              onClick={() => void window.harness.web.reload()}
            >
              {t('harness.reload')}
            </button>
          )}
          <button type="button" className="button-secondary" onClick={() => void openLogs()}>
            {t('harness.openLogs')}
          </button>
          {terminal && ended ? (
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
      {/* A web window that has ended shows the error in its overlay instead. */}
      {error !== null && (terminal || !ended) ? (
        <div className="harness-bar-error">
          <ErrorMessage error={error} />
        </div>
      ) : null}
      {terminal ? (
        <TerminalView name={info.name} />
      ) : (
        <WebArea
          info={info}
          status={status}
          error={error}
          onRelaunch={() => void relaunch()}
          onOpenLogs={() => void openLogs()}
        />
      )}
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
    // A web Harness's page holds the focus in its window, so main tells this page.
    const unsubscribe = window.harness.on('window.focus', load);
    window.addEventListener('focus', load);
    return () => {
      current = false;
      unsubscribe();
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
