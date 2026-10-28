import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createGateway, type Gateway, type GatewayOptions } from '@harness-store/gateway';
import type { IpcEventName, IpcEvents, StartupStage, StartupStatus } from '../../shared/ipc.js';
import { createBindingsService, createBindingsStub } from './bindings.js';
import { createConnectionStore, type ConnectionStore } from './connection-store.js';
import {
  createConnectionsService,
  createConnectionsStub,
  createProviderChecks,
  providerPresets,
  type ConnectionsService,
} from './connections.js';
import {
  createConnectivityService,
  storeAnonKey,
  storeBaseUrlFrom,
  type ConnectivityService,
  type FetchLike,
} from './connectivity.js';
import { DATABASE_FILE_NAME, openDatabase } from './database.js';
import { createGatewayHost } from './gateway-host.js';
import { platformOf } from './harness-paths.js';
import { createInstallStore, type InstallStore } from './install-store.js';
import { createInstaller, createInstallsStub, type InstallsService } from './installer.js';
import { createLocalDetector, type LocalProbeTarget } from './local-detection.js';
import type { SecretCipher } from './secret-cipher.js';
import type { Services } from './services.js';
import {
  createMemorySessionSlot,
  createSqliteSessionSlot,
  type SessionSlot,
} from './session-slot.js';
import { createSettingsService } from './settings.js';
import {
  createMemorySettingsStore,
  createSqliteSettingsStore,
  type SettingsStore,
} from './settings-store.js';
import { createStoreAuth, type StoreAuth, type StoreFetch } from './store-auth.js';
import { createUsageRecordStore, type UsageRecordStore } from './usage-records.js';
import { parseWindowState, type WindowState } from './window-state.js';

export interface RuntimeOptions {
  /** The app data root (Electron's userData folder); the SQLite file lives in it. */
  readonly dataDir: string;
  /** The desktop app's version. */
  readonly version: string;
  /** The OS locale (Electron's `app.getLocale()`), read on every call. */
  readonly osLocale: () => string;
  /** Quits the app (Electron's `app.quit()`), which shuts the Runtime down first. */
  readonly quit: () => void;
  /** Makes the Store connectivity checks (Electron's `net.fetch`, so system proxies apply). */
  readonly fetch: FetchLike;
  /**
   * Makes the Store's Auth and PostgREST calls for the Publisher's sign-in (Electron's `net.fetch`).
   * Default: Node's `fetch`.
   */
  readonly storeFetch?: StoreFetch;
  /**
   * Opens a URL in the User's default browser (Electron's `shell.openExternal`): the Store's
   * GitHub sign-in. Default: fails, as nothing can open a browser.
   */
  readonly openExternal?: (url: string) => Promise<void>;
  /** The Store's anon key. Default: {@link storeAnonKey}. */
  readonly storeAnonKey?: string;
  /**
   * Tests Connections, lists their models and detects local Providers: Node's `fetch`, the one the
   * Model Gateway's upstream calls use, so a passing test means the Gateway reaches the same place.
   * Tests pass a fake.
   */
  readonly providerFetch: typeof globalThis.fetch;
  /**
   * Where local Provider detection looks, over `providerFetch`. Default: the base URLs of Ollama
   * and LM Studio in the Provider table. Tests point it at fake Providers on ports the OS picks.
   */
  readonly localProbeTargets?: readonly LocalProbeTarget[];
  /**
   * The clock of Connection test times, the model-list cache and the Store session's expiry.
   * Default: the system clock.
   */
  readonly now?: () => Date;
  /**
   * Encrypts Connection secrets and the Store session (Electron's `safeStorage`); tests pass a
   * reversible fake.
   */
  readonly secretCipher: SecretCipher;
  /**
   * Opens the OS folder picker (Electron's `dialog`) and resolves the chosen folder, or null when
   * the User cancels. Default: always cancelled.
   */
  readonly pickFolder?: () => Promise<string | null>;
  /**
   * This machine's platform as `<process.platform>-<process.arch>`, which decides whether an
   * installed Harness can run here. Default: this process's.
   */
  readonly platform?: string;
  /** Pushes an event to the main window; dropped while there is none. */
  readonly emit?: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void;
  /** Creates the Model Gateway; tests wrap the real one to make `listen` fail. */
  readonly createGateway?: (options: GatewayOptions) => Gateway;
  /**
   * Reports startup and shutdown failures, and an install's cleanup that failed after it was
   * recorded. Default: `console.error`.
   */
  readonly logError?: (message: string, error: unknown) => void;
}

