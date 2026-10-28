import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isLocale, type Locale } from '../../shared/i18n/locale.js';
import { parseWindowState, type WindowState } from './window-state.js';

/**
 * Small app state the Runtime keeps before the SQLite settings table exists (P0-04.3 moves it
 * there): one JSON file in the userData directory.
 */
export interface AppState {
  readonly windowState?: WindowState;
  /** The User's language override; absent means "System". */
  readonly locale?: Locale;
}

export const APP_STATE_FILE_NAME = 'app-state.json';

export interface AppStateFile {
  /** The stored state; a missing, unreadable or malformed file (or field) reads as absent. */
  read(): AppState;
  /**
   * Merges `patch` into the stored state and writes it atomically (temp file, then rename). A
   * field set to `undefined` is removed.
   */
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
    const fields = raw as { windowState?: unknown; locale?: unknown };
    const windowState = parseWindowState(fields.windowState);
    return {
      ...(windowState === null ? {} : { windowState }),
      ...(isLocale(fields.locale) ? { locale: fields.locale } : {}),
    };
  };
  return {
    read,
    update(patch) {
      // JSON.stringify drops the fields the patch set to undefined.
      const next = { ...read(), ...patch };
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(temporary, path);
    },
  };
}
