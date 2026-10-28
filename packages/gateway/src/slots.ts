/**
 * Model Slots: which Slots a Harness declares (its installed Manifest, from `getManifest`) and
 * the Slot Binding each one resolves to right now (`resolveBinding`). The normative resolution
 * order (Model Override, Recommended Models, Default Model; gateway-protocol.md §4) lives in the
 * host's `resolveBinding`; the Gateway only checks its answer. Nothing is cached: both callbacks
 * run on every request, so a binding changed in the app applies to the Harness's next call.
 */
import type { Manifest } from '@harness-store/manifest';
import { unlessAborted } from './in-flight.js';
import { isProviderId } from './providers.js';
import type { Binding, GatewayOptions } from './types.js';

type SlotOptions = Pick<GatewayOptions, 'getManifest' | 'resolveBinding'>;

/** What a Model Slot name resolved to for one request. */
export type SlotResolution =
  /** The Slot Binding's Provider and model. */
  | { kind: 'bound'; providerId: string; model: string }
  /** A declared Slot that nothing is bound to: 409 `slot_unbound`. */
  | { kind: 'unbound' }
  /** Not a Slot of the Harness's Manifest: 404 `unknown_slot`. */
  | { kind: 'unknown' };

/** A request named a declared Model Slot that has no Slot Binding. */
export interface SlotUnboundEvent {
  harnessId: string;
  slot: string;
}

/** One Model Slot in the `GET /v1/models` list. */
export interface SlotModel {
  /** The Slot name: what a Harness sends as `model`. */
  id: string;
  object: 'model';
  created: 0;
  owned_by: 'harness-store';
  /** The current Slot Binding as `provider/model`; `null` when the Slot is unbound. */
  resolved_model: string | null;
}

/** The body of `GET /v1/models`, in the OpenAI list shape so OpenAI SDKs can read it. */
export interface ModelList {
  object: 'list';
  data: SlotModel[];
}

/** The Slot names a Manifest declares, in Manifest order; none for a `null` Manifest. */
function declaredSlots(manifest: Manifest | null): string[] {
  return Object.keys(manifest?.models.slots ?? {});
}

/**
 * Checks what `resolveBinding` answered: `null`, or a Binding with a Provider id and a model name
 * as an explicit `provider/model` id would carry. Anything else is a host bug, which fails the
 * request with 500 `internal_error`.
 */
function checkBinding(
  // The callback's declared type is not proof: it is the host's code.
  binding: Partial<Binding> | null | undefined,
  slot: string,
): Binding | null {
  if (binding === null) return null;
  if (
    typeof binding?.providerId !== 'string' ||
    !isProviderId(binding.providerId) ||
    typeof binding.model !== 'string' ||
    !/^\S+$/.test(binding.model)
  ) {
    throw new Error(`resolveBinding returned an invalid Slot Binding for the Slot ${slot}.`);
  }
  return binding as Binding;
}

/**
 * Resolves a Model Slot name for a request. A name the Manifest does not declare is `unknown`
 * without asking `resolveBinding`.
 */
export async function resolveSlot(
  options: SlotOptions,
  harnessId: string,
  slot: string,
  signal: AbortSignal,
): Promise<SlotResolution> {
  const manifest = await unlessAborted(options.getManifest(harnessId), signal);
  if (!declaredSlots(manifest).includes(slot)) return { kind: 'unknown' };
  const binding = checkBinding(
    await unlessAborted(options.resolveBinding({ harnessId, slot }), signal),
    slot,
  );
  if (binding === null) return { kind: 'unbound' };
  return { kind: 'bound', providerId: binding.providerId, model: binding.model };
}

/** `GET /v1/models`: every Slot the Harness declares, with its current Slot Binding. */
export async function listSlotModels(
  options: SlotOptions,
  harnessId: string,
  signal: AbortSignal,
): Promise<ModelList> {
  const manifest = await unlessAborted(options.getManifest(harnessId), signal);
  const slots = declaredSlots(manifest);
  const bindings = await unlessAborted(
    Promise.all(slots.map((slot) => options.resolveBinding({ harnessId, slot }))),
    signal,
  );
  return {
    object: 'list',
    data: slots.map((slot, index) => {
      const binding = checkBinding(bindings[index], slot);
      return {
        id: slot,
        object: 'model',
        created: 0,
        owned_by: 'harness-store',
        resolved_model: binding === null ? null : `${binding.providerId}/${binding.model}`,
      };
    }),
  };
}
