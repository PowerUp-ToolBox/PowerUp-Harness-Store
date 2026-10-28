/**
 * The first-run wizard's steps, in order (spec P0-04, "Onboarding state machine"). A pure reducer,
 * tested as a (step, event) → step table; the data each step collects lives in the wizard page.
 */
export const WIZARD_STEPS = [
  'welcome',
  'detect-local',
  'cloud-key',
  'default-model',
  'done',
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * What the User did: NEXT is Continue (once the step's own action, if any, succeeded), SKIP is the
 * step's Skip control, BACK is Back.
 */
export type WizardEvent = 'NEXT' | 'SKIP' | 'BACK';

/**
 * The step after `event`. NEXT and SKIP advance one step, except Skip on `welcome` ("Skip setup"),
 * which goes straight to `done`. BACK steps back from every step but `welcome`, `done` included.
 * `done` is the last step: NEXT and SKIP stay there, and the wizard page then leaves for the Store.
 */
export function wizardReducer(step: WizardStep, event: WizardEvent): WizardStep {
  const index = WIZARD_STEPS.indexOf(step);
  switch (event) {
    case 'BACK':
      return WIZARD_STEPS[Math.max(index - 1, 0)] ?? step;
    case 'SKIP':
      if (step === 'welcome') return 'done';
      return WIZARD_STEPS[Math.min(index + 1, WIZARD_STEPS.length - 1)] ?? step;
    case 'NEXT':
      return WIZARD_STEPS[Math.min(index + 1, WIZARD_STEPS.length - 1)] ?? step;
  }
}
