import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { formatBytes, formatDate, formatNumber } from '../../../shared/i18n/format.js';
import { translatorFor, type Translator } from '../../../shared/i18n/translate.js';
import type { IpcResult, Settings, SettingsPatch } from '../../../shared/ipc.js';

/** Everything a component needs to render text: `t()` plus Intl formatting in the UI locale. */
export interface I18n extends Translator {
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  readonly formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly formatBytes: (bytes: number) => string;
}

export interface SettingsState {
  readonly settings: Settings;
  /** Writes the patch through the Runtime; on success every consumer re-renders with it. */
  readonly updateSettings: (patch: SettingsPatch) => Promise<IpcResult<Settings>>;
}

const I18nContext = createContext<I18n | null>(null);
const SettingsContext = createContext<SettingsState | null>(null);

// Used only if the Runtime cannot answer settings.get, which falls back to the OS locale itself.
const FALLBACK_SETTINGS: Settings = { resolvedLocale: 'en' };

/**
 * Loads the settings from the Runtime and provides them with the UI locale's translator. The
 * Runtime resolves the locale (override, else OS locale); the renderer never reads
 * `navigator.language`. Nothing renders until the settings arrive, so no screen flashes in the
 * wrong language. Changing the locale re-renders every screen in place, without a restart.
 */
export function I18nProvider({ children }: { readonly children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let current = true;
    void window.api.settings.get().then(
      (result) => {
        if (current) setSettings(result.ok ? result.data : FALLBACK_SETTINGS);
      },
      () => {
        if (current) setSettings(FALLBACK_SETTINGS);
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const locale = settings?.resolvedLocale;
  useEffect(() => {
    if (locale !== undefined) document.documentElement.lang = locale;
  }, [locale]);

  const i18n = useMemo<I18n | null>(
    () =>
      locale === undefined
        ? null
        : {
            ...translatorFor(locale),
            formatNumber: (value, options) => formatNumber(locale, value, options),
            formatDate: (value, options) => formatDate(locale, value, options),
            formatBytes: (bytes) => formatBytes(locale, bytes),
          },
    [locale],
  );

  const updateSettings = useCallback(async (patch: SettingsPatch) => {
    const result = await window.api.settings.set(patch);
    if (result.ok) setSettings(result.data);
    return result;
  }, []);

  const settingsState = useMemo<SettingsState | null>(
    () => (settings === null ? null : { settings, updateSettings }),
    [settings, updateSettings],
  );

  if (i18n === null || settingsState === null) return null;
  return (
    <SettingsContext.Provider value={settingsState}>
      <I18nContext.Provider value={i18n}>{children}</I18nContext.Provider>
    </SettingsContext.Provider>
  );
}

/** The `t(key, params)` hook and Intl formatters for the current UI locale. */
export function useI18n(): I18n {
  const i18n = useContext(I18nContext);
  if (i18n === null) throw new Error('useI18n must be used inside <I18nProvider>');
  return i18n;
}

export function useSettings(): SettingsState {
  const state = useContext(SettingsContext);
  if (state === null) throw new Error('useSettings must be used inside <I18nProvider>');
  return state;
}
