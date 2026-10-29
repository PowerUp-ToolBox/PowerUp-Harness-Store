import type { Platform, Tag } from '@harness-store/manifest';
import { Link } from 'react-router';
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

/**
 * The platform IDs a Harness runs on, as badges. With `current` (this machine's platform), its
 * badge is highlighted when the Harness declares it, and a greyed badge for it, marked not
 * supported, is added when it does not.
 */
export function PlatformBadges({
  platforms,
  current = null,
}: {
  readonly platforms: readonly Platform[];
  readonly current?: Platform | null;
}) {
  const { t } = useI18n();
  return (
    <ul className="platform-badges" aria-label={t('listing.platforms')}>
      {platforms.map((platform) => (
        <li key={platform} className={platform === current ? 'current' : undefined}>
          {platform}
          {platform === current ? (
            <span className="visually-hidden">{t('listing.platform.current')}</span>
          ) : null}
        </li>
      ))}
      {current === null || platforms.includes(current) ? null : (
        <li className="unsupported">
          {current}
          <span className="visually-hidden">{t('listing.platform.unsupported')}</span>
        </li>
      )}
    </ul>
  );
}

/** A Harness's tags, as translated chips. */
export function TagChips({ tags }: { readonly tags: readonly Tag[] }) {
  const { t } = useI18n();
  return tags.length === 0 ? null : (
    <ul className="tag-chips" aria-label={t('listing.tags')}>
      {tags.map((tag) => (
        <li key={tag}>{t(tagKey(tag))}</li>
      ))}
    </ul>
  );
}

/** The catalog key of a tag's name: typed, so a schema tag without an entry fails typecheck. */
export function tagKey(tag: Tag): `tag.${Tag}` {
  return `tag.${tag}`;
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
  readonly tags?: readonly Tag[];
  /** This machine's platform, highlighted among the badges (see {@link PlatformBadges}). */
  readonly currentPlatform?: Platform | null;
  /** The route of the Harness's detail page; the whole card opens it. None in the preview. */
  readonly href?: string;
  /** The route of the Publisher's page, linked from their login. None in the preview. */
  readonly publisherHref?: string;
}

/**
 * A Store card (docs/ux/screens.md, Store home): icon, name, Publisher, summary, download count,
 * platform badges and tags. The Store's lists and the Publish screen's listing preview show it.
 * With `href`, the name is a link stretched over the whole card; the Publisher's login is a link
 * of its own above it, so no link is nested in another.
 */
export function HarnessCard({
  name,
  publisher,
  summary,
  iconUrl,
  downloads,
  platforms,
  tags = [],
  currentPlatform = null,
  href,
  publisherHref,
}: HarnessCardProps) {
  const { t } = useI18n();
  return (
    <article className="listing-card" aria-label={name}>
      <HarnessIcon name={name} iconUrl={iconUrl} />
      <div className="listing-card-text">
        <h3 className="listing-card-name">
          {href === undefined ? (
            name
          ) : (
            <Link className="listing-card-link" to={href}>
              {name}
            </Link>
          )}
        </h3>
        <p className="listing-card-summary">{summary}</p>
        <p className="listing-card-meta">
          {publisherHref === undefined ? (
            publisher
          ) : (
            <Link className="listing-card-publisher" to={publisherHref}>
              {publisher}
            </Link>
          )}
          {' · '}
          {t('listing.downloads', { count: downloads })}
        </p>
        <PlatformBadges platforms={platforms} current={currentPlatform} />
        <TagChips tags={tags} />
      </div>
    </article>
  );
}
