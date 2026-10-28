import { isModelName, isProviderId, type Binding } from '@harness-store/gateway';
import type { Manifest, ModelSlot } from '@harness-store/manifest';
import type {
  BindingTarget,
  GlobalBinding,
  GlobalBindingChange,
  IpcMethodName,
  IpcResult,
  ManifestSlotsRequest,
  ModelOverride,
  ModelOverrideChange,
  ModelOverrideClear,
  ResolvedSlot,
} from '../../shared/ipc.js';
import type { ConnectionStore } from './connection-store.js';
import type { InstallStore } from './install-store.js';
import { fail, ok } from './ipc-result.js';
import {
  declaredSlot,
  declaredSlots,
  recommendedTargets,
  resolveSlotBinding,
} from './slot-resolver.js';

/** A Model Slot name, as the Manifest schema allows it (`models.slots`). */
const SLOT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The Slot Bindings service as the IPC handlers use it. */
export interface BindingsService {
  /** The global Slot Bindings (Default Models): `default` first, then by Slot name. */
  getGlobal(): readonly GlobalBinding[];
  /** Sets or clears the Default Model of one Slot name. */
  setGlobal(change: GlobalBindingChange): IpcResult<readonly GlobalBinding[]>;
  /** The Model Overrides of one Harness, by Slot name. */
  getForHarness(harnessId: string): readonly ModelOverride[];
  /** Sets the Model Override of one declared Slot of an installed Harness. */
  setOverride(change: ModelOverrideChange): IpcResult<readonly ModelOverride[]>;
  /** Removes the Model Override of one Slot of a Harness. */
  clearOverride(clear: ModelOverrideClear): IpcResult<readonly ModelOverride[]>;
  /** What every declared Slot of an installed Harness resolves to now, and why. */
  resolveAll(harnessId: string): IpcResult<readonly ResolvedSlot[]>;
  /** What every Slot of a Manifest's `models`, installed or not, would resolve to now. */
  resolveManifest(request: ManifestSlotsRequest): IpcResult<readonly ResolvedSlot[]>;
}

/**
 * Resolves one Model Slot of a Harness through the normative order ({@link resolveSlotBinding})
 * over what SQLite holds now: the Harness's Model Override of that Slot, the Slot's Recommended
 * Models from its installed Manifest, the Default Models and the enabled Connections. The Model
 * Gateway's `resolveBinding` and `bindings.resolveAll` both call it, so the Models page shows
 * exactly what the next request gets. A Slot `manifest` does not declare (or no Manifest) has
 * neither an override nor Recommended Models: an override row left from an earlier version that
 * declared it is ignored, not deleted.
 */
export function resolveHarnessSlot(
  store: ConnectionStore,
  manifest: Pick<Manifest, 'models'> | null,
  harnessId: string,
  slot: string,
): Binding | null {
  const declared = declaredSlot(manifest, slot);
  const override =
    declared === undefined
      ? undefined
      : store.overrides(harnessId).find((row) => row.slot === slot);
  return resolveSlotBinding({
    slot,
    override: override ?? null,
    recommended: recommendedTargets(declared?.recommended ?? []),
    global: store.globalBindings(),
    enabledConnections: new Set(
      store
        .all()
        .filter((row) => row.enabled)
        .map((row) => row.id),
    ),
  });
}

/**
 * The User's Slot Bindings in the local database: the global ones (the Default Models) and the
 * Model Overrides of each installed Harness.
 *
 * `setGlobal` and `setOverride` bind a Slot name to a model of an enabled Connection. They check
 * what the Model Gateway would check of the binding on every request (a Provider id it serves, a
 * model name it would send), so a stored binding never fails there as a host bug; whether the
 * Provider has that model is not checked, as models typed by hand are allowed, and neither are the
 * Slot's Model Requirements, which only warn. Nothing awaits between the checks and the write, so
 * the Connection cannot be removed in between.
 */
export function createBindingsService(
  store: ConnectionStore,
  installs: Pick<InstallStore, 'get'>,
): BindingsService {
  /** The refusal of a target the Gateway could not use, or null when it is fine. */
  const refuseTarget = (method: IpcMethodName, target: BindingTarget) => {
    const { connectionId, model } = target;
    if (!isProviderId(connectionId) || !isModelName(connectionId, model)) {
      return fail('invalid_input', { method });
    }
    if (store.get(connectionId)?.enabled !== true) return fail('provider_not_connected');
    return null;
  };
  return {
    getGlobal: () => store.globalBindings(),
    setGlobal({ slot, target }) {
      if (!SLOT_NAME.test(slot)) return fail('invalid_input', { method: 'bindings.setGlobal' });
      if (target !== null) {
        const refused = refuseTarget('bindings.setGlobal', target);
        if (refused !== null) return refused;
      }
      store.setGlobalBinding(slot, target);
      return ok(store.globalBindings());
    },
    getForHarness: (harnessId) => store.overrides(harnessId),
    setOverride({ harnessId, slot, target }) {
      const install = installs.get(harnessId);
      if (install === undefined) return fail('not_installed');
      if (!SLOT_NAME.test(slot) || declaredSlot(install.manifest, slot) === undefined) {
        return fail('invalid_input', { method: 'bindings.setOverride' });
      }
      const refused = refuseTarget('bindings.setOverride', target);
      if (refused !== null) return refused;
      store.setOverride(harnessId, slot, target);
      return ok(store.overrides(harnessId));
    },
    clearOverride({ harnessId, slot }) {
      store.setOverride(harnessId, slot, null);
      return ok(store.overrides(harnessId));
    },
    resolveAll(harnessId) {
      const install = installs.get(harnessId);
      if (install === undefined) return fail('not_installed');
      return ok(resolveSlots(store, install.manifest, harnessId));
    },
    // The Store detail page's Manifest goes through the very resolution the Gateway uses.
    resolveManifest: ({ harnessId, models }) => ok(resolveSlots(store, { models }, harnessId)),
  };
}

