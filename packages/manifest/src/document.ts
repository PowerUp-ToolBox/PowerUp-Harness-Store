import type { ProblemParams } from './codes.js';
import { createProblem, describeActual, isRecord, stringifyJson } from './problem.js';
import type { PathSegment } from './problem.js';
import type { Problem } from './types.js';

export type LoadedDocument =
  | {
      ok: true;
      document: unknown;
      /** Problems found while loading that do not stop the other rules (non-finite numbers). */
      problems: Problem[];
    }
  | { ok: false; problem: Problem };

/**
 * The most JSON values (objects, arrays, strings, numbers, booleans and nulls) a Manifest may
 * contain outside its top-level `x-` and `$schema` keys. Every list and map in the schema has a
 * maximum size, so the largest valid Manifest has fewer than 200 values (a test computes the
 * bound from the schema); this limit is ten times that. It bounds the work and the number of
 * problems for hostile input: the JSON Schema library collects errors with `push(...errors)`,
 * which overflows the call stack once a document yields about a hundred thousand of them.
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
 * Top-level `x-` keys (Publisher-private) and `$schema` (which schema an editor should use) are
 * dropped here, never validated. A document with more than {@link MAX_MANIFEST_VALUES} values
 * in the rest is rejected as a whole, like text that is not JSON. A number too large for a double (`1e400` parses as `Infinity`) is a
 * `schema_type` problem at its path, returned with the document: it has no JSON form, so a
 * Manifest holding one could not be stored or read back.
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
  const nonFinite = prepareTree(document);
  if (nonFinite === undefined) {
    return invalid('schema_invalid_json.too_large', { limit: MAX_MANIFEST_VALUES });
  }
  const problems = nonFinite.map(({ path, value }) =>
    createProblem('schema_type.non_finite', path, { actual: describeActual(value) }),
  );
  return { ok: true, document, problems };
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

/**
 * Drops top-level `x-` keys (Publisher-private) and `$schema` (for editors): the Store and the
 * Runtime ignore both.
 */
function withoutPrivateKeys(document: unknown): unknown {
  if (!isRecord(document)) return document;
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => !key.startsWith('x-') && key !== '$schema'),
  );
}

/** A value met while walking the document, with the way back to the root for its path. */
interface Visit {
  value: unknown;
  key: PathSegment | undefined;
  parent: Visit | undefined;
}

function pathOf(visit: Visit): PathSegment[] {
  const path: PathSegment[] = [];
  for (let at: Visit | undefined = visit; at?.key !== undefined; at = at.parent) {
    path.push(at.key);
  }
  return path.reverse();
}

/**
 * Walks the document once, iteratively (so no depth can overflow the stack), and:
 *
 * - counts its values, returning undefined as soon as there are more than
 *   {@link MAX_MANIFEST_VALUES};
 * - collects numbers that are not finite. `JSON.parse` turns a numeral beyond the double range
 *   into `Infinity` or `-Infinity`, which the JSON Schema library accepts as an integer and
 *   `JSON.stringify` writes as `null`;
 * - replaces lone UTF-16 surrogates in object keys with U+FFFD, in place. JSON text may encode
 *   them (`"\ud800"`), but no valid key contains one, and the JSON Schema library cannot build a
 *   JSON pointer for such a key. The renamed key is still reported, as an unknown or malformed
 *   key.
 */
function prepareTree(document: unknown): { path: PathSegment[]; value: number }[] | undefined {
  const nonFinite: { path: PathSegment[]; value: number }[] = [];
  let values = 1;
  const pending: Visit[] = [{ value: document, key: undefined, parent: undefined }];
  for (let visit = pending.pop(); visit !== undefined; visit = pending.pop()) {
    const node = visit.value;
    if (typeof node === 'number' && !Number.isFinite(node)) {
      nonFinite.push({ path: pathOf(visit), value: node });
    } else if (Array.isArray(node)) {
      values += node.length;
      if (values > MAX_MANIFEST_VALUES) return undefined;
      // Pushed in reverse, so items are visited (and problems listed) in document order.
      for (let index = node.length - 1; index >= 0; index--) {
        pending.push({ value: node[index] as unknown, key: index, parent: visit });
      }
    } else if (isRecord(node)) {
      const keys = Object.keys(node);
      values += keys.length;
      if (values > MAX_MANIFEST_VALUES) return undefined;
      const children: Visit[] = [];
      for (const key of keys) {
        const value = node[key];
        let wellFormedKey = key;
        if (!key.isWellFormed()) {
          wellFormedKey = key.toWellFormed();
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- renaming a key
          delete node[key];
          Object.defineProperty(node, wellFormedKey, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        children.push({ value, key: wellFormedKey, parent: visit });
      }
      for (const child of children.reverse()) pending.push(child);
    }
  }
  return nonFinite;
}
