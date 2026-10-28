import type { Manifest } from '@harness-store/manifest';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type {
  ConnectionSummary,
  InstalledHarness,
  IpcError,
  ResolvedSlot,
  StoreDetail,
} from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { downloadPercent, useInstallJobs } from '../install/InstallJobsProvider.js';
import { useLaunchStatus } from '../library/LaunchAction.js';
import { ListingDetail, type SlotUse } from '../listing/ListingDetail.js';
import { connectionName } from '../models/names.js';
import { BackButton } from '../store/BackButton.js';
import { DetailAction } from '../store/DetailAction.js';
import { primaryActionState } from '../store/primary-action.js';

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly detail: StoreDetail }
  | { readonly status: 'failed'; readonly error: IpcError };

/** What a call that never reached the Runtime shows. */
const UNANSWERED: IpcError = {
  code: 'internal_error',
  messageKey: 'error.internal_error',
  message: 'Something went wrong inside Harness Store.',
};

/**
 * A Harness's Store detail page (P0-09.3), at `/store/h/<publisher>/<slug>`, opened from a Store
 * card or from a Library card's "View in Store": `store.detail`, read again each time the page
 * opens, shown with the shared {@link ListingDetail} (the Publish preview's too) and the primary
 * button of {@link primaryActionState}. Each Model Slot says what it would use on this machine,
 * from `bindings.resolveManifest`. Install runs the Store install of {@link useInstallJobs}
 * (flows F2): its progress and Cancel on the button, "Review and install" while its consent
 * dialog waits, and its error under the button when it failed.
 *
 * A Harness the Store no longer offers (taken down, Unpublished-only, unknown) is the "no longer
 * available" page when it is not installed; an installed one keeps its page, built from its
 * installed Manifest, with Launch and the note "No longer available in the Store" (flows F4 step
 * 4). Back returns to where the User came from (the Store's search keeps its text, tags and
 * platform toggle), or to the Store home when the page was opened directly.
 */
export function HarnessDetailPage() {
  const { t } = useI18n();
  const harnessId = useParams()['*'] ?? '';
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [error, setError] = useState<IpcError | null>(null);
  const install = useInstall(harnessId);
  const launch = useLaunchStatus(harnessId);
  const installJobs = useInstallJobs();
  const job = installJobs.jobs.get(harnessId);
  /** Numbers the reads, so only the latest one's answer is shown. */
  const reads = useRef(0);

  const load = useCallback(() => {
    const read = ++reads.current;
    setState({ status: 'loading' });
    window.api.store.detail(harnessId).then(
      (result) => {
        if (read !== reads.current) return;
        setState(
          result.ok
            ? { status: 'loaded', detail: result.data }
            : { status: 'failed', error: result.error },
        );
      },
      () => {
        if (read === reads.current) setState({ status: 'failed', error: UNANSWERED });
      },
    );
  }, [harnessId]);

  useEffect(() => {
    load();
    return () => {
      // A late answer finds a newer read number and is dropped.
      reads.current += 1;
    };
  }, [load]);

  const detail = state.status === 'loaded' ? state.detail : null;
  const harness = detail?.harness ?? null;
  // The page shows the Store's latest Manifest, else an installed one the Store no longer offers.
  const manifest = harness?.manifest ?? (detail === null ? null : (install?.manifest ?? null));
  const slotUses = useSlotUses(harnessId, manifest);

  if (state.status === 'loading' || install === undefined) {
    return (
      <div className="store-detail">
        <BackButton />
        <div
          className="listing-detail skeleton-detail"
          role="status"
          aria-busy="true"
          aria-label={t('store.detail.loading')}
        />
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="store-detail">
        <BackButton />
        <section className="store-error" aria-labelledby="store-error-title">
          <h2 id="store-error-title">{t('store.loadFailed')}</h2>
          <ErrorMessage error={state.error} />
          <button type="button" className="button-primary" onClick={load}>
            {t('connectivity.retry')}
          </button>
        </section>
      </div>
    );
  }

  const { detail: loaded } = state;
  const actionState = primaryActionState({
    storeStatus: loaded.storeStatus,
    latestVersion: harness?.manifest.version ?? null,
    latestPlatforms: harness?.manifest.platforms ?? [],
    platform: loaded.platform,
    install,
    downloading: job?.kind === 'downloading',
    awaitingConsent: job?.kind === 'awaiting_consent' || job?.kind === 'installing',
  });
  // A launch the Runtime refused, else why the last Store install failed.
  const shownError = error ?? (job?.kind === 'failed' ? job.error : null);
  const actions = (
    <>
      <DetailAction
        state={actionState}
        install={install}
        launch={launch}
        download={
          job?.kind === 'downloading'
            ? {
                percent: downloadPercent(job),
                onCancel: () => {
                  installJobs.cancel(harnessId);
                },
              }
            : null
        }
        onInstall={() => {
          setError(null);
          installJobs.install(harnessId);
        }}
        onReview={() => {
          installJobs.review(harnessId);
        }}
        onError={setError}
      />
      {install !== null && harness === null ? (
        <p className="hint">{t('store.detail.notInStore')}</p>
      ) : null}
      {shownError === null ? null : <ErrorMessage error={shownError} />}
    </>
  );

  if (harness === null && install === null) {
    return (
      <div className="store-detail">
        <BackButton />
        <section className="empty-panel store-gone" aria-labelledby="store-gone-title">
          <h2 id="store-gone-title" className="empty-panel-title">
            {t('store.detail.gone')}
          </h2>
          <p>{t('store.detail.goneHint')}</p>
          <div className="listing-detail-actions">{actions}</div>
        </section>
      </div>
    );
  }

  const report = (
    // The Report dialog arrives with P0-12 (flows F8).
    <button type="button" className="button-link" disabled>
      {t('listing.report')}
    </button>
  );
  return (
    <div className="store-detail">
      <BackButton />
      {harness !== null ? (
        <ListingDetail
          headingLevel={2}
          manifest={harness.manifest}
          publisher={{ ...harness.publisher, href: `/store/p/${harness.publisher.login}` }}
          iconUrl={harness.iconUrl}
          downloads={harness.downloadCount}
          readme={harness.readme}
          screenshots={harness.screenshotUrls}
          versions={harness.versions}
          currentPlatform={loaded.platform}
          installedVersion={install?.version ?? null}
          {...(slotUses === null ? {} : { slotUses })}
          actions={actions}
          footer={report}
        />
      ) : install !== null ? (
        <ListingDetail
          headingLevel={2}
          manifest={install.manifest}
          publisher={{
            login: install.publisher,
            avatarUrl: null,
            // The Publisher may still have other Harnesses in the Store; an unknown login's page
            // says "No such Publisher".
            href: `/store/p/${install.publisher}`,
          }}
          iconUrl={install.iconDataUrl}
          downloads={null}
          readme={null}
          versions={[
            {
              version: install.version,
              ...(install.manifest.changelog === undefined
                ? {}
                : { changelog: install.manifest.changelog }),
            },
          ]}
          currentPlatform={loaded.platform}
          installedVersion={install.version}
          {...(slotUses === null ? {} : { slotUses })}
          actions={actions}
          footer={report}
        />
      ) : null}
    </div>
  );
}