/** Every Slot of `manifest`, `default` first, with what it resolves to now. */
function resolveSlots(
  store: ConnectionStore,
  manifest: Pick<Manifest, 'models'>,
  harnessId: string,
): ResolvedSlot[] {
  return declaredSlots(manifest).map((slot): ResolvedSlot => {
    const binding = resolveHarnessSlot(store, manifest, harnessId, slot);
    return {
      slot,
      binding:
        binding === null
          ? null
          : { connectionId: binding.providerId, model: binding.model, source: binding.source },
    };
  });
}

/**
 * Bindings without a database, when the Runtime could not open it: the window shows only its
 * startup error screen, so nothing is bound and a change answers `not_implemented`.
 */
export function createBindingsStub(): BindingsService {
  return {
    getGlobal: () => [],
    setGlobal: () => fail('not_implemented', { method: 'bindings.setGlobal' }),
    getForHarness: () => [],
    setOverride: () => fail('not_implemented', { method: 'bindings.setOverride' }),
    clearOverride: () => fail('not_implemented', { method: 'bindings.clearOverride' }),
    resolveAll: () => fail('not_installed'),
    resolveManifest: () => fail('not_implemented', { method: 'bindings.resolveManifest' }),
  };
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

/**
 * The change when `input` is a well-formed {@link GlobalBindingChange}, else null (never throws).
 * Only the shape is checked here; the service checks the values.
 */
export function parseGlobalBindingChange(input: unknown): GlobalBindingChange | null {
  if (!isRecord(input) || !hasOnly(input, ['slot', 'target'])) return null;
  const { slot, target } = input;
  if (typeof slot !== 'string') return null;
  if (target === null) return { slot, target: null };
  const parsed = parseTarget(target);
  return parsed === null ? null : { slot, target: parsed };
}

/** A Harness ID as IPC input: a non-empty string, checked against the installs afterwards. */
export function isHarnessIdInput(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 256;
}

/** The most Model Slots a Manifest declares. */
const MAX_SLOTS = 8;

/** The most Recommended Models a Model Slot lists. */
const MAX_RECOMMENDED = 5;

/**
 * The request when `input` is a well-formed {@link ManifestSlotsRequest}, else null: a Harness ID
 * and `models.slots` with a `default` Slot and at most 8 Slots named as the Manifest schema names
 * them, each with at most 5 Recommended Models (strings). Only what resolution reads is kept:
 * each Slot's Recommended Models.
 */
export function parseManifestSlotsRequest(input: unknown): ManifestSlotsRequest | null {
  if (!isRecord(input) || !hasOnly(input, ['harnessId', 'models'])) return null;
  const { harnessId, models } = input;
  if (!isHarnessIdInput(harnessId) || !isRecord(models) || !isRecord(models.slots)) return null;
  const entries = Object.entries(models.slots);
  if (entries.length > MAX_SLOTS || !Object.hasOwn(models.slots, 'default')) return null;
  const slots: Record<string, ModelSlot> = {};
  for (const [name, slot] of entries) {
    if (!SLOT_NAME.test(name) || !isRecord(slot)) return null;
    const { recommended } = slot;
    if (recommended === undefined) {
      slots[name] = {};
      continue;
    }
    if (
      !Array.isArray(recommended) ||
      recommended.length > MAX_RECOMMENDED ||
      !recommended.every((id) => typeof id === 'string' && id.length <= 256)
    ) {
      return null;
    }
    slots[name] = { recommended: recommended as string[] };
  }
  return { harnessId, models: { slots: slots as Manifest['models']['slots'] } };
}

/** The target when `input` is a well-formed {@link BindingTarget}, else null. */
function parseTarget(input: unknown): BindingTarget | null {
  if (!isRecord(input) || !hasOnly(input, ['connectionId', 'model'])) return null;
  const { connectionId, model } = input;
  if (typeof connectionId !== 'string' || typeof model !== 'string') return null;
  return { connectionId, model };
}

/** The change when `input` is a well-formed {@link ModelOverrideChange}, else null. */
export function parseModelOverrideChange(input: unknown): ModelOverrideChange | null {
  if (!isRecord(input) || !hasOnly(input, ['harnessId', 'slot', 'target'])) return null;
  const { harnessId, slot } = input;
  const target = parseTarget(input.target);
  if (!isHarnessIdInput(harnessId) || typeof slot !== 'string' || target === null) return null;
  return { harnessId, slot, target };
}

/** The removal when `input` is a well-formed {@link ModelOverrideClear}, else null. */
export function parseModelOverrideClear(input: unknown): ModelOverrideClear | null {
  if (!isRecord(input) || !hasOnly(input, ['harnessId', 'slot'])) return null;
  const { harnessId, slot } = input;
  if (!isHarnessIdInput(harnessId) || typeof slot !== 'string') return null;
  return { harnessId, slot };
}

const hasOnly = (input: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(input).every((key) => keys.includes(key));
