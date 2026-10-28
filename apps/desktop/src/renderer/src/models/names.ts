import type { MessageKey } from '../../../shared/i18n/catalogs.js';
import type { Translator } from '../../../shared/i18n/translate.js';
import type { ConnectionSummary } from '../../../shared/ipc.js';

/** The Provider id of the custom OpenAI-compatible endpoint. */
export const CUSTOM_PROVIDER_ID = 'openai-compatible';

/**
 * A Provider's name in the UI language: its `provider.<id>` catalog entry, else `fallback` (the
 * Gateway's English name), so a Provider added to the table before its catalog entries still
 * shows a name.
 */
export function providerName(t: Translator['t'], providerId: string, fallback: string): string {
  const key = `provider.${providerId}`;
  const name = t(key as MessageKey);
  return name === key ? fallback : name;
}

/** What a Connection is called: a custom endpoint's own name, else its Provider's name. */
export function connectionName(t: Translator['t'], connection: ConnectionSummary): string {
  return connection.providerId === CUSTOM_PROVIDER_ID
    ? connection.displayName
    : providerName(t, connection.providerId, connection.displayName);
}

/** The letter shown in place of a logo: the first letter or digit of `name`, upper-cased. */
export function monogram(name: string): string {
  const first = /[\p{L}\p{N}]/u.exec(name)?.[0] ?? '?';
  return first.toLocaleUpperCase();
}

/** The status a Connection row shows, by priority. */
export type ConnectionStatus = 'disabled' | 'failed' | 'local' | 'connected' | 'untested';

export function connectionStatus(connection: ConnectionSummary): ConnectionStatus {
  if (!connection.enabled) return 'disabled';
  if (connection.lastTestOk === false) return 'failed';
  if (connection.local) return 'local';
  if (connection.lastTestOk === true) return 'connected';
  return 'untested';
}
