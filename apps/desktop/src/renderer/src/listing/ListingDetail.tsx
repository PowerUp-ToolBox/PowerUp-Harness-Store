import type { Manifest, ModelSlot, Platform } from '@harness-store/manifest';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { trustFactsOf } from '../../../shared/permissions.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { requirementsText } from '../models/requirements.js';
import { HarnessIcon, PlatformBadges, TagChips } from './HarnessCard.js';
import { Markdown } from './Markdown.js';
import { TrustBlock } from './TrustBlock.js';

/** One entry of the version history, newest first. */
export interface ListedVersion {
  readonly version: string;
  /** When it was published (ISO-8601); none in the Publish preview. */
  readonly publishedAt?: string;
  /** The Manifest's changelog of that version, Markdown. */
  readonly changelog?: string | null;
  /** Its Declared Permissions differ from the next older version's. */
  readonly permissionsChanged?: boolean;
}

/** What a Model Slot would use on this machine: `Connection · model`, or null when nothing can. */
export type SlotUse = string | null;

export interface ListingDetailProps {
  /** The Manifest of the version the page shows (the latest one in the Store). */
  readonly manifest: Manifest;
  /** The Publisher, as their Store profile names them, and the route of their page, if any. */
  readonly publisher: {
    readonly login: string;
    readonly displayName?: string | null;
    readonly avatarUrl: string | null;
    readonly href?: string;
  };
  /** The icon's URL (a `data:` URL in the Publish preview), null for the monogram. */
  readonly iconUrl: string | null;
  /** All versions' downloads; null when not known (an install the Store no longer lists). */
  readonly downloads: number | null;
  /** README.md, Markdown; null when the Harness has none. */
  readonly readme: string | null;
  readonly versions: readonly ListedVersion[];
  /** `store-asset:` URLs of the screenshots; none in the Publish preview. */
  readonly screenshots?: readonly string[];
  /** This machine's platform, highlighted among the badges. */
  readonly currentPlatform?: Platform | null;
  /** The installed version, marked in the version history. */
  readonly installedVersion?: string | null;
  /** By Slot name, what each Model Slot would use here ("Will use"); none in the preview. */
  readonly slotUses?: ReadonlyMap<string, SlotUse>;
  /** The primary action under the summary (Install, Launch: P0-09, P0-10); none in the preview. */
  readonly actions?: ReactNode;
  /** After the footer's links (the detail page's Report). */
  readonly footer?: ReactNode;
  /** The level of the Harness's name: 2 on its own page, 3 (the default) inside the preview. */
  readonly headingLevel?: 2 | 3;
}

/**
 * A Harness's Store detail page (docs/ux/design-principles.md §2), built from its Manifest, one
 * component for the Store detail page and the Publish screen's listing preview so the two never
 * differ. Top to bottom: the header (icon, name, version, Publisher, Harness ID, summary, the
 * primary action, downloads, platform badges, tags), the screenshots, the trust block (Declared
 * Permissions, how it runs, the no-sandbox sentence), the Models block (each Model Slot with its
 * description, Model Requirements, Recommended Models and what it would use here), the README and
 * the version history with changelogs, both as sanitised Markdown, and the footer (license,
 * homepage, source).
 *
 * Every Manifest field has its place but these, which say nothing to a User deciding whether to
 * install: `manifestVersion`, `$schema`, `x-*`, `entry`, `ui.path`, `ui.readyTimeoutSeconds`,
 * `ui.window`, `runtime.node` and `channel`.
 */
