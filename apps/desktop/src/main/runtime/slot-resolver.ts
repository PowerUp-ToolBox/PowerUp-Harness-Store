/**
 * The normative Slot resolution order (gateway-protocol.md §4) as a pure function: the Model
 * Gateway's `resolveBinding` gathers what it needs from SQLite on each request and asks this
 * function, so the order itself is tested as a table, without a database or a Gateway.
 */
import type { Binding } from '@harness-store/gateway';
import type { BindingTarget, GlobalBinding } from '../../shared/ipc.js';

/** The Model Slot every Harness has, whose Default Model is the User's Default Model. */
export const DEFAULT_SLOT = 'default';

/** Everything one resolution looks at, read fresh for each request. */
export interface SlotResolutionInput {
  /** The Model Slot the request names. */
  readonly slot: string;
  /** The Harness's Model Override for this Slot; null without one. Always null until P0-03.5. */
  readonly override: BindingTarget | null;
  /**
   * The Slot's Recommended Models, in Manifest order, each as the Connection whose Provider it
   * names and the model. Always empty until P0-03.5.
   */
  readonly recommended: readonly BindingTarget[];
  /** The global Slot Bindings (the Default Models), any order. */
  readonly global: readonly GlobalBinding[];
  /** The ids of the enabled Connections. */
  readonly enabledConnections: ReadonlySet<string>;
}

/**
 * The Slot Binding for a request, or null (409 `slot_unbound`). In order: the Model Override; the
 * first Recommended Model with an enabled Connection; the Default Model of the same Slot name
 * (source `default_same_name`, or `default` when the Slot is `default` itself); the Default Model
 * of `default`. A binding whose Connection is disabled or gone counts as absent, so resolution
 * falls through to the next step.
 */
export function resolveSlotBinding(input: SlotResolutionInput): Binding | null {
  const usable = (target: BindingTarget | null | undefined): target is BindingTarget =>
    target !== null && target !== undefined && input.enabledConnections.has(target.connectionId);
  const bound = (target: BindingTarget, source: Binding['source']): Binding => ({
    providerId: target.connectionId,
    model: target.model,
    source,
  });
  const defaultModel = (slot: string) => input.global.find((binding) => binding.slot === slot);

  if (usable(input.override)) return bound(input.override, 'override');
  const recommended = input.recommended.find(usable);
  if (recommended !== undefined) return bound(recommended, 'recommended');
  const sameName = defaultModel(input.slot);
  if (usable(sameName)) {
    return bound(sameName, input.slot === DEFAULT_SLOT ? 'default' : 'default_same_name');
  }
  const fallback = defaultModel(DEFAULT_SLOT);
  if (usable(fallback)) return bound(fallback, 'default');
  return null;
}
