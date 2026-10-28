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
 * that is not a known one reads as absent; `onboarding_done` is true only when it is stored as
 * `true`, so a fresh profile starts with the first-run wizard.
 */
export function createSettingsService(
  store: SettingsStore,
  osLocale: () => string,
): SettingsService {
  const get = (): Settings => {
    const stored = store.read('locale');
    const locale = isLocale(stored) ? stored : undefined;
    const resolvedLocale = resolveLocale(locale, osLocale());
    const onboardingDone = store.read('onboarding_done') === true;
    return locale === undefined
      ? { resolvedLocale, onboardingDone }
      : { locale, resolvedLocale, onboardingDone };
  };
  return {
    get,
    set(patch) {
      if (patch.locale !== undefined) store.write('locale', patch.locale ?? undefined);
      if (patch.onboardingDone !== undefined) store.write('onboarding_done', patch.onboardingDone);
      return get();
    },
  };
}

/** The patch when `input` is a well-formed {@link SettingsPatch}, else null (never throws). */
export function parseSettingsPatch(input: unknown): SettingsPatch | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const allowed = new Set(['locale', 'onboardingDone']);
  if (!Object.keys(input).every((key) => allowed.has(key))) return null;
  const { locale, onboardingDone } = input as { locale?: unknown; onboardingDone?: unknown };
  if (locale !== undefined && locale !== null && !isLocale(locale)) return null;
  if (onboardingDone !== undefined && typeof onboardingDone !== 'boolean') return null;
  return {
    ...(locale === undefined ? {} : { locale }),
    ...(onboardingDone === undefined ? {} : { onboardingDone }),
  };
}
