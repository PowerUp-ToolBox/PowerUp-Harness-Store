import { Link } from 'react-router';
import type { IpcError, PublishedVersion } from '../../../shared/ipc.js';
import { useConnectivity } from '../connectivity/ConnectivityProvider.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { ProblemList } from './ProblemList.js';
import { allSent, usePublish, type UploadState } from './PublishProvider.js';

/**
 * The end of the review (flow F5, step 6): Publish and Back, then the upload's progress with
 * Cancel, and after a failure the Store's answer with Retry, which sends the same Harness Package
 * again. Publishing needs the Store: offline, Publish is disabled and says why (the app's offline
 * banner shows too), so nothing is attempted. A cancelled upload says so here.
 */
export function UploadActions({ checking }: { readonly checking: boolean }) {
  const { t } = useI18n();
  const { state } = useConnectivity();
  const { flow, publish, cancelUpload, back } = usePublish();
  const { upload } = flow;
  const offline = state === 'offline';

  if (upload?.kind === 'uploading') {
    return <UploadProgressBar upload={upload} onCancel={() => void cancelUpload()} />;
  }
  return (
    <div className="publish-result">
      {upload?.kind === 'failed' ? <UploadFailure error={upload.error} /> : null}
      {upload?.kind === 'cancelled' ? (
        <p className="hint" role="status">
          {t('publish.cancelled')}
        </p>
      ) : null}
      {offline ? (
        <p className="warning-panel" role="note">
          {t('publish.offline')}
        </p>
      ) : null}
      <div className="publish-actions">
        <button
          type="button"
          className="button-primary"
          disabled={offline || checking}
          onClick={() => void publish()}
        >
          {upload?.kind === 'failed' ? t('publish.retry') : t('publish.publish')}
        </button>
        <button type="button" className="button-secondary" onClick={back}>
          {t('publish.back')}
        </button>
      </div>
    </div>
  );
}

/**
 * The upload's progress: the share of the request sent, then, once all of it is sent, an
 * indeterminate "Processing…" while the Store checks and saves it, when Cancel no longer applies.
 */
function UploadProgressBar({
  upload,
  onCancel,
}: {
  readonly upload: Extract<UploadState, { kind: 'uploading' }>;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const processing = allSent(upload);
  const percent = upload.total === 0 ? 0 : Math.floor((upload.sent * 100) / upload.total);
  return (
    <div className="publish-upload">
      <span className="publish-upload-label" role="status">
        {processing ? t('publish.processing') : t('publish.uploading', { percent })}
      </span>
      <div
        className="progress"
        role="progressbar"
        aria-label={t('publish.uploadProgress')}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(processing ? {} : { 'aria-valuenow': percent })}
        data-indeterminate={processing ? 'true' : undefined}
      >
        <div
          className="progress-fill"
          style={{ width: `${String(processing ? 100 : percent)}%` }}
        />
      </div>
      <div className="publish-actions">
        <button type="button" className="button-secondary" disabled={processing} onClick={onCancel}>
          {t('publish.cancelUpload')}
        </button>
      </div>
    </div>
  );
}

/**
 * Why the Store did not publish: its error in the UI language (the Store's English message is
 * the fallback), its code, and the problems it found, by path.
 */
function UploadFailure({ error }: { readonly error: IpcError }) {
  const { t, errorText } = useI18n();
  return (
    <div className="problem-panel" role="alert">
      <p className="problem-panel-title">{t('publish.failed')}</p>
      <p className="publish-failure-text">
        <span>{errorText(error)}</span> <code className="problem-code">{error.code}</code>
      </p>
      {error.problems === undefined || error.problems.length === 0 ? null : (
        <ProblemList problems={error.problems} />
      )}
    </div>
  );
}

/**
 * Published (flow F5, step 7): the Harness Version is in the Store, and immutable. View listing
 * opens it in the Store tab; Publish another starts again with no folder.
 */
export function PublishSuccess({ version }: { readonly version: PublishedVersion }) {
  const { t } = useI18n();
  const { publishAnother } = usePublish();
  return (
    <div className="publish-success" role="status">
      <p className="publish-success-title">{t('publish.published')}</p>
      <p>
        {t('publish.publishedVersion', { harnessId: version.harnessId, version: version.version })}
      </p>
      <div className="publish-actions">
        <Link className="button-primary" to={version.url}>
          {t('publish.viewListing')}
        </Link>
        <button type="button" className="button-secondary" onClick={publishAnother}>
          {t('publish.publishAnother')}
        </button>
      </div>
    </div>
  );
}
