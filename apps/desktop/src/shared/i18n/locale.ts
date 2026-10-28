/** The UI languages: English and Simplified Chinese. There is no third locale in P0. */
export const LOCALES = ['en', 'zh-CN'] as const;

export type Locale = (typeof LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return LOCALES.includes(value as Locale);
}

/**
 * The locale the UI renders in: the User's override from Settings, else the OS locale, where
 * every Chinese variant (`zh`, `zh-CN`, `zh_TW`, `zh-Hant-HK`, any case) maps to `zh-CN` and
 * anything else to `en`. `osLocale` is what Electron's `app.getLocale()` returns.
 */
export function resolveLocale(override: Locale | undefined, osLocale: string): Locale {
  if (override !== undefined) return override;
  return /^zh(?:[-_]|$)/i.test(osLocale) ? 'zh-CN' : 'en';
}
