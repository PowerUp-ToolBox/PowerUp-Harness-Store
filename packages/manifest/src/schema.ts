import { Validator } from '@cfworker/json-schema';
import type { OutputUnit } from '@cfworker/json-schema';
import schemaJson from './manifest-v1.schema.json' with { type: 'json' };

/** A JSON Schema document, read-only. */
export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The JSON Schema (draft 2020-12) for `manifest.json`, manifestVersion 1. Point an editor at
 * `@harness-store/manifest/manifest-v1.schema.json` to get validation and completion while
 * writing a Manifest. Frozen: it is shared by every caller.
 */
export const manifestSchema: JsonSchemaDocument = deepFreeze(schemaJson);

let validator: Validator | undefined;

/**
 * Validates a document against {@link manifestSchema}, collecting every error (no short
 * circuit). The library interprets the schema without `eval`/`new Function`, so it runs under a
 * strict Content Security Policy, in Node and in Deno.
 */
export function validateAgainstSchema(document: unknown): OutputUnit[] {
  // The library annotates the schema object it is given, so it gets a private mutable copy.
  validator ??= new Validator(JSON.parse(JSON.stringify(schemaJson)) as object, '2020-12', false);
  return validator.validate(document).errors;
}

export interface ResolvedSchemaNode {
  node: unknown;
  /** Name of the last `$defs` entry the location passed through via `$ref`, if any. */
  definition: string | undefined;
}

/**
 * Follows the keyword tokens of an error's `keywordLocation` (which records each `$ref` it
 * crossed) through {@link manifestSchema} to the schema object the keyword belongs to.
 */
export function resolveSchemaLocation(tokens: readonly string[]): ResolvedSchemaNode {
  let node: unknown = manifestSchema;
  let definition: string | undefined;
  for (const token of tokens) {
    const current = node as Record<string, unknown> | undefined;
    if (token === '$ref' && typeof current?.$ref === 'string') {
      const ref = current.$ref;
      const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
      if (!match?.[1]) throw new Error(`Unsupported $ref in the Manifest schema: ${ref}`);
      definition = match[1];
      node = (manifestSchema.$defs as Record<string, unknown>)[definition];
    } else {
      node = current?.[token];
    }
    if (node === undefined) {
      throw new Error(`Schema location not found: #/${tokens.join('/')}`);
    }
  }
  return { node, definition };
}
