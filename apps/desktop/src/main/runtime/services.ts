import type { SettingsService } from './settings.js';

/**
 * The service container: everything an IPC handler may use, created once by the Electron entry
 * point (src/main/index.ts) and passed to {@link createHandlers}. Tests pass a fake. Later specs add
 * the Gateway, Connections and the Supervisor here.
 */
export interface Services {
  readonly app: {
    /** The desktop app's version (`app.getVersion()`, from package.json). */
    readonly version: string;
  };
  readonly settings: SettingsService;
}
