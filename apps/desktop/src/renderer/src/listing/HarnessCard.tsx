import type { Platform } from '@harness-store/manifest';
import { useI18n } from '../i18n/I18nProvider.js';

/** A Harness's icon, or the first letter of its name when it has none. */
export function HarnessIcon({
  name,
  iconUrl,
  className = 'harness-icon',
}: {
  readonly name: string;
  readonly iconUrl: string | null;
  readonly className?: string;
}) {
  return iconUrl === null ? (
    <span className={`${className} monogram`} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  ) : (
    <img className={className} src={iconUrl} alt="" />
  );
}

/** The platform IDs a Harness runs on, as badges. */
export function PlatformBadges({ platforms }: { readonly platforms: readonly Platform[] }) {
  const { t } = useI18n();
  return (
    <ul className="platform-badges" aria-label={t('listing.platforms')}>
      {platforms.map((platform) => (
        <li key={platform}>{platform}</li>
      ))}
    </ul>
  );
}

export interface HarnessCardProps {
  readonly name: string;
  /** The Publisher's GitHub login. */
  readonly publisher: string;
  readonly summary: string;
  /** The icon's URL (a `data:` URL in the Publish preview), null for the monogram. */
  readonly iconUrl: string | null;
  readonly downloads: number;
  readonly platforms: readonly Platform[];
}

/**
 * A Store card (docs/ux/screens.md, Store home): icon, name, Publisher, summary, download count
 * and platform badges. The Publish screen's listing preview shows it now; the Store's lists
 * (P0-09) reuse it.
 */
export function HarnessCard({
  name,
  publisher,
  summary,
  iconUrl,
  downloads,
  platforms,
}: HarnessCardProps) {
  const { t } = useI18n();
  return (
    <article className="listing-card" aria-label={name}>
      <HarnessIcon name={name} iconUrl={iconUrl} />
      <div className="listing-card-text">
        <h3 className="listing-card-name">{name}</h3>
        <p className="listing-card-summary">{summary}</p>
        <p className="listing-card-meta">
          {t('listing.card.subtitle', {
            publisher,
            downloads: t('listing.downloads', { count: downloads }),
          })}
        </p>
        <PlatformBadges platforms={platforms} />
      </div>
    </article>
  );
}
