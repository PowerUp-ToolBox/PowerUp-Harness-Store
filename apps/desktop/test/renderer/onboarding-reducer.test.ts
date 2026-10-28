import { describe, expect, it } from 'vitest';
import {
  WIZARD_STEPS,
  wizardReducer,
  type WizardEvent,
  type WizardStep,
} from '../../src/renderer/src/onboarding/wizard-reducer.js';

// Every (step, event) pair of the spec's state machine and where it leads.
const TABLE: readonly (readonly [WizardStep, WizardEvent, WizardStep])[] = [
  ['welcome', 'NEXT', 'detect-local'],
  ['welcome', 'SKIP', 'done'],
  ['welcome', 'BACK', 'welcome'],
  ['detect-local', 'NEXT', 'cloud-key'],
  ['detect-local', 'SKIP', 'cloud-key'],
  ['detect-local', 'BACK', 'welcome'],
  ['cloud-key', 'NEXT', 'default-model'],
  ['cloud-key', 'SKIP', 'default-model'],
  ['cloud-key', 'BACK', 'detect-local'],
  ['default-model', 'NEXT', 'done'],
  ['default-model', 'SKIP', 'done'],
  ['default-model', 'BACK', 'cloud-key'],
  ['done', 'NEXT', 'done'],
  ['done', 'SKIP', 'done'],
  ['done', 'BACK', 'default-model'],
];

describe('first-run wizard state machine', () => {
  it('has the five steps in order', () => {
    expect(WIZARD_STEPS).toEqual(['welcome', 'detect-local', 'cloud-key', 'default-model', 'done']);
  });

  it('covers every (step, event) pair', () => {
    const pairs = new Set(TABLE.map(([step, event]) => `${step} ${event}`));
    expect(pairs.size).toBe(WIZARD_STEPS.length * 3);
  });

  it.each(TABLE)('%s + %s → %s', (step, event, expected) => {
    expect(wizardReducer(step, event)).toBe(expected);
  });

  it('Continue on every step reaches done in four steps', () => {
    let step: WizardStep = 'welcome';
    const visited: WizardStep[] = [step];
    while (step !== 'done') {
      step = wizardReducer(step, 'NEXT');
      visited.push(step);
    }
    expect(visited).toEqual(WIZARD_STEPS);
  });

  it('Skip after Continue on welcome visits every later step, then stays on done', () => {
    let step = wizardReducer('welcome', 'NEXT');
    const visited: WizardStep[] = [step];
    for (let i = 0; i < 4; i += 1) {
      step = wizardReducer(step, 'SKIP');
      visited.push(step);
    }
    expect(visited).toEqual(['detect-local', 'cloud-key', 'default-model', 'done', 'done']);
  });
});
