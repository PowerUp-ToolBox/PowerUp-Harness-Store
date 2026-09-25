import type { ProblemParams } from './codes.js';
import { createProblem, isRecord, stringifyJson } from './problem.js';
import type { Problem } from './types.js';

export type LoadedDocument = { ok: true; document: unknown } | { ok: false; problem: Problem };

/**
 * The most JSON values (objects, arrays, strings, numbers, booleans and nulls) a Manifest may
 * contain outside its top-level `x-` keys. The largest Manifest the format allows has a few
 * hundred. The limit bounds the work and the number of problems for hostile input: the JSON
 * Schema library collects errors with `push(...errors)`, which overflows the call stack once a
 * document yields about a hundred thousand of them.
 */
export const MAX_MANIFEST_VALUES = 2000;

/**
 * Turns validateManifest()'s input into the JSON document the rules check, owned by the
 * validator.
 *
 * - A string is JSON text (a leading byte order mark is ignored).
 * - Bytes (any ArrayBuffer view, e.g. a Uint8Array read from a Harness Package) are UTF-8
 *   JSON text.
 * - Anything else is a JavaScript value and is validated as the JSON that `JSON.stringify` would
 *   produce for it, so `undefined` properties disappear and `toJSON()` is honoured. This also
 *   gives the validator its own copy, so later changes to the caller's object cannot reach the
 *   returned Manifest.
 *
 * Top-level `x-` keys are Publisher-private: they are dropped here, never validated. A document
 * with more than {@link MAX_MANIFEST_VALUES} values in the rest is rejected as a whole, like
 * text that is not JSON.
 */
export function loadDocument(input: unknown): LoadedDocument {
  if (typeof input === 'string') return parseJson(input.replace(/^\uFEFF/, ''));
  if (ArrayBuffer.isView(input)) {
    let text: string;
    try {
      // Strips a UTF-8 byte order mark; `fatal` rejects malformed UTF-8 instead of replacing it.
      const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return invalid('schema_invalid_json', { detail: 'the bytes are not valid UTF-8' });
    }
    return parseJson(text);
  }
  let text: string | undefined;
  try {
    text = stringifyJson(input);
  } catch (error) {
    // Circular structures, BigInt values, or nesting deeper than the call stack allows.
    return invalid('schema_invalid_json.not_serializable', { detail: errorMessage(error) });
  }
  if (text === undefined) {
    return invalid('schema_invalid_json.not_serializable', {
      detail: `${typeof input} has no JSON form`,
    });
  }
  return parseJson(text);
}

function parseJson(text: string): LoadedDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return invalid('schema_invalid_json', { detail: errorMessage(error) });
  }
  const document = withoutPrivateKeys(parsed);
  if (!prepareTree(document)) {
    return invalid('schema_invalid_json.too_large', { limit: MAX_MANIFEST_VALUES });
  }
  return { ok: true, document };
}

function invalid(
  messageKey: 'schema_invalid_json' | `schema_invalid_json.${'not_serializable' | 'too_large'}`,
  params: ProblemParams,
): LoadedDocument {
  return { ok: false, problem: createProblem(messageKey, [], params) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Drops top-level `x-` keys: Publisher-private, ignored by the Store and the Runtime. */
function withoutPrivateKeys(document: unknown): unknown {
  if (!isRecord(document)) return document;
  return Object.fromEntries(Object.entries(document).filter(([key]) => !key.startsWith('x-')));
}

/**
 * Walks the document once, iteratively (so no depth can overflow the stack), and:
 *
 * - counts its values, returning false as soon as there are more than
 *   {@link MAX_MANIFEST_VALUES};
 * - replaces lone UTF-16 surrogates in object keys with U+FFFD, in place. JSON text may encode
 *   them (`"\ud800"`), but no valid key contains one, and the JSON Schema library cannot build a
 *   JSON pointer for such a key. The renamed key is still reported, as an unknown or malformed
 *   key.
 */
function prepareTree(document: unknown): boolean {
  let values = 1;
  const pending: unknown[] = [document];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      values += node.length;
      if (values > MAX_MANIFEST_VALUES) return false;
      for (const item of node as unknown[]) pending.push(item);
    } else if (isRecord(node)) {
      const keys = Object.keys(node);
      values += keys.length;
      if (values > MAX_MANIFEST_VALUES) return false;
      for (const key of keys) {
        const value = node[key];
        if (!key.isWellFormed()) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- renaming a key
          delete node[key];
          Object.defineProperty(node, key.toWellFormed(), {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        pending.push(value);
      }
    }
  }
  return true;
}