export function ListingDetail({
  manifest,
  publisher,
  iconUrl,
  downloads,
  readme,
  versions,
  screenshots = [],
  currentPlatform = null,
  installedVersion = null,
  slotUses,
  actions,
  footer,
  headingLevel = 3,
}: ListingDetailProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const Name = headingLevel === 2 ? 'h2' : 'h3';
  const Section = headingLevel === 2 ? 'h3' : 'h4';
  const slots = Object.entries(manifest.models.slots).sort(
    ([a], [b]) => Number(a !== 'default') - Number(b !== 'default'),
  );
  const publisherName = publisher.displayName ?? publisher.login;
  const avatar =
    publisher.avatarUrl === null ? null : (
      <img className="avatar avatar-small" src={publisher.avatarUrl} alt="" />
    );
  return (
    <article className="listing-detail" aria-label={manifest.name}>
      <header className="listing-detail-header">
        <HarnessIcon name={manifest.name} iconUrl={iconUrl} className="listing-detail-icon" />
        <div className="listing-detail-heading">
          <Name className="listing-detail-name">{manifest.name}</Name>
          <p className="listing-detail-publisher">
            {publisher.href === undefined ? (
              <>
                {avatar}
                <span>{t('listing.by', { publisher: publisherName })}</span>
              </>
            ) : (
              // The avatar and the name are one link to the Publisher's page.
              <Link className="listing-detail-publisher-link" to={publisher.href}>
                {avatar}
                <span>{t('listing.by', { publisher: publisherName })}</span>
              </Link>
            )}
            <span aria-hidden="true">·</span>
            <code>{manifest.id}</code>
            <span aria-hidden="true">·</span>
            <span>{t('listing.version', { version: manifest.version })}</span>
          </p>
          <p className="listing-detail-summary">{manifest.summary}</p>
          {actions === undefined ? null : <div className="listing-detail-actions">{actions}</div>}
          <div className="listing-detail-meta">
            {downloads === null ? null : (
              <span>{t('listing.downloads', { count: downloads })}</span>
            )}
            <PlatformBadges platforms={manifest.platforms} current={currentPlatform} />
          </div>
          <TagChips tags={manifest.tags ?? []} />
        </div>
      </header>

      {screenshots.length === 0 ? null : (
        <section className="listing-section" aria-label={t('listing.screenshots')}>
          <Section>{t('listing.screenshots')}</Section>
          <ul className="listing-screenshots">
            {screenshots.map((url, index) => (
              <li key={url}>
                <img src={url} alt={t('listing.screenshot', { number: index + 1 })} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="listing-section" aria-label={t('listing.permissions')}>
        <Section>{t('listing.permissions')}</Section>
        <TrustBlock facts={trustFactsOf(manifest)} />
      </section>

      <section className="listing-section" aria-label={t('listing.models')}>
        <Section>{t('listing.models')}</Section>
        <ul className="listing-slots">
          {slots.map(([name, slot]) => (
            <SlotRow
              key={name}
              name={name}
              slot={slot}
              use={slotUses === undefined ? undefined : (slotUses.get(name) ?? null)}
            />
          ))}
        </ul>
      </section>

      <section className="listing-section" aria-label={t('listing.about')}>
        <Section>{t('listing.about')}</Section>
        {readme === null ? (
          <p className="hint">{t('listing.noReadme')}</p>
        ) : (
          <Markdown source={readme} />
        )}
      </section>

      <section className="listing-section" aria-label={t('listing.versionHistory')}>
        <Section>{t('listing.versionHistory')}</Section>
        <ol className="listing-versions">
          {versions.map((entry) => (
            <li key={entry.version} className="listing-version-entry">
              <span className="listing-version-title">
                <span className="listing-version">{entry.version}</span>
                {entry.publishedAt === undefined ? null : (
                  <time className="listing-version-date" dateTime={entry.publishedAt}>
                    {i18n.formatDate(new Date(entry.publishedAt), { dateStyle: 'medium' })}
                  </time>
                )}
                {entry.version === installedVersion ? (
                  <span className="badge">{t('listing.installed')}</span>
                ) : null}
                {entry.permissionsChanged === true ? (
                  <span className="badge badge-warning">{t('listing.permissionsChanged')}</span>
                ) : null}
              </span>
              {entry.changelog === undefined || entry.changelog === null ? null : (
                <Markdown source={entry.changelog} />
              )}
            </li>
          ))}
        </ol>
      </section>

      <footer className="listing-detail-footer">
        <span>{t('listing.license', { license: manifest.license })}</span>
        {manifest.homepage === undefined ? null : (
          <a href={manifest.homepage} target="_blank" rel="noopener noreferrer">
            {t('listing.homepage')}
          </a>
        )}
        {manifest.sourceRepo === undefined ? null : (
          <a href={manifest.sourceRepo} target="_blank" rel="noopener noreferrer">
            {t('listing.source')}
          </a>
        )}
        {footer}
      </footer>
    </article>
  );
}

/**
 * One Model Slot: its name and description, Model Requirements, Recommended Models and, on the
 * Store detail page, what it would use on this machine.
 */
function SlotRow({
  name,
  slot,
  use,
}: {
  readonly name: string;
  readonly slot: ModelSlot;
  /** Undefined: not shown (the preview, or still resolving). */
  readonly use: SlotUse | undefined;
}) {
  const i18n = useI18n();
  const needs = requirementsText(i18n, slot.requirements);
  return (
    <li className="listing-slot" aria-label={name}>
      <span className="listing-slot-title">
        <code>{name}</code>
        {slot.description === undefined ? null : <span>{slot.description}</span>}
      </span>
      {needs === null ? null : <span className="listing-slot-note">{needs}</span>}
      {slot.recommended === undefined || slot.recommended.length === 0 ? null : (
        <span className="listing-slot-note">
          {i18n.t('listing.recommended', { models: slot.recommended.join(', ') })}
        </span>
      )}
      {use === undefined ? null : use === null ? (
        <span className="listing-slot-use" data-reachable="false">
          {i18n.t('listing.noConnection')}
        </span>
      ) : (
        <span className="listing-slot-use" data-reachable="true">
          {i18n.t('listing.willUse', { use })}
        </span>
      )}
    </li>
  );
}
