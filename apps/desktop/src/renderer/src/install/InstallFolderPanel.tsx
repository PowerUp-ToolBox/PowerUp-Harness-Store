import type { Problem } from '@harness-store/manifest';
import { useState } from 'react';
import { Link } from 'react-router';
import type { FolderInspection, IpcError, ManifestSummary } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { useMounted } from '../onboarding/use-mounted.js';
import { ConsentDialog } from './ConsentDialog.js';

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking'; readonly path: string }
  | { readonly kind: 'inspected'; readonly path: string; readonly inspection: FolderInspection }
  | { readonly kind: 'installed'; readonly name: string; readonly version: string };

/**
 * "Install this folder locally" (docs/ux/flows.md F5): a Publisher installs their own Harness
 * folder to run it exactly as Users will, without uploading it. It needs no sign-in and no
 * network. The order is validate, consent, then install, so nothing touches the disk before the
 * User consented, and Cancel leaves nothing behind:
 *
 * 1. The native folder picker (`installs.chooseFolder`).
 * 2. `installs.inspectFolder`: an invalid folder shows every problem (path and message, in the UI
 *    language) with Re-check; a valid one opens the consent dialog. Warnings show either way: on
 *    the page beside the problems, in the dialog for a valid folder.
 * 3. Install in the dialog runs `installs.installFromFolder`. When the folder changed in between
 *    (`package_invalid`) it is inspected again, which shows its problems, or a fresh dialog that
 *    says why it is back. Any other error (a file that cannot be opened, the Harness running)
 *    stays in the dialog: inspecting again would not change it.
 * 4. An inline confirmation with a link to the Library.
 */
export function InstallFolderPanel() {
  const { t, problemText } = useI18n();
  const mounted = useMounted();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState<IpcError | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<IpcError | null>(null);

  /** `reason`: the install error that made this inspection, shown in the fresh dialog. */
  const inspect = async (path: string, reason: IpcError | null = null) => {
    setError(null);
    setStep({ kind: 'checking', path });
    const result = await window.api.installs.inspectFolder(path);
    if (!mounted.current) return;
    if (result.ok) {
      setInstallError(result.data.valid ? reason : null);
      setStep({ kind: 'inspected', path, inspection: result.data });
    } else {
      setError(result.error);
      setStep({ kind: 'idle' });
    }
  };

  const choose = async () => {
    setError(null);
    const result = await window.api.installs.chooseFolder();
    if (!mounted.current) return;
    if (!result.ok) setError(result.error);
    else if (result.data !== null) await inspect(result.data);
  };

  const install = async (path: string, summary: ManifestSummary) => {
    setInstalling(true);
    setInstallError(null);
    const result = await window.api.installs.installFromFolder(path);
    if (!mounted.current) return;
    setInstalling(false);
    if (result.ok) {
      setStep({ kind: 'installed', name: summary.name, version: result.data.version });
    } else if (result.error.code === 'package_invalid') {
      await inspect(path, result.error);
    } else {
      setInstallError(result.error);
    }
  };

  const busy = step.kind === 'checking' || installing;
  const inspection = step.kind === 'inspected' ? step.inspection : null;
  const summary = inspection?.manifestSummary ?? null;

  return (
    <section className="install-folder" aria-labelledby="install-folder-title">
      <h2 id="install-folder-title" className="install-folder-title">
        {t('publish.installLocal')}
      </h2>
      <p className="hint">{t('publish.installLocal.hint')}</p>
      <div>
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => void choose()}
        >
          {t('publish.installLocal')}
        </button>
      </div>
      {step.kind === 'checking' ? (
        <p className="install-folder-status" role="status">
          <span className="spinner" aria-hidden="true" />
          {t('publish.installLocal.checking')}
        </p>
      ) : null}
      {step.kind === 'checking' || step.kind === 'inspected' ? (
        <p className="install-folder-path">
          <code>{step.path}</code>
        </p>
      ) : null}
      {error === null ? null : <ErrorMessage error={error} />}
      {step.kind === 'inspected' && !step.inspection.valid ? (
        <div className="problem-panel" role="alert">
          <p className="problem-panel-title">
            {t('publish.installLocal.problems', { count: step.inspection.problems.length })}
          </p>
          <ProblemList problems={step.inspection.problems} problemText={problemText} />
          <div>
            <button
              type="button"
              className="button-secondary"
              onClick={() => void inspect(step.path)}
            >
              {t('publish.installLocal.recheck')}
            </button>
          </div>
        </div>
      ) : null}
      {inspection !== null && !inspection.valid ? (
        <WarningPanel warnings={inspection.warnings} problemText={problemText} />
      ) : null}
      {step.kind === 'installed' ? (
        <p className="install-folder-done" role="status">
          {t('publish.installLocal.installed', { name: step.name, version: step.version })}{' '}
          <Link to="/library">{t('publish.installLocal.openLibrary')}</Link>
        </p>
      ) : null}
      {step.kind === 'inspected' && summary !== null ? (
        <ConsentDialog
          summary={summary}
          installing={installing}
          error={installError}
          onInstall={() => void install(step.path, summary)}
          onCancel={() => {
            setInstallError(null);
            setStep({ kind: 'idle' });
          }}
        >
          <WarningPanel warnings={step.inspection.warnings} problemText={problemText} />
        </ConsentDialog>
      ) : null}
    </section>
  );
}

/** The warnings of a folder, when it has any: they never block installing. */
function WarningPanel({
  warnings,
  problemText,
}: {
  readonly warnings: readonly Problem[];
  readonly problemText: (problem: Problem) => string;
}) {
  const { t } = useI18n();
  if (warnings.length === 0) return null;
  return (
    <div className="warning-panel">
      <p className="problem-panel-title">
        {t('publish.installLocal.warnings', { count: warnings.length })}
      </p>
      <ProblemList problems={warnings} problemText={problemText} />
    </div>
  );
}

/** Validation findings as `validatePackage` returned them: the path, then the message. */
function ProblemList({
  problems,
  problemText,
}: {
  readonly problems: readonly Problem[];
  readonly problemText: (problem: Problem) => string;
}) {
  return (
    <ul className="problem-list">
      {problems.map((problem, index) => (
        // Paths repeat (one file can have several problems) and the list never reorders.
        <li key={index}>
          <code>{problem.path}</code>
          <span>{problemText(problem)}</span>
        </li>
      ))}
    </ul>
  );
}
