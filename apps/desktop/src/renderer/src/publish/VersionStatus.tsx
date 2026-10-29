import type { FolderValidation } from '../../../shared/ipc.js';
import { useI18n } from '../i18n/I18nProvider.js';

/** "New Harness", the last version the Store has, or that the Store could not be asked. */
export function VersionStatus({ validation }: { readonly validation: FolderValidation }) {
  const { t } = useI18n();
  if (validation.versionCheck === 'failed') {
    return <p className="hint">{t('publish.versionCheckFailed')}</p>;
  }
  if (validation.isNew)
    return <p className="badge publish-version-badge">{t('publish.newHarness')}</p>;
  if (validation.lastPublishedVersion !== null) {
    return (
      <p className="hint">
        {t('publish.lastVersion', { version: validation.lastPublishedVersion })}
      </p>
    );
  }
  return null;
}
