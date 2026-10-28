import { useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ConnectionSummary, IpcError } from '../../../shared/ipc.js';
import { useI18n, useSettings } from '../i18n/I18nProvider.js';
import { CloudKeyStep } from '../onboarding/CloudKeyStep.js';
import { DefaultModelStep, type DefaultModelChoice } from '../onboarding/DefaultModelStep.js';
import { DetectLocalStep } from '../onboarding/DetectLocalStep.js';
import { DoneStep } from '../onboarding/DoneStep.js';
import { WelcomeStep } from '../onboarding/WelcomeStep.js';
import type { WizardNav } from '../onboarding/WizardActions.js';
import { WIZARD_STEPS, wizardReducer, type WizardStep } from '../onboarding/wizard-reducer.js';
import { CheckIcon } from '../shell/icons.js';

/**
 * The first-run wizard (docs/ux/flows.md F1): Welcome → Local Providers → Remote Provider →
 * Default model → Done, every step skippable. It fills the window, without the sidebar. Its
 * progress is not kept: leaving or quitting before the end starts it again at `welcome`, and
 * Settings' "Re-run setup" just opens this route. Reaching `done` sets `onboardingDone`, so the
 * app opens on the Library from then on; Open Store (or Skip) on `done` lands on Store home.
 *
 * The wizard only adds: it never removes a Connection or Slot Binding the User already has.
 */
export function OnboardingPage() {
  const { updateSettings } = useSettings();
  const navigate = useNavigate();
  const [step, dispatch] = useReducer(wizardReducer, 'welcome');
  /** The Connections this run of the wizard added, in the order they were added. */
  const [added, setAdded] = useState<readonly ConnectionSummary[]>([]);
  const [defaultModel, setDefaultModel] = useState<DefaultModelChoice | null>(null);
  const [doneError, setDoneError] = useState<IpcError | null>(null);

  useEffect(() => {
    if (step !== 'done') return;
    let current = true;
    void updateSettings({ onboardingDone: true }).then((result) => {
      if (current) setDoneError(result.ok ? null : result.error);
    });
    return () => {
      current = false;
    };
  }, [step, updateSettings]);

  // Each step's heading takes the focus when the step changes, so a screen reader announces it.
  const stepRef = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    stepRef.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [step]);

  const leaveForStore = () => void navigate('/store');
  const nav: WizardNav = {
    next: () => {
      dispatch('NEXT');
    },
    skip: () => {
      dispatch('SKIP');
    },
    ...(step === 'welcome'
      ? {}
      : {
          back: () => {
            dispatch('BACK');
          },
        }),
  };
  const addConnection = (connection: ConnectionSummary) => {
    setAdded((list) => [...list.filter((item) => item.id !== connection.id), connection]);
  };

  return (
    <main className="wizard">
      <div className="wizard-column">
        <StepProgress step={step} />
        <div className="wizard-card" ref={stepRef}>
          {step === 'welcome' ? <WelcomeStep nav={nav} /> : null}
          {step === 'detect-local' ? (
            <DetectLocalStep nav={nav} added={added} onAdded={addConnection} />
          ) : null}
          {step === 'cloud-key' ? (
            <CloudKeyStep nav={nav} added={added} onAdded={addConnection} />
          ) : null}
          {step === 'default-model' ? (
            <DefaultModelStep
              nav={nav}
              connections={added}
              choice={defaultModel}
              onChoose={setDefaultModel}
            />
          ) : null}
          {step === 'done' ? (
            <DoneStep
              nav={{ ...nav, next: leaveForStore, skip: leaveForStore }}
              added={added}
              defaultModel={defaultModel}
              error={doneError}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
}

/** The five steps, numbered; the current one is marked, the finished ones checked. */
function StepProgress({ step }: { readonly step: WizardStep }) {
  const { t } = useI18n();
  const currentIndex = WIZARD_STEPS.indexOf(step);
  return (
    <ol className="wizard-steps" aria-label={t('onboarding.steps')}>
      {WIZARD_STEPS.map((item, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
        return (
          <li key={item} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="wizard-step-dot" aria-hidden="true">
              {state === 'done' ? <CheckIcon /> : index + 1}
            </span>
            {t(`onboarding.step.${item}`)}
          </li>
        );
      })}
    </ol>
  );
}
