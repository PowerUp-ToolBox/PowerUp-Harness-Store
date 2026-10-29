import { StoreHome } from '../store/StoreHome.js';
import { StoreFilters, StoreSearchResults } from '../store/StoreSearch.js';
import { useStoreSearch } from '../store/StoreSearchProvider.js';

/**
 * The Store tab: the filter row over the Store home (P0-09.1), which the results of a search
 * replace once it has text or a tag (P0-09.2).
 */
export function StorePage() {
  const { state } = useStoreSearch();
  return (
    <div className="store-page">
      <StoreFilters />
      {state.results === null ? <StoreHome /> : <StoreSearchResults results={state.results} />}
    </div>
  );
}
