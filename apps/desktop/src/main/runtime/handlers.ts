import type { IpcMethodName, IpcOutput, IpcResult } from '../../shared/ipc.js';
import { parseConnectionDraft } from './connections.js';
import { fail, ok } from './ipc-result.js';
import type { Services } from './services.js';
import { parseSettingsPatch } from './settings.js';

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
    'connections.add': (input) => {
      const draft = parseConnectionDraft(input);
      if (draft === null) return fail('invalid_input', { method: 'connections.add' });
      return services.connections.add(draft);
    },
  };
}
