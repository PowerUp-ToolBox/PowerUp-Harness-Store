import { useEffect, useState } from 'react';
import { TAGS } from '../../../shared/tags.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { tagKey } from '../listing/HarnessCard.js';
import { SearchIcon } from '../shell/icons.js';
import { StoreListingCard } from './StoreListingCard.js';
import { useStoreSearch, type SearchResults } from './StoreSearchProvider.js';

/** The skeleton cards the results show while a search is under way. */
const SKELETON_CARDS = 4;

/** The longest text the search box takes (`store.search` takes no more). */
const MAX_SEARCH_LENGTH = 200;

/**
 * The Store's filter row (docs/ux/screens.md, Store search): the search box, the curated tags as
 * chips in the Manifest schema's order, and "My platform only", on by default. Enter searches at
 * once; typing searches once it pauses for 300 ms.
 */
export function StoreFilters() {
  const { t } = useI18n();
  const { state, type, submit, toggleTag, setAllPlatforms } = useStoreSearch();
  return (
    <div className="store-filters">
      <form
        role="search"
        className="store-search"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SearchIcon />
        <input
          type="search"
          aria-label={t('store.search.label')}
          placeholder={t('store.search.label')}
          maxLength={MAX_SEARCH_LENGTH}
          value={state.input}
          onChange={(event) => {
            type(event.target.value);
          }}
        />
      </form>
      <div className="store-filter-row">
        <ul className="filter-chips" aria-label={t('store.search.tags')}>
          {TAGS.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                className="filter-chip"
                aria-pressed={state.tags.includes(tag)}
                onClick={() => {
                  toggleTag(tag);
                }}
              >
                {t(tagKey(tag))}
              </button>
            </li>
          ))}
        </ul>
        <label className="checkbox store-platform-filter">
          <input
            type="checkbox"
            checked={!state.allPlatforms}
            onChange={(event) => {
              setAllPlatforms(!event.target.checked);
            }}
          />
          {t('store.search.myPlatform')}
        </label>
      </div>
    </div>
  );
}

/**
 * The results of the applied search, replacing the Store home: cards in the Store's order, with
 * "Load more" while the last page was full; skeletons while it searches; "No Harnesses match" with
 * Clear filters; an inline error with Retry. Coming back to it after a failure searches again.
 */
export function StoreSearchResults({ results }: { readonly results: SearchResults }) {
  const { t } = useI18n();
  const { clearFilters, loadMore, retry } = useStoreSearch();
  const failed = results.status === 'failed';

  // The Store tab mounts afresh once the Store answers again (StoreGate): a search that failed
  // is searched again as the results open. A failure while they are shown waits for Retry.
  const [failedAsOpened] = useState(failed);
  useEffect(() => {
    if (failedAsOpened) retry();
  }, [failedAsOpened, retry]);

  if (results.status === 'loading') {
    return (
      <ul
        className="store-results"
        role="status"
        aria-busy="true"
        aria-label={t('store.search.searching')}
      >
        {Array.from({ length: SKELETON_CARDS }, (_, index) => (
          <li key={index} className="skeleton-card" />
        ))}
      </ul>
    );
  }
  if (results.status === 'failed') {
    return (
      <section className="store-error" aria-labelledby="store-search-error-title">
        <h2 id="store-search-error-title">{t('store.loadFailed')}</h2>
        <ErrorMessage error={results.error} />
        <button type="button" className="button-primary" onClick={retry}>
          {t('connectivity.retry')}
        </button>
      </section>
    );
  }
  if (results.listings.length === 0) {
    return (
      <div className="empty-panel store-no-results">
        <p className="empty-panel-title">{t('store.search.noMatch')}</p>
        <p className="hint">{t('store.search.noMatchHint')}</p>
        <button type="button" className="button-secondary" onClick={clearFilters}>
          {t('store.search.clearFilters')}
        </button>
      </div>
    );
  }
  const { more } = results;
  return (
    <div className="store-search-results">
      <ul className="store-results" aria-label={t('store.search.results')}>
        {results.listings.map((listing) => (
          <li key={listing.harnessId}>
            <StoreListingCard listing={listing} platform={results.platform} />
          </li>
        ))}
      </ul>
      {typeof more === 'object' ? <ErrorMessage error={more} /> : null}
      {results.hasMore ? (
        <button
          type="button"
          className="button-secondary store-load-more"
          disabled={more === 'loading'}
          aria-busy={more === 'loading'}
          onClick={loadMore}
        >
          {more === 'loading' ? <span className="spinner" aria-hidden="true" /> : null}
          {t('store.search.loadMore')}
        </button>
      ) : null}
    </div>
  );
}
