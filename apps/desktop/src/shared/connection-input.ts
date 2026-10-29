/**
 * Pure checks on what a User types into a Connection form: an API key, a base URL and the name of
 * a custom OpenAI-compatible endpoint. The renderer uses them for inline feedback before it calls
 * the Runtime; the Runtime runs them again on every `connections.add` and `connections.update`,
 * since its input crossed a process boundary. No Node or DOM APIs, so both processes bundle it.
 */

/** The longest name a custom OpenAI-compatible endpoint may have, in characters. */
export const MAX_CONNECTION_NAME_LENGTH = 64;

/** The Connection id prefix of a named custom endpoint: `openai-compatible:<slug>`. */
export const CUSTOM_CONNECTION_PREFIX = 'openai-compatible:';

/** Whitespace or a control character: never part of a real API key. */
const NOT_IN_A_KEY = /[\s\p{Cc}]/u;

/**
 * A typed API key, trimmed: `undefined` when nothing was typed, `null` when what was typed cannot
 * be a key (whitespace or control characters inside it, a pasted line break say).
 */
export function parseApiKey(raw: string): string | undefined | null {
  const key = raw.trim();
  if (key === '') return undefined;
  return NOT_IN_A_KEY.test(key) ? null : key;
}

/**
 * A typed base URL with its trailing `/` removed: `undefined` when nothing was typed, `null` when
 * it is not an absolute `http` or `https` URL.
 */
export function parseBaseUrl(raw: string): string | undefined | null {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return trimmed.replace(/\/+$/, '');
}

/** A custom endpoint's name, trimmed; `null` when it is empty or longer than allowed. */
export function parseConnectionName(raw: string): string | null {
  const name = raw.trim();
  return name === '' || Array.from(name).length > MAX_CONNECTION_NAME_LENGTH ? null : name;
}

/** Whether `name` is already used by one of `names`, ignoring letter case. */
export function isNameTaken(name: string, names: Iterable<string>): boolean {
  const wanted = name.trim().toLocaleLowerCase('en');
  for (const other of names) if (other.trim().toLocaleLowerCase('en') === wanted) return true;
  return false;
}

/**
 * The Connection id for a new custom endpoint called `name`: `openai-compatible:<slug>`, where the
 * slug is the name in lower case with each run of characters other than `a-z` and `0-9` turned
 * into one `-`, without a leading or trailing `-` (`endpoint` when nothing is left, a name in
 * Chinese say). When `taken` already holds that id, `-2`, `-3`, … is appended. The id never
 * changes afterwards, even when the endpoint is renamed.
 */
export function customConnectionId(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'endpoint';
  let id = `${CUSTOM_CONNECTION_PREFIX}${slug}`;
  for (let n = 2; taken.has(id); n += 1) id = `${CUSTOM_CONNECTION_PREFIX}${slug}-${String(n)}`;
  return id;
}

/**
 * What the UI may show of a stored key: its last 4 characters, or nothing (`''`) for a key shorter
 * than 12 characters, where 4 characters would give away too much of it.
 */
export function keyHintFor(key: string): string {
  const characters = Array.from(key);
  return characters.length < 12 ? '' : characters.slice(-4).join('');
}
