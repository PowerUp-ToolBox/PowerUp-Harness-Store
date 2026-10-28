import type { IpcMethodName, IpcOutput, IpcResult } from '../../shared/ipc.js';
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
    'settings.get': (input) => {
      if (input !== undefined) return fail('invalid_input', { method: 'settings.get' });
      return ok(services.settings.get());
    },
    'settings.set': (input) => {
      const patch = parseSettingsPatch(input);
      if (patch === null) return fail('invalid_input', { method: 'settings.set' });
      return ok(services.settings.set(patch));
    },
  };
}
