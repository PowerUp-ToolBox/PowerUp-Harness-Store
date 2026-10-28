import { isModelName, isProviderId } from '@harness-store/gateway';
import type { GlobalBinding, GlobalBindingChange, IpcResult } from '../../shared/ipc.js';
import type { ConnectionStore } from './connection-store.js';
import { fail, ok } from './ipc-result.js';

/** A Model Slot name, as the Manifest schema allows it (`models.slots`). */
const SLOT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The Slot Bindings service as the IPC handlers use it. */
export interface BindingsService {
  /** The global Slot Bindings (Default Models): `default` first, then by Slot name. */
  getGlobal(): readonly GlobalBinding[];
  /** Sets or clears the Default Model of one Slot name. */
  setGlobal(change: GlobalBindingChange): IpcResult<readonly GlobalBinding[]>;
}

/**
 * The User's Slot Bindings in the local database. For now only the global ones, the Default
 * Models; Model Overrides arrive with P0-03.5.
 *
 * `setGlobal` binds a Slot name to a model of an enabled Connection, or clears it. It checks what
 * the Model Gateway would check of the binding on every request (a Provider id it serves, a model
 * name it would send), so a stored binding never fails there as a host bug; whether the Provider
 * has that model is not checked, as models typed by hand are allowed. Nothing awaits between the
 * checks and the write, so the Connection cannot be removed in between.
 */
export function createBindingsService(store: ConnectionStore): BindingsService {
  return {
    getGlobal: () => store.globalBindings(),
    setGlobal({ slot, target }) {
      const invalid = () => fail('invalid_input', { method: 'bindings.setGlobal' });
      if (!SLOT_NAME.test(slot)) return invalid();
      if (target !== null) {
        const { connectionId, model } = target;
        if (!isProviderId(connectionId) || !isModelName(connectionId, model)) return invalid();
        if (store.get(connectionId)?.enabled !== true) return fail('provider_not_connected');
      }
      store.setGlobalBinding(slot, target);
      return ok(store.globalBindings());
    },
  };
}

/**
 * Bindings without a database, when the Runtime could not open it: the window shows only its
 * startup error screen, so nothing is bound and a change answers `not_implemented`.
 */
export function createBindingsStub(): BindingsService {
  return {
    getGlobal: () => [],
    setGlobal: () => fail('not_implemented', { method: 'bindings.setGlobal' }),
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
  if (!isRecord(target) || !hasOnly(target, ['connectionId', 'model'])) return null;
  const { connectionId, model } = target;
  if (typeof connectionId !== 'string' || typeof model !== 'string') return null;
  return { slot, target: { connectionId, model } };
}

const hasOnly = (input: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(input).every((key) => keys.includes(key));
