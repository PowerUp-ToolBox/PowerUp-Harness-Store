import type { Manifest, ModelSlot } from '@harness-store/manifest';
import type { ReactNode } from 'react';
import { trustFactsOf } from '../../../shared/permissions.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { requirementsText } from '../models/requirements.js';
import { HarnessIcon, PlatformBadges, TagChips } from './HarnessCard.js';
import { TrustBlock } from './TrustBlock.js';

/** One entry of the version history, newest first. */
export interface ListedVersion {
  readonly version: string;
  /** The Manifest's changelog of that version, shown as plain text. */
  readonly changelog?: string;
}

export interface ListingDetailProps {
  /** The Manifest of the version the page shows (the latest one in the Store). */
  readonly manifest: Manifest;
  /** The Publisher, as their GitHub profile names them. */
  readonly publisher: { readonly login: string; readonly avatarUrl: string | null };
  /** The icon's URL (a `data:` URL in the Publish preview), null for the monogram. */
  readonly iconUrl: string | null;
  readonly downloads: number;
  /** README.md, shown as plain text; null when the Harness has none. */
  readonly readme: string | null;
  readonly versions: readonly ListedVersion[];
  /** The primary action under the summary (Install, Launch: P0-09, P0-10); none in the preview. */
  readonly actions?: ReactNode;
}

/**
 * A Harness's Store detail page (docs/ux/design-principles.md §2), built from its Manifest: the
 * header (icon, name, Publisher, Harness ID, summary, downloads, platform badges, tags), the trust
 * block, the Models block (each Model Slot with its description, Model Requirements and
 * Recommended Models), the README, the version history with changelogs and the footer (license,
 * homepage, source). The Publish screen's listing preview shows it now; P0-09 reuses it for the
 * Store, adding screenshots, the "Will use" note per Slot and Report, and rendering the README and
 * changelogs as sanitised Markdown (plain text until then).
 */
export function ListingDetail({
  manifest,
  publisher,
  iconUrl,
  downloads,
  readme,
  versions,
  actions,
}: ListingDetailProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const slots = Object.entries(manifest.models.slots).sort(
    ([a], [b]) => Number(a !== 'default') - Number(b !== 'default'),
  );
  return (
    <article className="listing-detail" aria-label={manifest.name}>
      <header className="listing-detail-header">
        <HarnessIcon name={manifest.name} iconUrl={iconUrl} className="listing-detail-icon" />
        <div className="listing-detail-heading">
          <h3 className="listing-detail-name">{manifest.name}</h3>
          <p className="listing-detail-publisher">
            {publisher.avatarUrl === null ? null : (
              <img className="avatar avatar-small" src={publisher.avatarUrl} alt="" />
            )}
            <span>{t('listing.by', { publisher: publisher.login })}</span>
            <span aria-hidden="true">·</span>
            <code>{manifest.id}</code>
          </p>
          <p className="listing-detail-summary">{manifest.summary}</p>
          {actions}
          <div className="listing-detail-meta">
            <span>{t('listing.downloads', { count: downloads })}</span>
            <PlatformBadges platforms={manifest.platforms} />
          </div>
          <TagChips tags={manifest.tags ?? []} />
        </div>
      </header>

      <section className="listing-section">
        <h4>{t('listing.permissions')}</h4>
        <TrustBlock facts={trustFactsOf(manifest)} />
      </section>

      <section className="listing-section">
        <h4>{t('listing.models')}</h4>
        <ul className="listing-slots">
          {slots.map(([name, slot]) => (
            <SlotRow key={name} name={name} slot={slot} />
          ))}
        </ul>
      </section>

      <section className="listing-section">
        <h4>{t('listing.about')}</h4>
        {readme === null ? (
          <p className="hint">{t('listing.noReadme')}</p>
        ) : (
          <div className="listing-text">{readme}</div>
        )}
      </section>

      <section className="listing-section">
        <h4>{t('listing.versionHistory')}</h4>
        <ol className="listing-versions">
          {versions.map((entry) => (
            <li key={entry.version}>
              <span className="listing-version">{entry.version}</span>
              {entry.changelog === undefined ? null : (
                <div className="listing-text">{entry.changelog}</div>
              )}
            </li>
          ))}
        </ol>
      </section>

      <footer className="listing-detail-footer">
        <span>{t('listing.license', { license: manifest.license })}</span>
        {manifest.homepage === undefined ? null : (
          <a href={manifest.homepage} target="_blank" rel="noreferrer">
            {t('listing.homepage')}
          </a>
        )}
        {manifest.sourceRepo === undefined ? null : (
          <a href={manifest.sourceRepo} target="_blank" rel="noreferrer">
            {t('listing.source')}
          </a>
        )}
      </footer>
    </article>
  );
}

/** One Model Slot: its name and description, Model Requirements and Recommended Models. */
function SlotRow({ name, slot }: { readonly name: string; readonly slot: ModelSlot }) {
  const i18n = useI18n();
  const needs = requirementsText(i18n, slot.requirements);
  return (
    <li className="listing-slot">
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
    </li>
  );
}
