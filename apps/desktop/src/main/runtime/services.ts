import type { Diagnostics, ProviderPreset, StartupStatus } from '../../shared/ipc.js';
import type { BindingsService } from './bindings.js';
import type { ConnectionsService } from './connections.js';
import type { ConnectivityService } from './connectivity.js';
import type { SettingsService } from './settings.js';
import type { StoreAuth } from './store-auth.js';

/**
 * The service container: everything an IPC handler may use, created once by
 * {@link startRuntime} (./bootstrap.ts) and passed to {@link createHandlers}. Tests pass a fake.
 * Later specs add the Supervisor here.
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
  readonly providers: {
    /** Every Provider of the Gateway's table. */
    readonly list: () => readonly ProviderPreset[];
  };
  /** The User's Connections, with their encrypted secrets, and local Provider detection. */
  readonly connections: ConnectionsService;
  /** The User's Slot Bindings: the Default Models. */
  readonly bindings: BindingsService;
  /** The Publisher's sign-in to the Store. */
  readonly auth: Pick<StoreAuth, 'signIn' | 'signOut' | 'whoami'>;
}
