import { isAbsolute } from 'node:path';
import type {
  AuthState,
  IpcMethodName,
  IpcOutput,
  IpcResult,
  LaunchRequest,
} from '../../shared/ipc.js';
import {
  isHarnessIdInput,
  parseGlobalBindingChange,
  parseModelOverrideChange,
  parseModelOverrideClear,
} from './bindings.js';
import {
  parseConnectionDraft,
  parseConnectionTestDraft,
  parseConnectionTestRequest,
  parseConnectionUpdate,
} from './connections.js';
import { fail, ok } from './ipc-result.js';
import type { Services } from './services.js';
import { parseSettingsPatch } from './settings.js';
import { StoreAuthError } from './store-auth.js';

/**
 * One handler per IPC method. The input arrives as `unknown` because it crossed a process
 * boundary: the contract is TypeScript-only, so each handler checks its own input and answers
 * `invalid_input` when it does not fit.
 */
export type IpcHandlers = {
  readonly [M in IpcMethodName]: (
    input: unknown,
  ) => IpcResult<IpcOutput<M>> | Promise<IpcResult<IpcOutput<M>>>;
};

export function createHandlers(services: Services): IpcHandlers {
  return {
    'app.ping': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'app.ping' });
      return ok({ version: services.app.version });
    },
    'app.status': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'app.status' });
      return ok(services.app.status());
    },
    'app.quit': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'app.quit' });
      services.app.quit();
      return ok(null);
    },
    'settings.get': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'settings.get' });
      return ok(services.settings.get());
    },
    'settings.set': (input) => {
      const patch = parseSettingsPatch(input);
      if (patch === null) return fail('invalid_input', { method: 'settings.set' });
      return ok(services.settings.set(patch));
    },
    'diagnostics.get': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'diagnostics.get' });
      return ok(services.diagnostics.get());
    },
    'connectivity.get': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'connectivity.get' });
      return ok(services.connectivity.get());
    },
    'connectivity.check': async (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'connectivity.check' });
      return ok(await services.connectivity.check());
    },
    'providers.list': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'providers.list' });
      return ok(services.providers.list());
    },
    'connections.detectLocal': async (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'connections.detectLocal' });
      return ok(await services.connections.detectLocal());
    },
    'connections.list': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'connections.list' });
      return ok(services.connections.list());
    },
    'connections.add': (input) => {
      const draft = parseConnectionDraft(input);
      if (draft === null) return fail('invalid_input', { method: 'connections.add' });
      return services.connections.add(draft);
    },
    'connections.update': (input) => {
      const update = parseConnectionUpdate(input);
      if (update === null) return fail('invalid_input', { method: 'connections.update' });
      return services.connections.update(update);
    },
    'connections.test': (input) => {
      const request = parseConnectionTestRequest(input);
      if (request === null) return fail('invalid_input', { method: 'connections.test' });
      return services.connections.test(request);
    },
    'connections.testDraft': (input) => {
      const draft = parseConnectionTestDraft(input);
      if (draft === null) return fail('invalid_input', { method: 'connections.testDraft' });
      return services.connections.testDraft(draft);
    },
    'connections.models': (input) => {
      if (typeof input !== 'string') return fail('invalid_input', { method: 'connections.models' });
      return services.connections.models(input);
    },
    'connections.remove': (input) => {
      if (typeof input !== 'string') return fail('invalid_input', { method: 'connections.remove' });
      return services.connections.remove(input);
    },
    'bindings.getGlobal': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'bindings.getGlobal' });
      return ok(services.bindings.getGlobal());
    },
    'bindings.setGlobal': (input) => {
      const change = parseGlobalBindingChange(input);
      if (change === null) return fail('invalid_input', { method: 'bindings.setGlobal' });
      return services.bindings.setGlobal(change);
    },
    'bindings.getForHarness': (input) => {
      if (!isHarnessIdInput(input)) {
        return fail('invalid_input', { method: 'bindings.getForHarness' });
      }
      return ok(services.bindings.getForHarness(input));
    },
    'bindings.setOverride': (input) => {
      const change = parseModelOverrideChange(input);
      if (change === null) return fail('invalid_input', { method: 'bindings.setOverride' });
      return services.bindings.setOverride(change);
    },
    'bindings.clearOverride': (input) => {
      const clear = parseModelOverrideClear(input);
      if (clear === null) return fail('invalid_input', { method: 'bindings.clearOverride' });
      return services.bindings.clearOverride(clear);
    },
    'bindings.resolveAll': (input) => {
      if (!isHarnessIdInput(input)) return fail('invalid_input', { method: 'bindings.resolveAll' });
      return services.bindings.resolveAll(input);
    },
    'auth.signIn': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'auth.signIn' });
      return authResult(() => services.auth.signIn());
    },
    'auth.signOut': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'auth.signOut' });
      return authResult(() => services.auth.signOut());
    },
    'auth.whoami': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'auth.whoami' });
      return authResult(() => services.auth.whoami());
    },
    'installs.chooseFolder': async (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'installs.chooseFolder' });
      return ok(await services.installs.chooseFolder());
    },
    'installs.inspectFolder': (input) => {
      if (!isAbsolutePath(input)) {
        return fail('invalid_input', { method: 'installs.inspectFolder' });
      }
      return services.installs.inspectFolder(input);
    },
    'installs.installFromFolder': (input) => {
      if (!isAbsolutePath(input)) {
        return fail('invalid_input', { method: 'installs.installFromFolder' });
      }
      return services.installs.installFromFolder(input);
    },
    'installs.list': async (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'installs.list' });
      return ok(await services.installs.list());
    },
    'launch.start': (input) => {
      const request = parseLaunchRequest(input);
      if (request === null) return fail('invalid_input', { method: 'launch.start' });
      return services.launch.start(request.harnessId, request.workspace ?? null);
    },
    'launch.chooseWorkspace': (input) => {
      if (!isHarnessIdInput(input)) {
        return fail('invalid_input', { method: 'launch.chooseWorkspace' });
      }
      return services.launch.chooseWorkspace(input);
    },
    'launch.lastWorkspace': (input) => {
      if (!isHarnessIdInput(input))
        return fail('invalid_input', { method: 'launch.lastWorkspace' });
      return services.launch.lastWorkspace(input);
    },
    'launch.status': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'launch.status' });
      return ok(services.launch.status());
    },
    'launch.openLogs': (input) => {
      if (!isHarnessIdInput(input)) return fail('invalid_input', { method: 'launch.openLogs' });
      return services.launch.openLogs(input);
    },
    'launch.openDataFolder': (input) => {
      if (!isHarnessIdInput(input)) {
        return fail('invalid_input', { method: 'launch.openDataFolder' });
      }
      return services.launch.openDataFolder(input);
    },
  };
}

/** `{ harnessId, workspace? }`, the Workspace an absolute path or null, nothing else. */
function parseLaunchRequest(input: unknown): LaunchRequest | null {
  if (typeof input !== 'object' || input === null) return null;
  const { harnessId, workspace, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !isHarnessIdInput(harnessId)) return null;
  if (workspace === undefined) return { harnessId };
  if (workspace !== null && !isAbsolutePath(workspace)) return null;
  return { harnessId, workspace };
}

/** An absolute path of this OS, as the folder picker returns it. */
function isAbsolutePath(input: unknown): input is string {
  return typeof input === 'string' && !input.includes('\0') && isAbsolute(input);
}

/** The auth call's state, or its {@link StoreAuthError} as that error code; anything else throws. */
async function authResult(call: () => Promise<AuthState>): Promise<IpcResult<AuthState>> {
  try {
    return ok(await call());
  } catch (error) {
    if (error instanceof StoreAuthError) return fail(error.code);
    throw error;
  }
}
