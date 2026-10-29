import { useEffect, useId, useRef, useState } from 'react';
import type { IpcError, ReportInfo } from '../../../shared/ipc.js';
import {
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASONS,
  isContactEmail,
  reportDetails,
  type ReportReason,
} from '../../../shared/report.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { Modal } from '../components/Modal.js';
import { useToast } from '../components/Toasts.js';
import { useI18n } from '../i18n/I18nProvider.js';

/** The Harness a Report is about, as the place the dialog was opened from knows it. */
export interface ReportTarget {
  readonly harnessId: string;
  readonly name: string;
  /**
   * The Harness Version reported: the installed one from a Library card, the one the detail page
   * shows from there; null for the whole Harness.
   */
  readonly version: string | null;
}

export interface ReportDialogProps {
  readonly target: ReportTarget;
  /** Cancel, Close, Escape, and the Report sent. */
  readonly onClose: () => void;
}

/** What `store.reportInfo` answered: `loading` until it does. */
type Info =
  | { readonly status: 'loading' }
  | { readonly status: 'known'; readonly info: ReportInfo }
  | { readonly status: 'failed'; readonly error: IpcError };

/** What a call that never reached the Runtime shows. */
const UNANSWERED: IpcError = {
  code: 'internal_error',
  messageKey: 'error.internal_error',
  message: 'Something went wrong inside Harness Store.',
};

/**
 * The Report dialog (docs/ux/flows.md F8), from a detail page's Report link and a Library card's
 * menu: a reason (one per `report_reason` value, none preselected; Submit waits for one),
 * optional details with the characters left, an optional contact email (sent at the start of the
 * details), and, before Submit, everything else that is sent: the Harness ID, the version, the
 * platform, the app version and the random install ID, read from main each time the dialog opens
 * (`store.reportInfo`). No account is needed and none is sent.
 *
 * Submit calls `store.report` once. Once the Store took the Report, the toast "Thanks, a reviewer
 * will look at this." shows and the dialog closes. Any other answer keeps everything typed: the
 * Store's rate limit (or this install's: 3 Reports of a Harness in 24 hours, which the dialog
 * already knows when it opens and then never calls `store.report`) is the gentle "You've already
 * reported this Harness recently" with only Close; every other error shows under the form, and
 * Submit becomes Retry.
 */
export function ReportDialog({ target, onClose }: ReportDialogProps) {
  const { t } = useI18n();
  const toast = useToast();
  const ids = useId();
  const { harnessId, name, version } = target;
  const [info, setInfo] = useState<Info>({ status: 'loading' });
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [email, setEmail] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  /** Set at once, so a second click before the next render sends nothing more. */
  const sending = useRef(false);

  useEffect(() => {
    let current = true;
    window.api.store.reportInfo(harnessId).then(
      (result) => {
        if (!current) return;
        setInfo(
          result.ok
            ? { status: 'known', info: result.data }
            : { status: 'failed', error: result.error },
        );
      },
      () => {
        if (current) setInfo({ status: 'failed', error: UNANSWERED });
      },
    );
    return () => {
      current = false;
    };
  }, [harnessId]);

  const left = REPORT_DETAILS_MAX_LENGTH - reportDetails(details, email).length;
  const emailValid = isContactEmail(email);

  const submit = async () => {
    if (sending.current || reason === null || left < 0 || !emailValid) return;
    sending.current = true;
    setWorking(true);
    setError(null);
    let result;
    try {
      result = await window.api.store.report({
        harnessId,
        version,
        reason,
        details,
        contactEmail: email.trim(),
      });
    } catch {
      result = { ok: false as const, error: UNANSWERED };
    }
    sending.current = false;
    setWorking(false);
    if (result.ok) {
      toast(t('toast.reported'));
      onClose();
    } else if (result.error.code === 'rate_limited') {
      setRateLimited(true);
    } else {
      setError(result.error);
    }
  };

  const title = t('report.title', { name });
  if (info.status === 'loading') {
    return (
      <Modal title={title} onClose={onClose}>
        <p className="hint" role="status">
          {t('report.loading')}
        </p>
      </Modal>
    );
  }
  if (info.status === 'failed') {
    return (
      <Modal title={title} onClose={onClose}>
        <ErrorMessage error={info.error} />
        <div className="modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('report.close')}
          </button>
        </div>
      </Modal>
    );
  }
  if (rateLimited || info.info.rateLimited) {
    return (
      <Modal title={title} onClose={onClose}>
        <p className="report-limited" role="status">
          {t('report.rateLimited')}
        </p>
        <p className="hint">{t('report.rateLimitedHint')}</p>
        <div className="modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('report.close')}
          </button>
        </div>
      </Modal>
    );
  }

  const sent = info.info;
  return (
    <Modal title={title} onClose={onClose} busy={working}>
      <form
        className="modal-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="modal-fields" disabled={working}>
          <fieldset className="report-reasons">
            <legend>{t('report.reason')}</legend>
            {REPORT_REASONS.map((each) => (
              <label key={each} className="checkbox">
                <input
                  type="radio"
                  name={`${ids}-reason`}
                  value={each}
                  checked={reason === each}
                  onChange={() => {
                    setReason(each);
                  }}
                />
                {t(`report.reason.${each}`)}
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor={`${ids}-details`}>{t('report.details')}</label>
            <textarea
              id={`${ids}-details`}
              className="report-details"
              rows={5}
              value={details}
              aria-invalid={left < 0}
              aria-describedby={`${ids}-left`}
              onChange={(event) => {
                setDetails(event.target.value);
              }}
            />
            <p
              id={`${ids}-left`}
              className={left < 0 ? 'field-error' : 'field-hint'}
              aria-live="polite"
            >
              {left < 0 ? t('report.over', { count: -left }) : t('report.left', { count: left })}
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${ids}-email`}>{t('report.email')}</label>
            <input
              id={`${ids}-email`}
              type="email"
              autoComplete="email"
              value={email}
              aria-invalid={!emailValid}
              aria-describedby={`${ids}-email-hint`}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
            <p id={`${ids}-email-hint`} className={emailValid ? 'field-hint' : 'field-error'}>
              {emailValid ? t('report.emailHint') : t('report.emailInvalid')}
            </p>
          </div>
        </fieldset>
        <div className="report-sent">
          <p>{t('report.sent')}</p>
          <dl className="report-info">
            <dt>{t('report.info.harnessId')}</dt>
            <dd>{harnessId}</dd>
            <dt>{t('report.info.version')}</dt>
            <dd>{version ?? t('report.info.allVersions')}</dd>
            <dt>{t('report.info.platform')}</dt>
            <dd>{sent.platform}</dd>
            <dt>{t('report.info.appVersion')}</dt>
            <dd>{sent.appVersion}</dd>
            <dt>{t('report.info.installId')}</dt>
            <dd>{sent.installId}</dd>
          </dl>
          <p className="hint">{t('report.anonymous')}</p>
        </div>
        {error === null ? null : <ErrorMessage error={error} />}
        <div className="modal-actions">
          <button type="button" className="button-secondary" disabled={working} onClick={onClose}>
            {t('report.cancel')}
          </button>
          <button
            type="submit"
            className="button-primary"
            disabled={working || reason === null || left < 0 || !emailValid}
            aria-busy={working}
          >
            {working ? <span className="spinner" aria-hidden="true" /> : null}
            {working
              ? t('report.submitting')
              : error === null
                ? t('report.submit')
                : t('report.retry')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
