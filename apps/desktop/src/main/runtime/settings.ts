import { isLocale, resolveLocale } from '../../shared/i18n/locale.js';
import type { Settings, SettingsPatch } from '../../shared/ipc.js';
import type { SettingsStore } from './settings-store.js';

/** The app settings the renderer reads and writes over IPC (`settings.get`, `settings.set`). */
export interface SettingsService {
  get(): Settings;
  /** Applies a patch that {@link parseSettingsPatch} accepted; returns the new settings. */
  set(patch: SettingsPatch): Settings;
}

/**
 * Settings kept in `store` (the SQLite `settings` table). `osLocale` is Electron's
 * `app.getLocale()`, read on every call so the resolved locale follows the OS. A stored locale
 * that is not a known one reads as absent.
 */
export function createSettingsService(
  store: SettingsStore,
  osLocale: () => string,
): SettingsService {
  const get = (): Settings => {
    const stored = store.read('locale');
    const locale = isLocale(stored) ? stored : undefined;
    const resolvedLocale = resolveLocale(locale, osLocale());
    return locale === undefined ? { resolvedLocale } : { locale, resolvedLocale };
  };
  return {
    get,
    set(patch) {
      if (patch.locale !== undefined) store.write('locale', patch.locale ?? undefined);
      return get();
    },
  };
}

/** The patch when `input` is a well-formed {@link SettingsPatch}, else null (never throws). */
export function parseSettingsPatch(input: unknown): SettingsPatch | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const allowed = new Set(['locale']);
  if (!Object.keys(input).every((key) => allowed.has(key))) return null;
  const { locale } = input as { locale?: unknown };
  if (locale === undefined) return {};
  if (locale === null || isLocale(locale)) return { locale };
  return null;
}
