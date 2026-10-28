import en from './en.json';
import type { Locale } from './locale.js';
import zhCN from './zh-CN.json';

/**
 * The message catalogs: one flat JSON object per locale, literal keys (never nested) to ICU
 * message templates. Main and the renderer both bundle them.
 *
 * Key namespaces: UI strings by screen (`section.library`, `settings.language`); `error.<code>`
 * for IPC and Model Gateway error codes; `manifest.<messageKey>` for Manifest problems, whose
 * English text is a verbatim copy of `MESSAGES_EN` from @harness-store/manifest. A test keeps the
 * zh-CN keys and ICU arguments identical to en's.
 */
export type MessageKey = keyof typeof en;

export type Catalog = Readonly<Record<string, string>>;

export const CATALOGS: Readonly<Record<Locale, Catalog>> = { en, 'zh-CN': zhCN };
