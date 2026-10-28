import type { ConnectionSummary, IpcError } from '../../../shared/ipc.js';
import { ErrorMessage } from '../components/ErrorMessage.js';
import { useI18n } from '../i18n/I18nProvider.js';
import { connectionName } from '../models/names.js';
import type { DefaultModelChoice } from './DefaultModelStep.js';
import { WizardActions, type WizardNav } from './WizardActions.js';

export interface DoneStepProps {
  /** `next` (Open Store) and `skip` both leave for Store home. */
  readonly nav: WizardNav;
  /** Only what this wizard run added or set; earlier configuration is not listed. */
  readonly added: readonly ConnectionSummary[];
  readonly defaultModel: DefaultModelChoice | null;
  /** Saving `onboardingDone` failed; the wizard would open again on the next launch. */
  readonly error: IpcError | null;
}

/** The summary: the Connections added and the Default Model chosen, then Open Store. */
export function DoneStep({ nav, added, defaultModel, error }: DoneStepProps) {
  const { t } = useI18n();
  const none = t('onboarding.done.none');
  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding.done.title')}</h1>
      <dl className="wizard-summary">
        <dt>{t('onboarding.done.connections')}</dt>
        <dd>
          {added.length === 0
            ? none
            : added
                .map((connection) =>
                  connection.local
                    ? t('onboarding.done.local', { name: connectionName(t, connection) })
                    : connectionName(t, connection),
                )
                .join(t('onboarding.done.separator'))}
        </dd>
        <dt>{t('onboarding.done.default_model')}</dt>
        <dd>
          {defaultModel === null
            ? none
            : t('onboarding.done.model_on', {
                model: defaultModel.model,
                connection: connectionName(t, defaultModel.connection),
              })}
        </dd>
      </dl>
      {added.length === 0 ? (
        <p className="wizard-note">{t('onboarding.done.no_connection')}</p>
      ) : null}
      {error === null ? null : <ErrorMessage error={error} />}
      <WizardActions nav={nav} primaryLabel={t('onboarding.open_store')} />
    </>
  );
}
