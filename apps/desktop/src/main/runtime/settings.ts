import { isLocale, resolveLocale } from '../../shared/i18n/locale.js';
import {
  STORE_BASE_URL_MAX_LENGTH,
  UPDATE_CHECK_INTERVALS,
  type Settings,
  type SettingsPatch,
  type UpdateCheckInterval,
} from '../../shared/ipc.js';
import { DEFAULT_STORE_BASE_URL, storeBaseUrlFrom } from './connectivity.js';
import type { SettingsStore } from './settings-store.js';
import { UPDATE_CHECK_INTERVAL_MS } from './update-check.js';

/** The app settings the renderer reads and writes over IPC (`settings.get`, `settings.set`). */
export interface SettingsService {
  get(): Settings;
  /**
   * Applies a patch that {@link parseSettingsPatch} accepted, each value taking effect at once
   * ({@link SettingsEffects}); returns the new settings.
   */
  set(patch: SettingsPatch): Promise<Settings>;
}

/** What a changed setting sets off; every one runs only when the value really changed. */
export interface SettingsEffects {
  /**
   * Runs before another Store base URL is written: the Publisher is signed out, so the session
   * is revoked at the old Store and never sent to the new one. A rejection writes nothing.
   */
  readonly beforeStoreChange?: () => Promise<void>;
  /**
   * Runs once another Store base URL is written: what was read from the old Store is dropped and
   * the new one is checked for connectivity.
   */
  readonly afterStoreChange?: () => void;
  /** Runs once another update check interval is written: the next check is rescheduled. */
  readonly afterUpdateIntervalChange?: () => void;
}

/** The time between update checks for each interval; null for Never. */
export function updateCheckIntervalMs(interval: UpdateCheckInterval): number | null {
  switch (interval) {
    case '1h':
      return 60 * 60 * 1000;
    case '6h':
      return UPDATE_CHECK_INTERVAL_MS;
    case '24h':
      return 24 * 60 * 60 * 1000;
    case 'never':
      return null;
  }
}

/**
 * Settings kept in `store` (the SQLite `settings` table). `osLocale` is Electron's
 * `app.getLocale()`, read on every call so the resolved locale follows the OS. A stored locale
 * or update check interval that is not a known one reads as absent (the interval as `6h`), and a
 * stored Store base URL that is not an http(s) URL as the default Store; `onboarding_done` is
 * true only when it is stored as `true`, so a fresh profile starts with the first-run wizard.
 * A Store base URL equal to the default is not stored: the setting is removed instead.
 */
export function createSettingsService(
  store: SettingsStore,
  osLocale: () => string,
  effects: SettingsEffects = {},
): SettingsService {
  const storedInterval = (): UpdateCheckInterval => {
    const stored = store.read('update_check_interval');
    return isUpdateCheckInterval(stored) ? stored : '6h';
  };
  const get = (): Settings => {
    const stored = store.read('locale');
    const locale = isLocale(stored) ? stored : undefined;
    const resolvedLocale = resolveLocale(locale, osLocale());
    const onboardingDone = store.read('onboarding_done') === true;
    const storeBaseUrl = storeBaseUrlFrom(store.read('store_base_url'));
    return {
      ...(locale === undefined ? {} : { locale }),
      resolvedLocale,
      onboardingDone,
      updateCheckInterval: storedInterval(),
      ...(storeBaseUrl === DEFAULT_STORE_BASE_URL ? {} : { storeBaseUrl }),
      defaultStoreBaseUrl: DEFAULT_STORE_BASE_URL,
    };
  };
  return {
    get,
    async set(patch) {
      if (patch.locale !== undefined) store.write('locale', patch.locale ?? undefined);
      if (patch.onboardingDone !== undefined) store.write('onboarding_done', patch.onboardingDone);
      if (patch.updateCheckInterval !== undefined) {
        const changed = patch.updateCheckInterval !== storedInterval();
        store.write('update_check_interval', patch.updateCheckInterval);
        if (changed) effects.afterUpdateIntervalChange?.();
      }
      if (patch.storeBaseUrl !== undefined) {
        const next =
          patch.storeBaseUrl === null || patch.storeBaseUrl === DEFAULT_STORE_BASE_URL
            ? undefined
            : patch.storeBaseUrl;
        const changed = storeBaseUrlFrom(next) !== storeBaseUrlFrom(store.read('store_base_url'));
        if (changed) await effects.beforeStoreChange?.();
        store.write('store_base_url', next);
        if (changed) effects.afterStoreChange?.();
      }
      return get();
    },
  };
}

/** The patch when `input` is a well-formed {@link SettingsPatch}, else null (never throws). */
export function parseSettingsPatch(input: unknown): SettingsPatch | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const allowed = new Set(['locale', 'onboardingDone', 'updateCheckInterval', 'storeBaseUrl']);
  if (!Object.keys(input).every((key) => allowed.has(key))) return null;
  const { locale, onboardingDone, updateCheckInterval, storeBaseUrl } = input as {
    locale?: unknown;
    onboardingDone?: unknown;
    updateCheckInterval?: unknown;
    storeBaseUrl?: unknown;
  };
  if (locale !== undefined && locale !== null && !isLocale(locale)) return null;
  if (onboardingDone !== undefined && typeof onboardingDone !== 'boolean') return null;
  if (updateCheckInterval !== undefined && !isUpdateCheckInterval(updateCheckInterval)) {
    return null;
  }
  const url =
    storeBaseUrl === undefined || storeBaseUrl === null
      ? storeBaseUrl
      : normalizeStoreBaseUrl(storeBaseUrl);
  if (url === null && storeBaseUrl !== null) return null;
  return {
    ...(locale === undefined ? {} : { locale }),
    ...(onboardingDone === undefined ? {} : { onboardingDone }),
    ...(updateCheckInterval === undefined ? {} : { updateCheckInterval }),
    ...(url === undefined ? {} : { storeBaseUrl: url }),
  };
}

/**
 * A Store base URL as it is stored, or null when it is not one: an absolute `http:` or `https:`
 * URL of at most 2048 characters with no user name or password, query or fragment, and no
 * surrounding spaces. It is stored as the URL parser writes it (scheme and host in lower case),
 * without a trailing slash.
 */
export function normalizeStoreBaseUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > STORE_BASE_URL_MAX_LENGTH) return null;
  if (input.trim() !== input || input.includes('?') || input.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function isUpdateCheckInterval(value: unknown): value is UpdateCheckInterval {
  return (UPDATE_CHECK_INTERVALS as readonly unknown[]).includes(value);
}
