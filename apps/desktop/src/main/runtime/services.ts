import type { Diagnostics, StartupStatus } from '../../shared/ipc.js';
import type { ConnectivityService } from './connectivity.js';
import type { SettingsService } from './settings.js';

/**
 * The service container: everything an IPC handler may use, created once by
 * {@link startRuntime} (./bootstrap.ts) and passed to {@link createHandlers}. Tests pass a fake.
 * Later specs add Connections and the Supervisor here.
 */
export interface Services {
  readonly app: {
    /** The desktop app's version (`app.getVersion()`, from package.json). */
    readonly version: string;
    /** How the Runtime's startup went. */
    readonly status: () => StartupStatus;
    /** Quits the app; the Runtime shuts down on the way out. */
    readonly quit: () => void;
  };
  readonly settings: SettingsService;
  readonly diagnostics: {
    readonly get: () => Diagnostics;
  };
  /** Whether the Store is reachable. */
  readonly connectivity: Pick<ConnectivityService, 'get' | 'check'>;
}
