import { createProblem, isRecord, stringifyJson } from './problem.js';
import type { Problem } from './types.js';

export type LoadedDocument = { ok: true; document: unknown } | { ok: false; problem: Problem };

/**
 * Turns validateManifest()'s input into a JSON document the validator owns.
 *
 * - A string is JSON text (a leading byte order mark is ignored).
 * - Bytes (any ArrayBuffer view, e.g. a Uint8Array read from a Harness Package) are UTF-8
 *   JSON text.
 * - Anything else is a JavaScript value and is validated as the JSON that `JSON.stringify` would
 *   produce for it, so `undefined` properties disappear and `toJSON()` is honoured. This also
 *   gives the validator its own copy, so later changes to the caller's object cannot reach the
 *   returned Manifest.
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
      return invalid('schema_invalid_json', 'the bytes are not valid UTF-8');
    }
    return parseJson(text);
  }
  let text: string | undefined;
  try {
    text = stringifyJson(input);
  } catch (error) {
    // Circular structures, BigInt values, or nesting deeper than the call stack allows.
    return invalid('schema_invalid_json.not_serializable', errorMessage(error));
  }
  if (text === undefined) {
    return invalid('schema_invalid_json.not_serializable', `${typeof input} has no JSON form`);
  }
  return parseJson(text);
}

function parseJson(text: string): LoadedDocument {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return invalid('schema_invalid_json', errorMessage(error));
  }
  replaceIllFormedKeys(document);
  return { ok: true, document };
}

function invalid(
  messageKey: 'schema_invalid_json' | 'schema_invalid_json.not_serializable',
  detail: string,
): LoadedDocument {
  return { ok: false, problem: createProblem(messageKey, [], { detail }) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Replaces lone UTF-16 surrogates in object keys with U+FFFD, in place. JSON text may encode
 * them (`"\ud800"`), but no valid key contains one, and the JSON Schema library cannot build a
 * JSON pointer for such a key. The renamed key is still reported, as an unknown or malformed
 * key. Iterative, so arbitrarily deep documents cannot overflow the stack.
 */
function replaceIllFormedKeys(document: unknown): void {
  const pending: unknown[] = [document];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      // A loop, not push(...node): spreading a huge array would exceed the argument limit.
      for (const item of node as unknown[]) pending.push(item);
    } else if (isRecord(node)) {
      for (const key of Object.keys(node)) {
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
}
