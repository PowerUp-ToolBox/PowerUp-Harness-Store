/**
 * The Model Requirements check: does a model meet what a Model Slot asks for? Pure, with no Node
 * or DOM APIs, so the Runtime and the renderer share it. A requirement the model's known
 * capabilities cannot answer is `unknown`, never a failure: a model typed by hand, one a Provider
 * listed live (listings carry ids only), and `json` for every model, since no source states it.
 * The UI says "capabilities unknown" for those, and warns only about real failures.
 */
import type { ModelRequirements } from '@harness-store/manifest';
import type { ModelInfo } from './ipc.js';

/** A requirement the model is known not to meet. */
export type RequirementFailure = 'tools' | 'vision' | 'json' | 'minContext';

export interface RequirementCheck {
  /** No requirement is known to fail. True when some are only unknown. */
  readonly ok: boolean;
  /** At least one requirement could not be checked, for lack of what the model supports. */
  readonly unknown: boolean;
  /** The requirements the model is known not to meet, in the order of this list's type. */
  readonly failures: readonly RequirementFailure[];
}

/**
 * Checks `model` against `requirements` (absent: the Slot asks for nothing). A `false` or absent
 * requirement asks for nothing. `model` may be just `{ id }`, for a model with unknown
 * capabilities.
 */
export function checkRequirements(
  requirements: ModelRequirements | undefined,
  model: ModelInfo,
): RequirementCheck {
  const failures: RequirementFailure[] = [];
  let unknown = false;
  const check = (failure: RequirementFailure, met: boolean | undefined) => {
    if (met === undefined) unknown = true;
    else if (!met) failures.push(failure);
  };
  if (requirements?.tools === true) check('tools', model.tools);
  if (requirements?.vision === true) check('vision', model.vision);
  // No model source states JSON mode support, so it is never known to fail.
  if (requirements?.json === true) check('json', undefined);
  if (requirements?.minContext !== undefined) {
    check(
      'minContext',
      model.contextWindow === undefined
        ? undefined
        : model.contextWindow >= requirements.minContext,
    );
  }
  return { ok: failures.length === 0, unknown, failures };
}
