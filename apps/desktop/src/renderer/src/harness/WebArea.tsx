import { useEffect, useRef, useState } from 'react';
import type { HarnessWindowInfo } from '../../../shared/harness-ipc.js';
import type { IpcError, LaunchState, LaunchStatus } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';

/** The states before a web Harness's page is shown. */
const STARTING: readonly LaunchState[] = ['preparing', 'spawning', 'waiting-ready'];

interface WebAreaProps {
  readonly info: HarnessWindowInfo;
  readonly status: LaunchStatus;
  /** Why the last Relaunch was refused. */
  readonly error: IpcError | null;
  readonly onRelaunch: () => void;
}

/**
 * The room under the top bar of a web Harness window (docs/ux/screens.md, Harness web window
 * chrome). Main lays the Harness's own page over it once its port accepts connections, so this
 * page reports where the room is whenever it changes. Before that it shows Starting ("Starting
 * {name}…" with the seconds since the launch began and Cancel, which closes the window and so
 * stops the Harness); once the process has ended, main takes the page away and it shows why:
 * Crashed with the exit code, Timed out with the last lines of the log, or Could not start, each
 * with Show logs, Relaunch and Close. A Harness that quit with code 0 by itself shows the same
 * actions under a plain "{name} has exited", not Crashed.
 */
export function WebArea({ info, status, error, onRelaunch }: WebAreaProps) {
  const room = useRef<HTMLDivElement>(null);
  const [wasReady, setWasReady] = useState(status.state === 'ready');
  if (status.state === 'ready' && !wasReady) setWasReady(true);

  useEffect(() => {
    const element = room.current;
    if (element === null) return;
    const report = () => {
      const { left, top, width, height } = element.getBoundingClientRect();
      void window.harness.web.layout({
        x: Math.max(0, left),
        y: Math.max(0, top),
        width: Math.max(0, width),
        height: Math.max(0, height),
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, []);

  const ended = status.state === 'stopped' || status.state === 'failed';
  // A launch that timed out is stopped before it fails: it is still starting for the User.
  const starting = STARTING.includes(status.state) || (status.state === 'stopping' && !wasReady);
  return (
    <div ref={room} className="harness-web">
      {starting ? <Starting name={info.name} startedAt={status.startedAt} /> : null}
      {ended ? <Ended info={info} status={status} error={error} onRelaunch={onRelaunch} /> : null}
    </div>
  );
}

function Starting({ name, startedAt }: { readonly name: string; readonly startedAt: string }) {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(() => secondsSince(startedAt));
  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(secondsSince(startedAt));
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [startedAt]);
  return (
    <div className="harness-overlay" role="status">
      <span className="harness-overlay-spinner" aria-hidden="true" />
      <span className="harness-overlay-title">{t('harness.starting', { name })}</span>
      <span className="harness-overlay-elapsed">{t('harness.elapsed', { seconds })}</span>
      <div className="harness-overlay-actions">
        <button
          type="button"
          className="button-secondary"
          onClick={() => void window.harness.window.close()}
        >
          {t('harness.cancel')}
        </button>
      </div>
    </div>
  );
}

/** Whole seconds from `startedAt` (ISO-8601) until now. */
function secondsSince(startedAt: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
}

function Ended({ info, status, error, onRelaunch }: WebAreaProps) {
  const { t } = useI18n();
  const { name } = info;
  const failed = status.state === 'failed';
  const timedOut = failed && status.reason === 'ready_timeout';
  // `stopped` here is an exit with code 0 nobody asked for (a stop that was asked for closes the
  // window): the Harness quit, it did not crash.
  const title = timedOut
    ? t('harness.timedOut', { name })
    : !failed
      ? t('harness.ended', { name })
      : status.exitCode === undefined
        ? t('harness.failedToStart', { name })
        : t('harness.crashed', { name });
  const tail = status.logTail ?? [];
  return (
    <div className="harness-overlay" role="alert">
      <span className="harness-overlay-title">{title}</span>
      {timedOut ? (
        <>
          <span>{t('harness.timedOut.detail', { seconds: info.readyTimeoutSeconds ?? 30 })}</span>
          {tail.length === 0 ? (
            <span className="harness-overlay-elapsed">{t('harness.timedOut.noOutput')}</span>
          ) : (
            <pre
              className="harness-log-tail"
              tabIndex={0}
              aria-label={t('harness.timedOut.log', { name })}
            >
              {tail.join('\n')}
            </pre>
          )}
        </>
      ) : status.exitCode === undefined ? null : (
        <code className="harness-overlay-code">
          {t('harness.exitCode', { code: status.exitCode })}
        </code>
      )}
      <div className="harness-overlay-actions">
        <button
          type="button"
          className="button-secondary"
          onClick={() => void window.harness.window.openLogs()}
        >
          {t('harness.showLogs')}
        </button>
        <button type="button" className="button-primary" onClick={onRelaunch}>
          {t('harness.relaunch')}
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={() => void window.harness.window.close()}
        >
          {t('harness.close')}
        </button>
      </div>
      {error === null ? null : <ErrorMessage error={error} />}
    </div>
  );
}