/** The started Runtime: its IPC services and what the Electron entry point needs around them. */
export interface Runtime {
  readonly status: StartupStatus;
  readonly services: Services;
  /** Whether the Store is reachable; the Store client (P0-09) reports failed requests to it. */
  readonly connectivity: ConnectivityService;
  /**
   * The Publisher's Store sign-in. The Electron entry point hands it every
   * `harnessstore://auth-callback` URL the OS opens the app with; Store clients (P0-08) take
   * their access token from it.
   */
  readonly auth: StoreAuth;
  /** The main window's geometry, kept in the `window_state` setting. */
  readonly windowState: {
    read(): WindowState | null;
    /** Does nothing once {@link Runtime.shutdown} has begun: the database is closing. */
    save(state: WindowState): void;
  };
  /**
   * Stops the Store connectivity checks and the Model Gateway (it stops listening and hands over
   * its last Usage Records), then closes the database. Idempotent: later calls return the first
   * call's promise.
   */
  shutdown(): Promise<void>;
}

/**
 * Starts the Runtime, in order: open the SQLite database in `dataDir` (creating it and running
 * the migrations on first run), then start the Model Gateway on `127.0.0.1` with a port the OS
 * picks, so it never collides with anything the User runs. Never rejects: a failed step ends the
 * startup and is reported in `status`, so the window can show an error screen instead of a broken
 * UI. Without the database, settings live in memory and the UI follows the OS locale. Once both
 * steps succeeded, the first Store connectivity check starts; it is not awaited.
 */
