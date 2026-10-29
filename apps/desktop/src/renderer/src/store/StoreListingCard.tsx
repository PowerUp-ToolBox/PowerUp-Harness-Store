import type { Platform } from '@harness-store/manifest';
import type { StoreListing } from '../../../shared/ipc.js';
import { HarnessCard } from '../listing/HarnessCard.js';

/**
 * A Harness of a Store list as its card: the shared {@link HarnessCard}, opening the Harness's
 * detail page, with the Publisher's login opening theirs and `platform` (this machine's)
 * highlighted among the badges.
 */
export function StoreListingCard({
  listing,
  platform,
}: {
  readonly listing: StoreListing;
  readonly platform: Platform | null;
}) {
  return (
    <HarnessCard
      name={listing.name}
      publisher={listing.publisher}
      summary={listing.summary}
      iconUrl={listing.iconUrl}
      downloads={listing.downloadCount}
      platforms={listing.platforms}
      tags={listing.tags}
      currentPlatform={platform}
      href={`/store/h/${listing.harnessId}`}
      publisherHref={`/store/p/${listing.publisher}`}
    />
  );
}
