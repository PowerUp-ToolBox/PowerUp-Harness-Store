import type { Platform, Tag } from '@harness-store/manifest';
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
import {
  STORE_SEARCH_PAGE_SIZE,
  type IpcError,
  type StoreListing,
  type StoreSearchPage,
} from '../../../shared/ipc.js';

/** How long typing must pause before the text is searched. */
export const SEARCH_DEBOUNCE_MS = 300;

/** What a search asks the Store: text, tags and platform together. */
export interface SearchFilters {
  readonly q: string;
  readonly tags: readonly Tag[];
  /** Every platform; false is "My platform only". */
  readonly allPlatforms: boolean;
}

/** The results of the search applied last. */
export type SearchResults =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly error: IpcError }
  | {
      readonly status: 'loaded';
      readonly platform: Platform | null;
      /** Every page loaded so far, in the Store's order, each Harness once. */
      readonly listings: readonly StoreListing[];
      /** The last page was full: "Load more" may find more. */
      readonly hasMore: boolean;
      /** The offset of the next page. */
      readonly nextOffset: number;
      /** Where "Load more" is: not asked, loading, or failed with this error. */
      readonly more: 'idle' | 'loading' | IpcError;
    };

/** Results the Store answered, which "Load more" extends. */
type LoadedResults = Extract<SearchResults, { readonly status: 'loaded' }>;

export interface StoreSearchState {
  /** The search box's text, as typed. */
  readonly input: string;
  readonly tags: readonly Tag[];
  readonly allPlatforms: boolean;
  /** What the results shown were searched with; null shows the Store home instead. */
  readonly applied: SearchFilters | null;
  /** The results of `applied`; null with it. */
  readonly results: SearchResults | null;
}

export interface StoreSearchContextValue {
  readonly state: StoreSearchState;
  /** The search box changed: searched 300 ms after the last change; blank and no tag is home. */
  readonly type: (input: string) => void;
  /**
   * The search box changed while an input method composes text (pinyin before a candidate is
   * picked): kept, not searched; `type` follows once the text is committed.
   */
  readonly compose: (input: string) => void;
  /** Enter: searches the box's text now, without waiting. */
  readonly submit: () => void;
  /** Selects or clears one tag chip, and searches now. */
  readonly toggleTag: (tag: Tag) => void;
  /** "My platform only" (false) or every platform (true); searches now when a search is shown. */
  readonly setAllPlatforms: (allPlatforms: boolean) => void;
  /** "Clear filters": no text and no tag, back to the Store home. */
  readonly clearFilters: () => void;
  /** Appends the next page of results. */
  readonly loadMore: () => void;
  /** Searches the applied filters again (after an error). */
  readonly retry: () => void;
}

const StoreSearchContext = createContext<StoreSearchContextValue | null>(null);

const INITIAL: StoreSearchState = {
  input: '',
  tags: [],
  allPlatforms: false,
  applied: null,
  results: null,
};

/** What a call that never reached the Runtime shows. */
const UNANSWERED: IpcError = {
  code: 'internal_error',
  messageKey: 'error.internal_error',
  message: 'Something went wrong inside Harness Store.',
};

/** Whether these filters search at all: text or a tag. The platform toggle alone does not. */
function searches(q: string, tags: readonly Tag[]): boolean {
  return q.trim() !== '' || tags.length > 0;
}

/** `listings` then the new ones of `page`, each Harness once (pages may overlap after a change). */
function merged(
  listings: readonly StoreListing[],
  page: readonly StoreListing[],
): readonly StoreListing[] {
  const seen = new Set(listings.map((listing) => listing.harnessId));
  const fresh = page.filter((listing) => {
    if (seen.has(listing.harnessId)) return false;
    seen.add(listing.harnessId);
    return true;
  });
  return [...listings, ...fresh];
}

/**
 * The Store search (P0-09.2): the search box's text, the tag chips, the platform toggle and the
 * results, held above the screens so that a detail page, a Publisher page or another tab and back
 * finds them as they were; kept in memory only. Typed text is searched 300 ms after the last
 * keystroke (text an input method is still composing waits until it is committed), Enter, a tag
 * and the toggle search at once. Results come from `store.search` a page of
 * 24 at a time in the Store's order; "Load more" appends the next page. Searches are numbered and
 * only the newest one's answers are kept, "Load more" included.
 */
