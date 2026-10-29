import { diffForReconsent, type Manifest } from '@harness-store/manifest';
import { useEffect, useId, useState } from 'react';
import { reconsentChanges, trustFactsOf } from '../../../shared/permissions.js';
import type { InstalledHarness } from '../../../shared/ipc.js';
import { Modal } from '../components/Modal.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { Markdown } from '../listing/Markdown.js';
import { TrustBlock } from '../listing/TrustBlock.js';
import { CONSENT_READ_DELAY_MS } from './ConsentDialog.js';

export interface UpdatePromptProps {
  /** The installed Harness: the version the User consented to. */
  readonly install: Pick<InstalledHarness, 'name' | 'version' | 'manifest'>;
  /** The Manifest of the version to update to. */
  readonly target: Manifest;
  /** The User consented: the update downloads and installs with `reconsented`. */
  readonly onUpdate: () => void;
  /** Not now, Escape or the backdrop: nothing is downloaded. */
  readonly onClose: () => void;
}

/**
 * The update prompt when re-consent is required (docs/ux/screens.md, "Update prompt"; flows F4
 * step 2): an update that widens the Declared Permissions or changes the Entry or the runtime kind
 * (`diffForReconsent`) asks for the User's consent again, before anything is downloaded. It shows
 * the versions from and to, "What changed" (`reconsentChanges`: one "New:" line per permission
 * the version adds or widens and per Entry or runtime change, in the permission list's words; what
 * was removed or narrowed is not listed, except a platform's lost Entry when nothing else explains
 * the re-consent), the version's changelog, and the trust block of the new version with the
 * standing no-sandbox sentence. Update is enabled one second after it opens, as the install
 * consent dialog's Install is; Not now and Escape close it.
 *
 * An update that needs no consent again has no prompt: Update downloads and installs it at once.
 */
export function UpdatePrompt({ install, target, onUpdate, onClose }: UpdatePromptProps) {
  const { t, locale } = useI18n();
  const [armed, setArmed] = useState(false);
  const changesId = useId();
  const changelogId = useId();

  useEffect(() => {
    const timer = setTimeout(() => {
      setArmed(true);
    }, CONSENT_READ_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  const changes = reconsentChanges(diffForReconsent(install.manifest, target));
  /** "New: runs shell commands": in English the sentence continues the prefix. */
  const continued = (text: string) =>
    locale === 'en' ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;

  return (
    <Modal title={t('update.title', { version: target.version })} onClose={onClose}>
      <p className="update-from-to">
        {t('update.fromTo', { name: install.name, from: install.version, to: target.version })}
      </p>
      <section className="update-section" aria-labelledby={changesId}>
        <h3 id={changesId} className="update-section-title">
          {t('update.whatChanged')}
        </h3>
        <ul className="update-changes">
          {changes.map((change) => (
            <li
              key={change.item}
              className="update-change"
              data-severity={change.severity ?? 'fact'}
            >
              {change.markedNew
                ? t('update.new', { change: continued(t(change.messageKey, change.params)) })
                : t(change.messageKey, change.params)}
            </li>
          ))}
        </ul>
      </section>
      <section className="update-section" aria-labelledby={changelogId}>
        <h3 id={changelogId} className="update-section-title">
          {t('update.changelog')}
        </h3>
        {target.changelog === undefined || target.changelog.trim() === '' ? (
          <p className="hint">{t('update.noChangelog')}</p>
        ) : (
          <div className="update-changelog">
            <Markdown source={target.changelog} />
          </div>
        )}
      </section>
      <TrustBlock facts={trustFactsOf(target)} platforms={target.platforms} />
      <div className="modal-actions">
        <button type="button" className="button-secondary" onClick={onClose}>
          {t('update.notNow')}
        </button>
        <button type="button" className="button-primary" disabled={!armed} onClick={onUpdate}>
          {t('update.update')}
        </button>
      </div>
    </Modal>
  );
}
