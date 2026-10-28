import { isAbsolute } from 'node:path';
import {
  STORE_SEARCH_MAX_LENGTH,
  type AuthState,
  type IpcMethodName,
  type IpcOutput,
  type IpcResult,
  type LaunchRequest,
  type PublishRequest,
  type StoreHomeRequest,
  type StoreSearchRequest,
  type UnpublishRequest,
} from '../../shared/ipc.js';
import { isTag } from '../../shared/tags.js';
import {
  isHarnessIdInput,
  parseGlobalBindingChange,
  parseManifestSlotsRequest,
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
    'store.home': (input) => {
      const request = parseStoreHomeRequest(input);
      if (request === null) return fail('invalid_input', { method: 'store.home' });
      return services.store.home(request);
    },
    'store.search': (input) => {
      const request = parseStoreSearchRequest(input);
      if (request === null) return fail('invalid_input', { method: 'store.search' });
      return services.store.search(request);
    },
    'store.detail': (input) => {
      if (!isHarnessIdInput(input) || !input.includes('/')) {
        return fail('invalid_input', { method: 'store.detail' });
      }
      return services.store.detail(input);
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
    'bindings.resolveManifest': (input) => {
      const request = parseManifestSlotsRequest(input);
      if (request === null) {
        return fail('invalid_input', { method: 'bindings.resolveManifest' });
      }
      return services.bindings.resolveManifest(request);
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
    'publish.validateFolder': (input) => {
      if (!isAbsolutePath(input)) {
        return fail('invalid_input', { method: 'publish.validateFolder' });
      }
      return services.publish.validateFolder(input);
    },
    'publish.stopWatching': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'publish.stopWatching' });
      services.publish.stopWatching();
      return ok(null);
    },
    'publish.publish': (input) => {
      const request = parsePublishRequest(input);
      if (request === null) return fail('invalid_input', { method: 'publish.publish' });
      return services.publish.publish(request);
    },
    'publish.cancel': (input) => {
      if (!isJobId(input)) return fail('invalid_input', { method: 'publish.cancel' });
      services.publish.cancel(input);
      return ok(null);
    },
    'publish.myHarnesses': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'publish.myHarnesses' });
      return services.publish.myHarnesses();
    },
    'publish.unpublish': (input) => {
      const request = parseUnpublishRequest(input);
      if (request === null) return fail('invalid_input', { method: 'publish.unpublish' });
      return services.publish.unpublish(request);
    },
  };
}

/** `{ refresh? }` with a boolean, nothing else; no input at all is `{}`. */
function parseStoreHomeRequest(input: unknown): StoreHomeRequest | null {
  if (input === undefined) return {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const { refresh, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (refresh === undefined) return {};
  return typeof refresh === 'boolean' ? { refresh } : null;
}

/** The greatest `offset` Postgres takes as an `int`. */
const MAX_SEARCH_OFFSET = 2_147_483_647;

/**
 * `{ q, tags, allPlatforms, offset }`, nothing else: text of at most 200 characters, curated tags
 * (each once), a boolean and a whole offset from 0 that Postgres takes as an `int`.
 */
function parseStoreSearchRequest(input: unknown): StoreSearchRequest | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const { q, tags, allPlatforms, offset, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (typeof q !== 'string' || q.length > STORE_SEARCH_MAX_LENGTH) return null;
  if (!Array.isArray(tags) || !tags.every(isTag) || new Set(tags).size !== tags.length) {
    return null;
  }
  if (typeof allPlatforms !== 'boolean') return null;
  if (
    !Number.isInteger(offset) ||
    (offset as number) < 0 ||
    (offset as number) > MAX_SEARCH_OFFSET
  ) {
    return null;
  }
  return { q, tags, allPlatforms, offset: offset as number };
}

/** `{ harnessId, version }`, a `<publisher>/<slug>` ID and a version string, nothing else. */
function parseUnpublishRequest(input: unknown): UnpublishRequest | null {
  if (typeof input !== 'object' || input === null) return null;
  const { harnessId, version, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !isHarnessIdInput(harnessId)) return null;
  if (!harnessId.includes('/')) return null;
  if (typeof version !== 'string' || version === '' || version.length > 256) return null;
  return { harnessId, version };
}

/** `{ archiveId, jobId }`, both IDs, nothing else. */
function parsePublishRequest(input: unknown): PublishRequest | null {
  if (typeof input !== 'object' || input === null) return null;
  const { archiveId, jobId, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !isJobId(archiveId) || !isJobId(jobId)) return null;
  return { archiveId, jobId };
}

/** An archive or job ID: a UUID, or at least something as plain. */
function isJobId(input: unknown): input is string {
  return typeof input === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(input);
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