export function StoreSearchProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<StoreSearchState>(INITIAL);
  /** The state as the last change left it, for the timer and the answers. */
  const current = useRef<StoreSearchState>(INITIAL);
  /** Numbers the searches; an answer for an older one is dropped. */
  const searchNumber = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commit = useCallback((change: (state: StoreSearchState) => StoreSearchState) => {
    current.current = change(current.current);
    setState(current.current);
  }, []);

  const cancelTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** Searches the filters as they are now; the Store home when they search nothing. */
  const apply = useCallback(() => {
    cancelTimer();
    const number = ++searchNumber.current;
    const { input, tags, allPlatforms } = current.current;
    if (!searches(input, tags)) {
      commit((state) => ({ ...state, applied: null, results: null }));
      return;
    }
    const filters: SearchFilters = { q: input.trim(), tags, allPlatforms };
    commit((state) => ({ ...state, applied: filters, results: { status: 'loading' } }));
    const settle = (results: SearchResults) => {
      if (number === searchNumber.current) commit((state) => ({ ...state, results }));
    };
    window.api.store.search({ ...filters, offset: 0 }).then(
      (result) => {
        settle(
          result.ok
            ? {
                status: 'loaded',
                platform: result.data.platform,
                listings: merged([], result.data.listings),
                hasMore: result.data.hasMore,
                nextOffset: STORE_SEARCH_PAGE_SIZE,
                more: 'idle',
              }
            : { status: 'failed', error: result.error },
        );
      },
      () => {
        settle({ status: 'failed', error: UNANSWERED });
      },
    );
  }, [cancelTimer, commit]);

  const type = useCallback(
    (input: string) => {
      commit((state) => ({ ...state, input }));
      cancelTimer();
      // Emptying the box goes home at once; there is nothing to wait for.
      if (!searches(input, current.current.tags)) {
        apply();
        return;
      }
      timer.current = setTimeout(apply, SEARCH_DEBOUNCE_MS);
    },
    [apply, cancelTimer, commit],
  );

  const compose = useCallback(
    (input: string) => {
      commit((state) => ({ ...state, input }));
      // A search still waiting would read the uncommitted text.
      cancelTimer();
    },
    [cancelTimer, commit],
  );

  const toggleTag = useCallback(
    (tag: Tag) => {
      commit((state) => ({
        ...state,
        tags: state.tags.includes(tag)
          ? state.tags.filter((selected) => selected !== tag)
          : [...state.tags, tag],
      }));
      apply();
    },
    [apply, commit],
  );

  const setAllPlatforms = useCallback(
    (allPlatforms: boolean) => {
      commit((state) => ({ ...state, allPlatforms }));
      // The toggle alone keeps the Store home, which is never filtered by platform.
      if (current.current.applied !== null || timer.current !== null) apply();
    },
    [apply, commit],
  );

  const clearFilters = useCallback(() => {
    commit((state) => ({ ...state, input: '', tags: [] }));
    apply();
  }, [apply, commit]);

  const loadMore = useCallback(() => {
    const { applied, results } = current.current;
    if (applied === null || results?.status !== 'loaded' || results.more === 'loading') return;
    const number = searchNumber.current;
    const offset = results.nextOffset;
    const settle = (change: (loaded: LoadedResults) => LoadedResults) => {
      if (number !== searchNumber.current) return;
      commit((state) =>
        state.results?.status === 'loaded' ? { ...state, results: change(state.results) } : state,
      );
    };
    settle((loaded) => ({ ...loaded, more: 'loading' }));
    const fail = (error: IpcError) => {
      settle((loaded) => ({ ...loaded, more: error }));
    };
    window.api.store.search({ ...applied, offset }).then(
      (result) => {
        if (!result.ok) {
          fail(result.error);
          return;
        }
        const page: StoreSearchPage = result.data;
        settle((loaded) => ({
          ...loaded,
          listings: merged(loaded.listings, page.listings),
          hasMore: page.hasMore,
          nextOffset: offset + STORE_SEARCH_PAGE_SIZE,
          more: 'idle',
        }));
      },
      () => {
        fail(UNANSWERED);
      },
    );
  }, [commit]);

  useEffect(() => cancelTimer, [cancelTimer]);

  const value = useMemo<StoreSearchContextValue>(
    () => ({
      state,
      type,
      compose,
      submit: apply,
      toggleTag,
      setAllPlatforms,
      clearFilters,
      loadMore,
      retry: apply,
    }),
    [state, type, compose, apply, toggleTag, setAllPlatforms, clearFilters, loadMore],
  );
  return <StoreSearchContext.Provider value={value}>{children}</StoreSearchContext.Provider>;
}

export function useStoreSearch(): StoreSearchContextValue {
  const value = useContext(StoreSearchContext);
  if (value === null) throw new Error('useStoreSearch must be used inside <StoreSearchProvider>');
  return value;
}
