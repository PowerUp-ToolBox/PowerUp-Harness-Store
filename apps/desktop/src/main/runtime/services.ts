import type { AppFolder, IpcResult, ProviderPreset, StartupStatus } from '../../shared/ipc.js';
import type { BindingsService } from './bindings.js';
import type { ConnectionsService } from './connections.js';
import type { ConnectivityService } from './connectivity.js';
import type { DiagnosticsService } from './diagnostics.js';
import type { InstallsService } from './installer.js';
import type { PublishService } from './publish.js';
import type { SettingsService } from './settings.js';
import type { StoreAuth } from './store-auth.js';
import type { StoreCatalogue } from './store-catalogue.js';
import type { StoreReporter } from './store-report.js';
import type { Supervisor } from './supervisor.js';
import type { UsageService } from './usage.js';

/**
 * The service container: everything an IPC handler may use, created once by
 * {@link startRuntime} (./bootstrap.ts) and passed to {@link createHandlers}. Tests pass a fake.
 */
export interface Services {
  readonly app: {
    /** The desktop app's version (`app.getVersion()`, from package.json). */
    readonly version: string;
    /** How the Runtime's startup went. */
    readonly status: () => StartupStatus;
    /** Quits the app; the Runtime shuts down on the way out. */
    readonly quit: () => void;
    /**
     * Opens the app data root or its logs folder (created when missing) in the OS file browser;
     * `open_failed` with the path when the OS could not.
     */
    readonly openFolder: (folder: AppFolder) => Promise<IpcResult<null>>;
  };
  readonly settings: SettingsService;
  readonly diagnostics: DiagnosticsService;
  /** Whether the Store is reachable. */
  readonly connectivity: Pick<ConnectivityService, 'get' | 'check'>;
  /** The Store's public catalogue, read anonymously: the Store tab's lists and pages. */
  readonly store: Omit<StoreCatalogue, 'clearCache'>;
  /** Reporting a Harness to the Store, anonymously, with the client-side rate limit. */
  readonly reports: StoreReporter;
  readonly providers: {
    /** Every Provider of the Gateway's table. */
    readonly list: () => readonly ProviderPreset[];
  };
  /** The User's Connections, with their encrypted secrets, and local Provider detection. */
  readonly connections: ConnectionsService;
  /** The User's Slot Bindings: the Default Models and the Model Overrides. */
  readonly bindings: BindingsService;
  /** The Publisher's sign-in to the Store. */
  readonly auth: Pick<StoreAuth, 'signIn' | 'signOut' | 'whoami'>;
  /** The installed Harnesses, and installing one from a local folder or from the Store. */
  readonly installs: InstallsService;
  /**
   * The update check of the Store installs: `check` runs one now (Check now), resolving whether
   * the Store answered.
   */
  readonly updates: { readonly check: () => Promise<boolean> };
  /** Launching installed Harnesses (the Process Supervisor), and how their launches are going. */
  readonly launch: Pick<
    Supervisor,
    'start' | 'chooseWorkspace' | 'lastWorkspace' | 'status' | 'openLogs' | 'openDataFolder'
  >;
  /**
   * The Publish flow: building and validating a folder's Harness Package, watching it, and
   * uploading it; the Publisher's Harnesses, and Unpublishing a version.
   */
  readonly publish: Pick<
    PublishService,
    'validateFolder' | 'stopWatching' | 'publish' | 'cancel' | 'myHarnesses' | 'unpublish'
  >;
  /** The Usage page: the Model Gateway's Usage Records, aggregated, exported and cleared. */
  readonly usage: UsageService;
}
