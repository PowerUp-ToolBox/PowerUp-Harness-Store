import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  DownloadProgress,
  IpcError,
  IpcResult,
  ManifestSummary,
} from '../../../shared/ipc.js';
import { useToast } from '../components/Toasts.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { useMounted } from '../onboarding/use-mounted.js';
import { ConsentDialog } from './ConsentDialog.js';

/** Where the Store install of one Harness is (docs/ux/flows.md F2). */
export type InstallJob =
  /** `received` of `total` bytes of the Harness Package; `total` is 0 until the first report. */
  | {
      readonly kind: 'downloading';
      readonly jobId: string;
      readonly received: number;
      readonly total: number;
    }
  /** Downloaded and verified: the consent dialog shows `summary`. */
  | {
      readonly kind: 'awaiting_consent';
      readonly jobId: string;
      readonly summary: ManifestSummary;
    }
  /** The User consented: the package is being unpacked and recorded. */
  | { readonly kind: 'installing'; readonly jobId: string; readonly summary: ManifestSummary }
  /** It failed (a checksum or integrity error, the Store did not answer…): Install retries. */
  | { readonly kind: 'failed'; readonly error: IpcError };

export interface InstallJobsValue {
  /** The Store installs under way or failed, by Harness ID; none for a Harness not being installed. */
  readonly jobs: ReadonlyMap<string, InstallJob>;
  /** Install, and Retry after a failure: downloads the Harness's latest version. */
  readonly install: (harnessId: string) => void;
  /** Cancels the download of the Harness, or discards it while it waits for consent. */
  readonly cancel: (harnessId: string) => void;
  /** "Review and install": shows the consent dialog of a download waiting for consent. */
  readonly review: (harnessId: string) => void;
}

const InstallJobsContext = createContext<InstallJobsValue | null>(null);

/** What a call that never reached the Runtime shows. */
const UNANSWERED: IpcError = {
  code: 'internal_error',
  messageKey: 'error.internal_error',
  message: 'Something went wrong inside Harness Store.',
};

/**
 * The Store installs of the main window (flows F2), held above the screens so a download goes on,
 * and shows its progress again, when the User leaves the detail page and comes back.
 *
 * Install starts `installs.install` with a new job ID, following its `progress:<jobId>` events.
 * Once the package is downloaded and verified, the shared {@link ConsentDialog} opens over
 * whatever screen is shown: Install (enabled after one second) runs `installs.confirm`, and the
 * Library gains the Harness with a toast "Installed <name>"; Cancel or Escape discards the
 * download (`installs.cancel`). Cancel during the download stops it, with a toast "Download
 * cancelled". A failure (a checksum mismatch, a package that cannot be installed safely, the
 * Store not answering) stays on the Harness's detail page until Install is pressed again, which
 * downloads it anew. One consent dialog shows at a time: a download finishing meanwhile waits
 * for it, its detail page offering "Review and install", and opens once the dialog closes.
 *
 * Only this provider knows its job IDs, so nothing of a job outlives it: a download that is done
 * after the provider unmounted, or after Cancel was pressed (main finished verifying as the
 * Cancel crossed it), is discarded with `installs.cancel` and never shows the dialog; the jobs
 * still open when it unmounts are cancelled. Main discards them too when the page itself goes.
 */