export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const logError =
    options.logError ??
    ((message: string, error: unknown) => {
      console.error(message, error);
    });
  const databasePath = join(options.dataDir, DATABASE_FILE_NAME);
  let status: StartupStatus = { state: 'ready' };
  const failed = (stage: StartupStage, error: unknown): StartupStatus => {
    logError(`Runtime startup failed at the ${stage} step`, error);
    return { state: 'failed', stage, detail: describeError(error) };
  };

  // The stores prepare their statements here too: a database whose schema version is current but
  // whose tables are not what this build expects (a tampered or pre-release file) fails this step
  // instead of rejecting startRuntime later.
  let db: DatabaseSync | null = null;
  let sqlite: {
    settings: SettingsStore;
    usageRecords: UsageRecordStore;
    connections: ConnectionStore;
    session: SessionSlot;
    installs: InstallStore;
  } | null = null;
  try {
    mkdirSync(options.dataDir, { recursive: true });
    db = openDatabase(databasePath);
    sqlite = {
      settings: createSqliteSettingsStore(db),
      usageRecords: createUsageRecordStore(db),
      connections: createConnectionStore(db),
      session: createSqliteSessionSlot(db),
      installs: createInstallStore(db),
    };
  } catch (error) {
    db?.close();
    db = null;
    status = failed('database', error);
  }

  let gateway: Gateway | null = null;
  /** The Model Gateway's port while it listens; null before, after a failed start and on shutdown. */
  let gatewayPort: number | null = null;
  if (sqlite !== null) {
    const { usageRecords, installs } = sqlite;
    // Connections, Slot Bindings and the installed Manifests are read from SQLite on every
    // request.
    gateway = (options.createGateway ?? createGateway)({
      ...createGatewayHost({
        store: sqlite.connections,
        cipher: options.secretCipher,
        getManifest: (harnessId) => Promise.resolve(installs.get(harnessId)?.manifest ?? null),
      }),
      onUsage: (record) => {
        usageRecords.insert(record);
        return Promise.resolve();
      },
    });
    try {
      gatewayPort = (await gateway.listen('127.0.0.1', 0)).port;
    } catch (error) {
      status = failed('gateway', error);
    }
  }

  const store = sqlite?.settings ?? createMemorySettingsStore();
  const connectionStore = sqlite?.connections;
  const connections: ConnectionsService =
    connectionStore === undefined
      ? createConnectionsStub()
      : createConnectionsService({
          store: connectionStore,
          cipher: options.secretCipher,
          ...createProviderChecks(options.providerFetch),
          detectLocal: createLocalDetector({
            fetch: options.providerFetch,
            ...(options.localProbeTargets === undefined
              ? {}
              : { targets: options.localProbeTargets }),
          }),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
  const installs: InstallsService =
    sqlite === null
      ? createInstallsStub()
      : createInstaller({
          store: sqlite.installs,
          root: options.dataDir,
          platform: platformOf(options.platform ?? `${process.platform}-${process.arch}`),
          pickFolder: options.pickFolder ?? (() => Promise.resolve(null)),
          onChanged: (harnessId) => options.emit?.('installs.changed', { harnessId }),
          logError,
          ...(options.now === undefined ? {} : { now: options.now }),
        });
  let stopping = false;
  let stopped: Promise<void> | undefined;
  const startupStatus = status;

  const connectivity = createConnectivityService({
    fetch: options.fetch,
    storeBaseUrl: () => storeBaseUrlFrom(store.read('store_base_url')),
    onChange: (state) => options.emit?.('connectivity.changed', state),
  });
  // A Runtime that failed to start shows only its error screen, which needs no Store.
  if (startupStatus.state === 'ready') void connectivity.check();

  const auth = createStoreAuth({
    fetch: options.storeFetch ?? ((url, init) => globalThis.fetch(url, init)),
    storeBaseUrl: () => storeBaseUrlFrom(store.read('store_base_url')),
    anonKey: options.storeAnonKey ?? storeAnonKey(),
    cipher: options.secretCipher,
    slot: sqlite?.session ?? createMemorySessionSlot(),
    openExternal:
      options.openExternal ?? (() => Promise.reject(new Error('No browser can be opened.'))),
    onChange: (change) => options.emit?.('auth.changed', change),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    status: startupStatus,
    connectivity,
    auth,
    services: {
      app: { version: options.version, status: () => startupStatus, quit: options.quit },
      settings: createSettingsService(store, options.osLocale),
      diagnostics: {
        get: () => ({
          version: options.version,
          gateway: gatewayPort === null ? { running: false } : { running: true, port: gatewayPort },
          databasePath,
        }),
      },
      connectivity,
      providers: { list: () => providerPresets() },
      connections,
      bindings:
        connectionStore === undefined
          ? createBindingsStub()
          : createBindingsService(connectionStore),
      auth,
      installs,
    },
    windowState: {
      read() {
        try {
          return parseWindowState(store.read('window_state'));
        } catch (error) {
          // The window opens at its default size rather than not at all.
          logError('Could not read the window state', error);
          return null;
        }
      },
      save(state) {
        if (!stopping) store.write('window_state', state);
      },
    },
    shutdown() {
      stopped ??= (async () => {
        stopping = true;
        connectivity.stop();
        gatewayPort = null;
        try {
          await gateway?.close();
        } catch (error) {
          logError('The Model Gateway did not stop cleanly', error);
        }
        db?.close();
      })();
      return stopped;
    },
  };
}

/** An error's message followed by its causes', for the startup error screen's details. */
function describeError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && messages.length < 5) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else {
      messages.push(typeof current === 'string' ? current : 'Unknown error');
      current = undefined;
    }
  }
  return messages.join(': ');
}
