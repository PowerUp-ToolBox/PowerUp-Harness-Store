import type { Platform } from '@harness-store/manifest';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcError, StoreHome as StoreHomeRows, StoreListing } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { StoreListingCard } from './StoreListingCard.js';

type HomeState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly home: StoreHomeRows }
  | { readonly status: 'failed'; readonly error: IpcError };

/** What a call that never reached the Runtime shows. */
const UNANSWERED: IpcError = {
  code: 'internal_error',
  messageKey: 'error.internal_error',
  message: 'Something went wrong inside Harness Store.',
};

/** The skeleton cards a section shows while the Store home loads. */
const SKELETON_CARDS = 3;

/**
 * The Store home (docs/ux/screens.md, P0-09.1): Featured, New and Most downloaded, each a row of
 * Store cards in the Store's order, from `store.home`, which the Runtime keeps for 5 minutes, so
 * coming back to the Store tab reads the Store again only after that. Skeletons per section while
 * it loads; an empty section is hidden, and a Store with no Harness at all says so. An error is
 * inline, with Retry, which reads the Store again whatever the Runtime kept. When the Store does
 * not answer, the Runtime checks connectivity again, and the Store tab's offline panel
 * (StoreGate) takes over once the check finds it unreachable.
 */
export function StoreHome() {
  const { t } = useI18n();
  const [state, setState] = useState<HomeState>({ status: 'loading' });
  /** Numbers the reads, so only the latest one's answer is shown. */
  const reads = useRef(0);

  const load = useCallback((refresh: boolean) => {
    const read = ++reads.current;
    setState({ status: 'loading' });
    window.api.store.home(refresh ? { refresh: true } : {}).then(
      (result) => {
        if (read !== reads.current) return;
        setState(
          result.ok
            ? { status: 'loaded', home: result.data }
            : { status: 'failed', error: result.error },
        );
      },
      () => {
        if (read === reads.current) setState({ status: 'failed', error: UNANSWERED });
      },
    );
  }, []);

  useEffect(() => {
    load(false);
    return () => {
      // A late answer finds a newer read number and is dropped.
      reads.current += 1;
    };
  }, [load]);

  if (state.status === 'loading') {
    return (
      <div className="store-home" role="status" aria-busy="true" aria-label={t('store.loading')}>
        <SkeletonSection title={t('store.featured')} />
        <div className="store-columns">
          <SkeletonSection title={t('store.newest')} />
          <SkeletonSection title={t('store.mostDownloaded')} />
        </div>
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <section className="store-error" aria-labelledby="store-error-title">
        <h2 id="store-error-title">{t('store.loadFailed')}</h2>
        <ErrorMessage error={state.error} />
        <button
          type="button"
          className="button-primary"
          onClick={() => {
            load(true);
          }}
        >
          {t('connectivity.retry')}
        </button>
      </section>
    );
  }
  const { home } = state;
  if (home.featured.length + home.newest.length + home.mostDownloaded.length === 0) {
    return (
      <div className="empty-panel">
        <p className="empty-panel-title">{t('store.empty')}</p>
      </div>
    );
  }
  return (
    <div className="store-home">
      <ListingSection
        id="store-featured"
        title={t('store.featured')}
        listings={home.featured}
        platform={home.platform}
        layout="row"
      />
      <div className="store-columns">
        <ListingSection
          id="store-newest"
          title={t('store.newest')}
          listings={home.newest}
          platform={home.platform}
        />
        <ListingSection
          id="store-most-downloaded"
          title={t('store.mostDownloaded')}
          listings={home.mostDownloaded}
          platform={home.platform}
        />
      </div>
    </div>
  );
}

/** One labelled row of Store cards; nothing when it has none. */
function ListingSection({
  id,
  title,
  listings,
  platform,
  layout = 'column',
}: {
  readonly id: string;
  readonly title: string;
  readonly listings: readonly StoreListing[];
  readonly platform: Platform | null;
  /** `row`: side by side, scrolling sideways (Featured); `column`: one under another. */
  readonly layout?: 'row' | 'column';
}) {
  if (listings.length === 0) return null;
  return (
    <section className="store-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul className={`store-cards store-cards-${layout}`}>
        {listings.map((listing) => (
          <li key={listing.harnessId}>
            <StoreListingCard listing={listing} platform={platform} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A section's title over grey placeholder cards. */
function SkeletonSection({ title }: { readonly title: string }) {
  return (
    <section className="store-section">
      <h2>{title}</h2>
      <ul className="store-cards store-cards-column" aria-hidden="true">
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <li key={index} className="skeleton-card" />
        ))}
      </ul>
    </section>
  );
}
