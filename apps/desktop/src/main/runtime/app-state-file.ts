import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseWindowState, type WindowState } from './window-state.js';

/**
 * Small app state the Runtime keeps before the SQLite settings table exists (P0-04.3 moves it
 * there): one JSON file in the userData directory.
 */
export interface AppState {
  readonly windowState?: WindowState;
}

export const APP_STATE_FILE_NAME = 'app-state.json';

export interface AppStateFile {
  /** The stored state; a missing, unreadable or malformed file (or field) reads as absent. */
  read(): AppState;
  /** Merges `patch` into the stored state and writes it atomically (temp file, then rename). */
  update(patch: AppState): void;
}

export function createAppStateFile(path: string): AppStateFile {
  const read = (): AppState => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return {};
    }
    if (typeof raw !== 'object' || raw === null) return {};
    const windowState = parseWindowState((raw as { windowState?: unknown }).windowState);
    return windowState === null ? {} : { windowState };
  };
  return {
    read,
    update(patch) {
      const next = { ...read(), ...patch };
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(temporary, path);
    },
  };
}