export function InstallJobsProvider({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const toast = useToast();
  const mounted = useMounted();
  const [jobs, setJobsState] = useState<ReadonlyMap<string, InstallJob>>(new Map());
  /** The jobs as they are now, also between a change and the render that shows it. */
  const jobsRef = useRef(jobs);
  const setJobs = useCallback(
    (next: (current: ReadonlyMap<string, InstallJob>) => ReadonlyMap<string, InstallJob>) => {
      jobsRef.current = next(jobsRef.current);
      setJobsState(jobsRef.current);
    },
    [],
  );
  /** The Harness whose consent dialog is shown; null when none is. */
  const [shown, setShown] = useState<string | null>(null);
  /** The jobs whose download the User cancelled, until `installs.install` answers. */
  const cancelled = useRef(new Set<string>());

  // Unmounted (the app went to onboarding, say): nothing could confirm the jobs still open.
  useEffect(
    () => () => {
      for (const job of jobsRef.current.values()) {
        if (job.kind === 'downloading' || job.kind === 'awaiting_consent') {
          void window.api.installs.cancel(job.jobId);
        }
      }
    },
    [],
  );

  /** Changes the job of `harnessId` only while it is still job `jobId` (null: removes it). */
  const update = useCallback(
    (harnessId: string, jobId: string, next: (job: InstallJob) => InstallJob | null) => {
      setJobs((current) => {
        const job = current.get(harnessId);
        if (job === undefined || !('jobId' in job) || job.jobId !== jobId) return current;
        const changed = new Map(current);
        const replacement = next(job);
        if (replacement === null) changed.delete(harnessId);
        else changed.set(harnessId, replacement);
        return changed;
      });
    },
    [setJobs],
  );

  /** Closes the dialog of `harnessId`, showing the next download waiting for consent, if any. */
  const closeDialog = useCallback((harnessId: string) => {
    setShown((current) => {
      if (current !== harnessId) return current;
      for (const [id, job] of jobsRef.current) {
        if (id !== harnessId && job.kind === 'awaiting_consent') return id;
      }
      return null;
    });
  }, []);

  const install = useCallback(
    (harnessId: string) => {
      const existing = jobsRef.current.get(harnessId);
      if (existing !== undefined && existing.kind !== 'failed') return;
      const jobId = crypto.randomUUID();
      setJobs((current) =>
        new Map(current).set(harnessId, { kind: 'downloading', jobId, received: 0, total: 0 }),
      );
      // Subscribed before the call, so no report is missed.
      const off = window.api.on(`progress:${jobId}`, (payload) => {
        if (!isDownloadProgress(payload)) return;
        update(harnessId, jobId, (job) =>
          job.kind === 'downloading'
            ? { ...job, received: payload.received, total: payload.total }
            : job,
        );
      });
      void window.api.installs
        .install({ harnessId, jobId })
        .then(
          (result) => result,
          (): IpcResult<ManifestSummary> => ({ ok: false, error: UNANSWERED }),
        )
        .then((result) => {
          off();
          const cancelledMeanwhile = cancelled.current.delete(jobId);
          if (!mounted.current) {
            if (result.ok) void window.api.installs.cancel(jobId);
            return;
          }
          if (result.ok && cancelledMeanwhile) {
            // The download was done just before the Cancel reached main, which discards it now
            // (a second cancel of a job already discarded changes nothing).
            void window.api.installs.cancel(jobId);
            update(harnessId, jobId, () => null);
            toast(t('toast.downloadCancelled'));
            return;
          }
          if (result.ok) {
            const summary = result.data;
            update(harnessId, jobId, () => ({ kind: 'awaiting_consent', jobId, summary }));
            setShown((current) => current ?? harnessId);
            return;
          }
          const { error } = result;
          if (error.code === 'download_cancelled') {
            update(harnessId, jobId, () => null);
            toast(t('toast.downloadCancelled'));
            return;
          }
          update(harnessId, jobId, () => ({ kind: 'failed', error }));
        });
    },
    [mounted, setJobs, t, toast, update],
  );

  const cancel = useCallback(
    (harnessId: string) => {
      const job = jobsRef.current.get(harnessId);
      if (job === undefined) return;
      if (job.kind === 'downloading') {
        // `installs.install` then answers `download_cancelled`, which ends the job; or it had
        // answered already, and its answer, on the way, is taken as cancelled too.
        cancelled.current.add(job.jobId);
        void window.api.installs.cancel(job.jobId);
      } else if (job.kind === 'awaiting_consent') {
        update(harnessId, job.jobId, () => null);
        closeDialog(harnessId);
        void window.api.installs.cancel(job.jobId);
      }
    },
    [closeDialog, update],
  );

  const review = useCallback((harnessId: string) => {
    if (jobsRef.current.get(harnessId)?.kind !== 'awaiting_consent') return;
    setShown((current) => current ?? harnessId);
  }, []);

  const confirm = useCallback(
    (harnessId: string) => {
      const job = jobsRef.current.get(harnessId);
      if (job?.kind !== 'awaiting_consent') return;
      const { jobId, summary } = job;
      update(harnessId, jobId, () => ({ kind: 'installing', jobId, summary }));
      void window.api.installs
        .confirm(jobId)
        .then(
          (result) => result,
          () => ({ ok: false as const, error: UNANSWERED }),
        )
        .then((result) => {
          if (!mounted.current) return;
          closeDialog(harnessId);
          if (result.ok) {
            update(harnessId, jobId, () => null);
            toast(t('toast.installed', { name: summary.name }));
          } else {
            // Main discarded the download: Install downloads it again.
            update(harnessId, jobId, () => ({ kind: 'failed', error: result.error }));
          }
        });
    },
    [closeDialog, mounted, t, toast, update],
  );

  const value = useMemo<InstallJobsValue>(
    () => ({ jobs, install, cancel, review }),
    [jobs, install, cancel, review],
  );
  const dialogJob = shown === null ? undefined : jobs.get(shown);
  return (
    <InstallJobsContext.Provider value={value}>
      {children}
      {shown !== null &&
      (dialogJob?.kind === 'awaiting_consent' || dialogJob?.kind === 'installing') ? (
        <ConsentDialog
          // A new dialog per job, so its one-second read delay starts again.
          key={dialogJob.jobId}
          summary={dialogJob.summary}
          installing={dialogJob.kind === 'installing'}
          error={null}
          onInstall={() => {
            confirm(shown);
          }}
          onCancel={() => {
            cancel(shown);
          }}
        />
      ) : null}
    </InstallJobsContext.Provider>
  );
}

function isDownloadProgress(payload: unknown): payload is DownloadProgress {
  if (typeof payload !== 'object' || payload === null) return false;
  const { received, total } = payload as Record<string, unknown>;
  return typeof received === 'number' && typeof total === 'number';
}

/** How far a download is, 0 to 100; 0 until its size is known. */
export function downloadPercent(job: Extract<InstallJob, { kind: 'downloading' }>): number {
  return job.total > 0 ? Math.min(100, (job.received / job.total) * 100) : 0;
}

export function useInstallJobs(): InstallJobsValue {
  const value = useContext(InstallJobsContext);
  if (value === null) throw new Error('useInstallJobs must be used inside <InstallJobsProvider>');
  return value;
}
