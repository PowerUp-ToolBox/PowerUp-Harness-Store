import { useI18n } from '../i18n/I18nProvider.js';

/** Moves through the wizard; the wizard page gives one to every step. */
export interface WizardNav {
  /** Continue: the step's own work is done (or there was none). */
  readonly next: () => void;
  readonly skip: () => void;
  /** Absent on `welcome`, the first step. */
  readonly back?: () => void;
}

export interface WizardActionsProps {
  readonly nav: WizardNav;
  /** The primary button's action; Continue by default. */
  readonly onPrimary?: () => void;
  /** The primary button's label when it is not Continue (Open Store on `done`). */
  readonly primaryLabel?: string;
  readonly primaryDisabled?: boolean;
  /** The primary button's action is running: a spinner and no second click. */
  readonly busy?: boolean;
  /** "Skip setup" on `welcome`, which ends the wizard; "Skip" elsewhere. */
  readonly skipSetup?: boolean;
}

/** The bar under every step: Skip on the left; Back and the primary button on the right. */
export function WizardActions({
  nav,
  onPrimary,
  primaryLabel,
  primaryDisabled = false,
  busy = false,
  skipSetup = false,
}: WizardActionsProps) {
  const { t } = useI18n();
  return (
    <div className="wizard-actions">
      <button type="button" className="button-link" onClick={nav.skip}>
        {skipSetup ? t('onboarding.skip_setup') : t('onboarding.skip')}
      </button>
      <div className="wizard-actions-end">
        {nav.back === undefined ? null : (
          <button type="button" className="button-secondary" onClick={nav.back}>
            {t('onboarding.back')}
          </button>
        )}
        <button
          type="button"
          className="button-primary"
          disabled={primaryDisabled || busy}
          aria-busy={busy}
          onClick={onPrimary ?? nav.next}
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {primaryLabel ?? t('onboarding.continue')}
        </button>
      </div>
    </div>
  );
}
