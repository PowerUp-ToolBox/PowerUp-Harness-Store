import type { Problem } from '@harness-store/manifest';
import type { DragEvent } from 'react';
import type { FolderValidation } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { FolderUploadIcon } from '../shell/icons.js';
import { usePublish } from './PublishProvider.js';
import { PublishReview, type PublisherIdentity } from './PublishReview.js';
import { VersionStatus } from './VersionStatus.js';

/**
 * "New version" (flow F5, steps 2 to 5): choose a folder with the OS picker or by dropping it
 * anywhere on this section, and it is validated at once (the Runtime builds the Harness Package
 * the upload would send and validates that). Problems are listed by Manifest path, each with its
 * message in the UI language and its stable code; warnings separately, and they never block.
 * Continue is enabled exactly when there is no problem, and leads to the review: the facts from
 * the Manifest and the listing preview. The folder is validated again when it changes on disk, and
 * on Re-check.
 */
export function NewVersion({ publisher }: { readonly publisher: PublisherIdentity }) {
  const { t } = useI18n();
  const { flow, chooseFolder, dropFolder, recheck, review, back } = usePublish();
  const { folder, check, reviewing, dropRefused } = flow;

  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void dropFolder(window.api.pathForFile(file));
  };

  const result =
    check?.kind === 'done' ? check.result : check?.kind === 'checking' ? check.previous : null;
  const checking = check?.kind === 'checking';

  return (
    <section
      className="publish-new"
      aria-label={t('publish.drop')}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {folder === null ? (
        <div className="drop-zone">
          <FolderUploadIcon />
          <span className="drop-zone-title">{t('publish.drop')}</span>
          <button type="button" className="button-primary" onClick={() => void chooseFolder()}>
            {t('publish.chooseFolder')}
          </button>
        </div>
      ) : (
        <div className="publish-folder">
          <code className="publish-folder-path">{folder}</code>
          <button
            type="button"
            className="button-secondary"
            disabled={checking}
            onClick={() => void recheck()}
          >
            {t('publish.recheck')}
          </button>
          <button type="button" className="button-secondary" onClick={() => void chooseFolder()}>
            {t('publish.chooseAnother')}
          </button>
        </div>
      )}
      {dropRefused ? (
        <p className="error-message" role="alert">
          {t('publish.drop.notFolder')}
        </p>
      ) : null}
      {checking ? (
        <p className="install-folder-status" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('publish.checking')}
        </p>
      ) : null}
      {check?.kind === 'error' ? <ErrorMessage error={check.error} /> : null}
      {result === null ? null : reviewing && result.manifest !== null ? (
        <PublishReview
          validation={result}
          manifest={result.manifest}
          publisher={publisher}
          onBack={back}
        />
      ) : (
        <ValidationResult validation={result} checking={checking} onContinue={review} />
      )}
    </section>
  );
}

/** The problems (or none), the warnings, what the Store said of earlier versions, and Continue. */
function ValidationResult({
  validation,
  checking,
  onContinue,
}: {
  readonly validation: FolderValidation;
  readonly checking: boolean;
  readonly onContinue: () => void;
}) {
  const { t } = useI18n();
  const { problems, warnings } = validation;
  return (
    <div className="publish-result">
      {problems.length > 0 ? (
        <div className="problem-panel" role="alert">
          <p className="problem-panel-title">{t('publish.problems', { count: problems.length })}</p>
          <ProblemList problems={problems} />
        </div>
      ) : (
        <p className="publish-clean" role="status">
          {t('publish.noProblems')}
        </p>
      )}
      {warnings.length > 0 ? (
        <div className="warning-panel">
          <p className="problem-panel-title">{t('publish.warnings', { count: warnings.length })}</p>
          <ProblemList problems={warnings} />
        </div>
      ) : null}
      <VersionStatus validation={validation} />
      <div className="publish-actions">
        <button
          type="button"
          className="button-primary"
          disabled={checking || problems.length > 0 || validation.manifest === null}
          onClick={onContinue}
        >
          {t('publish.continue')}
        </button>
      </div>
    </div>
  );
}

/** Validation findings in path order: the path, the message in the UI language, the code. */
function ProblemList({ problems }: { readonly problems: readonly Problem[] }) {
  const { problemText } = useI18n();
  return (
    <ul className="problem-list">
      {problems.map((problem, index) => (
        // Paths repeat (one file can have several problems) and the list never reorders.
        <li key={index}>
          <code>{problem.path}</code>
          <span>{problemText(problem)}</span>
          <code className="problem-code">{problem.code}</code>
        </li>
      ))}
    </ul>
  );
}