/**
 * The installed Harness of this ID: undefined until `installs.list` answers, null when it is not
 * installed. Read again on `installs.changed`.
 */
function useInstall(harnessId: string): InstalledHarness | null | undefined {
  const [install, setInstall] = useState<InstalledHarness | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    const load = () => {
      void window.api.installs.list().then((result) => {
        if (!current) return;
        // Without the installs, the page is what the Store says, as for a Harness not installed.
        setInstall(
          result.ok ? (result.data.find((each) => each.harnessId === harnessId) ?? null) : null,
        );
      });
    };
    load();
    const unsubscribe = window.api.on('installs.changed', load);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [harnessId]);
  return install;
}

/**
 * What each Model Slot of `manifest` would use on this machine (`bindings.resolveManifest`), named
 * after its Connection: "Ollama · qwen3:8b", or null when nothing can fill it. Null until known,
 * and when it cannot be known.
 */
function useSlotUses(
  harnessId: string,
  manifest: Manifest | null,
): ReadonlyMap<string, SlotUse> | null {
  const { t } = useI18n();
  const [resolved, setResolved] = useState<{
    readonly slots: readonly ResolvedSlot[];
    readonly connections: readonly ConnectionSummary[];
  } | null>(null);
  const models = manifest?.models ?? null;
  useEffect(() => {
    setResolved(null);
    if (models === null) return undefined;
    let current = true;
    void Promise.all([
      window.api.bindings.resolveManifest({ harnessId, models }),
      window.api.connections.list(),
    ]).then(([slots, connections]) => {
      if (current && slots.ok) {
        setResolved({ slots: slots.data, connections: connections.ok ? connections.data : [] });
      }
    });
    return () => {
      current = false;
    };
  }, [harnessId, models]);
  if (resolved === null) return null;
  return new Map(
    resolved.slots.map(({ slot, binding }): [string, SlotUse] => {
      if (binding === null) return [slot, null];
      const connection = resolved.connections.find((each) => each.id === binding.connectionId);
      const name = connection === undefined ? binding.connectionId : connectionName(t, connection);
      return [slot, `${name} · ${binding.model}`];
    }),
  );
}
