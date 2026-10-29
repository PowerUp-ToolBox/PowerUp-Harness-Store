import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createGateway, type Gateway, type GatewayOptions } from '@harness-store/gateway';
import type { IpcEventName, IpcEvents, StartupStage, StartupStatus } from '../../shared/ipc.js';
import { createConnectionsStub, providerPresets } from './connections.js';
import {
  createConnectivityService,
  storeBaseUrlFrom,
  type ConnectivityService,
  type FetchLike,
} from './connectivity.js';
import { DATABASE_FILE_NAME, openDatabase } from './database.js';
import type { Services } from './services.js';
import { createSettingsService } from './settings.js';
import {
  createMemorySettingsStore,
  createSqliteSettingsStore,
  type SettingsStore,
} from './settings-store.js';
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
  /** Pushes an event to the main window; dropped while there is none. */
  readonly emit?: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void;
  /** Creates the Model Gateway; tests wrap the real one to make `listen` fail. */
  readonly createGateway?: (options: GatewayOptions) => Gateway;
  /** Reports startup and shutdown failures. Default: `console.error`. */
  readonly logError?: (message: string, error: unknown) => void;
}

/** The started Runtime: its IPC services and what the Electron entry point needs around them. */
export interface Runtime {
  readonly status: StartupStatus;
  readonly services: Services;
  /** Whether the Store is reachable; the Store client (P0-09) reports failed requests to it. */
  readonly connectivity: ConnectivityService;
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
  let sqlite: { settings: SettingsStore; usageRecords: UsageRecordStore } | null = null;
  try {
    mkdirSync(options.dataDir, { recursive: true });
    db = openDatabase(databasePath);
    sqlite = { settings: createSqliteSettingsStore(db), usageRecords: createUsageRecordStore(db) };
  } catch (error) {
    db?.close();
    db = null;
    status = failed('database', error);
  }

  let gateway: Gateway | null = null;
  /** The Model Gateway's port while it listens; null before, after a failed start and on shutdown. */
  let gatewayPort: number | null = null;
  if (sqlite !== null) {
    const { usageRecords } = sqlite;
    // Slot Bindings, Connections and installed Manifests arrive with P0-03 and P0-10; until then
    // nothing resolves, so a Harness request ends in slot_unbound or provider_not_connected.
    gateway = (options.createGateway ?? createGateway)({
      resolveBinding: () => Promise.resolve(null),
      getConnection: () => Promise.resolve(null),
      getManifest: () => Promise.resolve(null),
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

  return {
    status: startupStatus,
    connectivity,
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
      connections: createConnectionsStub(),
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
