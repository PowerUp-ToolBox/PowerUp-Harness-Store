import type { Manifest } from '@harness-store/manifest';
import type { FolderValidation } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { HarnessCard } from '../listing/HarnessCard.js';
import { ListingDetail } from '../listing/ListingDetail.js';
import { VersionStatus } from './VersionStatus.js';

/** The signed-in Publisher, as the listing preview shows them. */
export interface PublisherIdentity {
  readonly login: string;
  readonly avatarUrl: string | null;
}

/** Above this size (100 MiB) the review warns; it never blocks. */
export const LARGE_PACKAGE_BYTES = 100 * 1024 * 1024;

/**
 * The review step (flow F5, steps 4 and 5 in one): the facts the listing takes from the Manifest,
 * read-only (nothing is edited in P0), the changelog, what the Harness Package leaves out and its
 * size, then the listing as the Store will show it: its card and its detail page, built from the
 * Manifest with the signed-in Publisher and no downloads yet. Screenshots are not previewed.
 */
export function PublishReview({
  validation,
  manifest,
  publisher,
  onBack,
}: {
  readonly validation: FolderValidation;
  readonly manifest: Manifest;
  readonly publisher: PublisherIdentity;
  readonly onBack: () => void;
}) {
  const { t, formatBytes } = useI18n();
  const facts: readonly (readonly [string, string])[] = [
    ['id', manifest.id],
    ['version', manifest.version],
    ['name', manifest.name],
    ['summary', manifest.summary],
    ['platforms', manifest.platforms.join(', ')],
    ['runtime', manifest.runtime.kind],
    ['ui', manifest.ui.kind],
    ['workspace', manifest.workspace ?? 'none'],
    ['models.slots', Object.keys(manifest.models.slots).join(', ')],
  ];
  return (
    <div className="publish-review">
      <section className="publish-review-section" aria-labelledby="publish-facts-title">
        <h2 id="publish-facts-title">{t('publish.review.facts')}</h2>
        <dl className="publish-facts">
          {facts.map(([key, value]) => (
            <div key={key}>
              <dt>
                <code>{key}</code>
              </dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <VersionStatus validation={validation} />
        <h3>{t('publish.review.changelog')}</h3>
        {manifest.changelog === undefined ? (
          <p className="hint">{t('publish.review.noChangelog')}</p>
        ) : (
          <div className="listing-text">{manifest.changelog}</div>
        )}
        <h3>{t('publish.review.excluded')}</h3>
        {validation.excluded.length === 0 ? (
          <p className="hint">{t('publish.review.excludedNone')}</p>
        ) : (
          <ul className="publish-excluded">
            {validation.excluded.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        )}
        <p>{t('publish.review.size', { size: formatBytes(validation.archiveSize) })}</p>
        {validation.archiveSize > LARGE_PACKAGE_BYTES ? (
          <p className="warning-panel" role="note">
            {t('publish.review.sizeWarning')}
          </p>
        ) : null}
      </section>

      <section className="publish-review-section" aria-labelledby="publish-preview-title">
        <h2 id="publish-preview-title">{t('publish.preview')}</h2>
        <h3>{t('publish.preview.card')}</h3>
        <HarnessCard
          name={manifest.name}
          publisher={publisher.login}
          summary={manifest.summary}
          iconUrl={validation.iconDataUrl}
          downloads={0}
          platforms={manifest.platforms}
        />
        <h3>{t('publish.preview.detail')}</h3>
        <ListingDetail
          manifest={manifest}
          publisher={publisher}
          iconUrl={validation.iconDataUrl}
          downloads={0}
          readme={validation.readme}
          versions={[
            {
              version: manifest.version,
              ...(manifest.changelog === undefined ? {} : { changelog: manifest.changelog }),
            },
          ]}
        />
      </section>

      <div className="publish-actions">
        <button type="button" className="button-secondary" onClick={onBack}>
          {t('publish.back')}
        </button>
      </div>
    </div>
  );
}
