/**
 * The normative Slot resolution order (gateway-protocol.md §4) as a pure function: the Model
 * Gateway's `resolveBinding` gathers what it needs from SQLite on each request and asks this
 * function, so the order itself is tested as a table, without a database or a Gateway.
 */
import { isModelName, isProviderId, type Binding } from '@harness-store/gateway';
import type { Manifest, ModelSlot } from '@harness-store/manifest';
import type { BindingTarget, GlobalBinding } from '../../shared/ipc.js';

/** The Model Slot every Harness has, whose Default Model is the User's Default Model. */
export const DEFAULT_SLOT = 'default';

/** Everything one resolution looks at, read fresh for each request. */
export interface SlotResolutionInput {
  /** The Model Slot the request names. */
  readonly slot: string;
  /** The Harness's Model Override for this Slot; null without one. */
  readonly override: BindingTarget | null;
  /**
   * The Slot's Recommended Models, in Manifest order, each as the Connection whose Provider it
   * names and the model ({@link recommendedTargets}).
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

/** The Connection id this `provider/model` id must match to be skipped: no Connection has it. */
const GENERIC_OPENAI_COMPATIBLE = 'openai-compatible';

/**
 * A Slot's Recommended Models (`provider/model` ids, in Manifest order) as resolution targets:
 * each id split at its first `/`, the part before it being the Connection id it needs. An id
 * whose Provider the Model Gateway does not serve, or whose model it would not send, is skipped,
 * so a Manifest naming a Provider this app does not know never breaks resolution. So is
 * `openai-compatible/<model>`: a custom endpoint's Connection id names the endpoint
 * (`openai-compatible:<name>`), which a Publisher cannot know.
 */
export function recommendedTargets(ids: readonly string[]): BindingTarget[] {
  const targets: BindingTarget[] = [];
  for (const id of ids) {
    const slash = id.indexOf('/');
    if (slash <= 0) continue;
    const connectionId = id.slice(0, slash);
    const model = id.slice(slash + 1);
    if (connectionId === GENERIC_OPENAI_COMPATIBLE) continue;
    if (!isProviderId(connectionId) || !isModelName(connectionId, model)) continue;
    targets.push({ connectionId, model });
  }
  return targets;
}

/** The Model Slots a Manifest declares: `default` first, then in the Manifest's order. */
export function declaredSlots(manifest: Pick<Manifest, 'models'>): string[] {
  const names = Object.keys(manifest.models.slots);
  return [DEFAULT_SLOT, ...names.filter((name) => name !== DEFAULT_SLOT)];
}

/**
 * The Model Slot `slot` of `manifest`, or undefined when it declares none of that name (an own
 * key only, so `constructor` is never a Slot).
 */
export function declaredSlot(
  manifest: Pick<Manifest, 'models'> | null,
  slot: string,
): ModelSlot | undefined {
  if (manifest === null || !Object.hasOwn(manifest.models.slots, slot)) return undefined;
  return manifest.models.slots[slot];
}
