import fc from 'fast-check';
import { binaryManifest, minimalManifest } from './helpers.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Every path (as key/index lists) to a value inside a JSON document, root excluded. */
function pathsOf(value: Json, prefix: (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => [
      [...prefix, index],
      ...pathsOf(item, [...prefix, index]),
    ]);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [
      [...prefix, key],
      ...pathsOf(item, [...prefix, key]),
    ]);
  }
  return [];
}

const DELETE = Symbol('delete');

/** Sets (or deletes) the value at `path`, creating nothing new along the way. */
function apply(document: Json, path: (string | number)[], value: Json | typeof DELETE): void {
  let node: Json = document;
  for (const segment of path.slice(0, -1)) {
    node = (node as Record<string | number, Json>)[segment] as Json;
  }
  const last = path.at(-1);
  if (last === undefined) return;
  const container = node as Record<string | number, Json>;
  if (value === DELETE) {
    if (Array.isArray(container)) container.splice(last as number, 1);
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test mutation
    else delete container[last];
  } else {
    container[last] = value;
  }
}

/**
 * Valid Manifests with one to three random edits: a value replaced by arbitrary JSON, a key
 * deleted, or a random key added. Used to fuzz the validator's invariants.
 */
export function mutatedManifest(): fc.Arbitrary<Json> {
  const base = fc.constantFrom(minimalManifest(), binaryManifest()) as fc.Arbitrary<Json>;
  return base.chain((original) => {
    const paths = pathsOf(original);
    const edit = fc.oneof(
      fc.tuple(fc.constantFrom(...paths), fc.jsonValue() as fc.Arbitrary<Json>),
      fc.tuple(fc.constantFrom(...paths), fc.constant(DELETE)),
      fc.tuple(
        fc.constantFrom(...paths.filter((path) => path.length < 3)),
        fc.string({ maxLength: 12 }),
        fc.jsonValue() as fc.Arbitrary<Json>,
      ),
    );
    return fc.array(edit, { minLength: 1, maxLength: 3 }).map((edits) => {
      const document = structuredClone(original);
      for (const change of edits) {
        try {
          if (change.length === 3) {
            const [path, key, value] = change;
            apply(document, [...path.slice(0, -1), key], value);
          } else {
            apply(document, change[0], change[1]);
          }
        } catch {
          // An earlier edit removed this path; skip the edit.
        }
      }
      return document;
    });
  });
}
