import { IntlMessageFormat } from 'intl-messageformat';
import { CATALOGS, type Catalog, type MessageKey } from './catalogs.js';
import type { Locale } from './locale.js';

export type MessageParams = Readonly<Record<string, string | number | Date>>;

/**
 * Text that arrives from the Runtime or a validator with a catalog key and an English fallback:
 * an IPC error (`messageKey` is `error.<code>`) or a Manifest problem (`messageKey` is the
 * Manifest's own key, looked up under `manifest.`).
 */
export interface LocalizableMessage {
  readonly messageKey: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly message: string;
}

export interface Translator {
  readonly locale: Locale;
  /** A UI string from the catalog, with its ICU arguments filled from `params`. */
  readonly t: (key: MessageKey, params?: MessageParams) => string;
  /** An IPC error's text in this locale. */
  readonly errorText: (error: LocalizableMessage) => string;
  /** A Manifest problem's text in this locale. */
  readonly problemText: (problem: LocalizableMessage) => string;
}

const translators = new Map<Locale, Translator>();

/**
 * The translator for `locale` (one per locale, with its compiled messages cached). When a key is
 * missing from the locale's catalog or its message cannot be formatted (a param is missing, say),
 * the en catalog is tried next, then the given English `message`, then the key itself. With
 * complete catalogs none of these fallbacks fires.
 */
export function translatorFor(locale: Locale): Translator {
  let translator = translators.get(locale);
  if (translator === undefined) {
    translator = createTranslator(locale);
    translators.set(locale, translator);
  }
  return translator;
}

/**
 * A translator for `locale` over `catalogs`, with the fallbacks `translatorFor` describes. The app
 * uses `translatorFor`; tests pass their own catalogs to exercise each fallback.
 */
export function createTranslator(
  locale: Locale,
  catalogs: Readonly<Record<Locale, Catalog>> = CATALOGS,
): Translator {
  const formats = new Map<string, IntlMessageFormat | null>();

  const formatIn = (
    catalogLocale: Locale,
    key: string,
    params: MessageParams | undefined,
  ): string | undefined => {
    const cacheKey = `${catalogLocale}\u0000${key}`;
    let format = formats.get(cacheKey);
    if (format === undefined) {
      const catalog = catalogs[catalogLocale];
      const template = Object.hasOwn(catalog, key) ? catalog[key] : undefined;
      format = template === undefined ? null : compile(template, locale);
      formats.set(cacheKey, format);
    }
    if (format === null) return undefined;
    try {
      return String(format.format(params));
    } catch {
      return undefined;
    }
  };

  const lookup = (key: string, params: MessageParams | undefined, fallback: string): string =>
    formatIn(locale, key, params) ?? formatIn('en', key, params) ?? fallback;

  return {
    locale,
    t: (key, params) => lookup(key, params, key),
    errorText: ({ messageKey, params, message }) => lookup(messageKey, params, message),
    problemText: ({ messageKey, params, message }) =>
      lookup(`manifest.${messageKey}`, params, message),
  };
}

/** Compiles `template` for formatting in `locale`; null when it is not valid ICU. */
function compile(template: string, locale: Locale): IntlMessageFormat | null {
  try {
    return new IntlMessageFormat(template, locale);
  } catch {
    return null;
  }
}
