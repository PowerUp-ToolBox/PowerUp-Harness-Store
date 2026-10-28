import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { IpcError, StorePublisherPage } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { HarnessIcon } from '../listing/HarnessCard.js';
import { BackButton } from '../store/BackButton.js';
import { StoreListingCard } from '../store/StoreListingCard.js';

type PublisherState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly page: StorePublisherPage }
  | { readonly status: 'failed'; readonly error: IpcError };

/** What a call that never reached the Runtime shows. */
const UNANSWERED: IpcError = {
  code: 'internal_error',
  messageKey: 'error.internal_error',
  message: 'Something went wrong inside Harness Store.',
};

/** The skeleton cards the page shows while it loads. */
const SKELETON_CARDS = 3;

/**
 * A Publisher's Store page (docs/ux/screens.md, P0-09.4), at `/store/p/<login>`, opened from a
 * Publisher's login on a Store card or from the detail page's header: `store.publisher`, read
 * again each time the page opens. Their avatar (a monogram without one), display name (else their
 * login), `@login` linking to their GitHub profile, join date, bio and the downloads of the
 * Harnesses listed, over those Harnesses as the Store's own cards, most downloaded first. A
 * Publisher whose Harnesses are all hidden says "No published Harnesses"; a login with no profile
 * says there is no such Publisher. An error is inline, with Retry.
 */
export function PublisherPage() {
  const i18n = useI18n();
  const { t } = i18n;
  const login = useParams().login ?? '';
  const [state, setState] = useState<PublisherState>({ status: 'loading' });
  /** Numbers the reads, so only the latest one's answer is shown. */
  const reads = useRef(0);

  const load = useCallback(() => {
    const read = ++reads.current;
    setState({ status: 'loading' });
    window.api.store.publisher(login).then(
      (result) => {
        if (read !== reads.current) return;
        setState(
          result.ok
            ? { status: 'loaded', page: result.data }
            : { status: 'failed', error: result.error },
        );
      },
      () => {
        if (read === reads.current) setState({ status: 'failed', error: UNANSWERED });
      },
    );
  }, [login]);

  useEffect(() => {
    load();
    return () => {
      // A late answer finds a newer read number and is dropped.
      reads.current += 1;
    };
  }, [load]);

  if (state.status === 'loading') {
    return (
      <div className="store-publisher">
        <BackButton />
        <ul
          className="store-results"
          role="status"
          aria-busy="true"
          aria-label={t('store.publisher.loading')}
        >
          {Array.from({ length: SKELETON_CARDS }, (_, index) => (
            <li key={index} className="skeleton-card" />
          ))}
        </ul>
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="store-publisher">
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

  const { platform, publisher } = state.page;
  if (publisher === null) {
    return (
      <div className="store-publisher">
        <BackButton />
        <section className="empty-panel store-gone" aria-labelledby="publisher-missing-title">
          <h2 id="publisher-missing-title" className="empty-panel-title">
            {t('store.publisher.notFound')}
          </h2>
          <p>{t('store.publisher.notFoundHint', { login })}</p>
        </section>
      </div>
    );
  }

  const name = publisher.displayName ?? publisher.login;
  const downloads = publisher.harnesses.reduce((sum, listing) => sum + listing.downloadCount, 0);
  return (
    <div className="store-publisher">
      <BackButton />
      <header className="publisher-header">
        <HarnessIcon name={name} iconUrl={publisher.avatarUrl} className="avatar avatar-large" />
        <div className="publisher-heading">
          <h2 id="publisher-title">{t('store.publisher.title', { name })}</h2>
          <p className="publisher-meta">
            <a
              href={`https://github.com/${publisher.login}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              @{publisher.login}
            </a>
            {publisher.joinedAt === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={publisher.joinedAt}>
                  {t('store.publisher.joined', {
                    date: i18n.formatDate(new Date(publisher.joinedAt), {
                      year: 'numeric',
                      month: 'long',
                    }),
                  })}
                </time>
              </>
            )}
          </p>
          {publisher.bio === null ? null : <p className="publisher-bio">{publisher.bio}</p>}
          <p className="publisher-meta">
            {t('store.publisher.totalDownloads', { count: i18n.formatNumber(downloads) })}
          </p>
        </div>
      </header>
      {publisher.harnesses.length === 0 ? (
        <div className="empty-panel">
          <p className="empty-panel-title">{t('store.publisher.empty')}</p>
        </div>
      ) : (
        <ul className="store-results" aria-labelledby="publisher-title">
          {publisher.harnesses.map((listing) => (
            <li key={listing.harnessId}>
              <StoreListingCard listing={listing} platform={platform} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
