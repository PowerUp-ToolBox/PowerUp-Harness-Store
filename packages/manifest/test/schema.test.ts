import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MESSAGES_EN, manifestSchema, validateManifest } from '../src/index.js';
import schemaFile from '../src/manifest-v1.schema.json' with { type: 'json' };
import { minimalManifest, packageRoot } from './helpers.js';

type SchemaObject = Record<string, unknown>;
const schema = manifestSchema as SchemaObject;
const defs = schema.$defs as Record<string, SchemaObject>;

/** Keywords whose value is a subschema, a list of subschemas or a map of subschemas. */
const SUBSCHEMA = ['items', 'additionalProperties', 'propertyNames', 'if', 'then'];
const SUBSCHEMA_MAP = ['properties', 'patternProperties', '$defs'];

/** Every subschema with its JSON pointer inside the schema. */
function walk(node: unknown, pointer = '#'): [string, unknown][] {
  const found: [string, unknown][] = [[pointer, node]];
  if (typeof node !== 'object' || node === null) return found;
  const object = node as SchemaObject;
  for (const keyword of SUBSCHEMA) {
    if (keyword in object) found.push(...walk(object[keyword], `${pointer}/${keyword}`));
  }
  for (const keyword of SUBSCHEMA_MAP) {
    for (const [name, child] of Object.entries((object[keyword] ?? {}) as SchemaObject)) {
      found.push(...walk(child, `${pointer}/${keyword}/${name}`));
    }
  }
  return found;
}

const subschemas = walk(schema);
const objects = subschemas.filter(
  (entry): entry is [string, SchemaObject] => typeof entry[1] === 'object' && entry[1] !== null,
);

describe('manifestSchema', () => {
  it('is JSON Schema draft 2020-12 with an $id, and is the published JSON file', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toMatch(/^https:\/\/.+manifest-v1\.schema\.json$/);
    expect(manifestSchema).toEqual(schemaFile);
  });

  it('pins manifestVersion to the literal 1', () => {
    expect((schema.properties as Record<string, SchemaObject>).manifestVersion?.const).toBe(1);
  });

  it('is deeply frozen, so no caller can change the rules for everyone else', () => {
    expect(Object.isFrozen(manifestSchema)).toBe(true);
    expect(Object.isFrozen(defs.platform?.enum)).toBe(true);
    expect(() => {
      (defs.platform?.enum as string[]).push('amiga-m68k');
    }).toThrow(TypeError);
    expect(validateManifest(minimalManifest()).ok).toBe(true);
  });

  it('uses only keywords the problem translator understands', () => {
    const supported = new Set([
      '$schema',
      '$id',
      '$defs',
      '$ref',
      'title',
      'description',
      'default',
      'type',
      'const',
      'enum',
      'required',
      'properties',
      'patternProperties',
      'additionalProperties',
      'propertyNames',
      'items',
      'if',
      'then',
      'pattern',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'maxProperties',
      'minimum',
      'maximum',
    ]);
    for (const [pointer, node] of objects) {
      for (const keyword of Object.keys(node)) {
        expect(supported.has(keyword), `${keyword} at ${pointer}`).toBe(true);
      }
    }
  });

  it('does not use uniqueItems (quadratic on untrusted input; checked in linear time instead)', () => {
    expect(JSON.stringify(schema)).not.toContain('uniqueItems');
  });

  it('only uses a false subschema as additionalProperties', () => {
    for (const [pointer, node] of subschemas) {
      if (node === false) expect(pointer).toMatch(/\/additionalProperties$/);
    }
  });

  it('closes every object: unknown keys are rejected at every level', () => {
    for (const [pointer, node] of objects) {
      if (node.type === 'object') {
        expect(node.additionalProperties !== undefined, pointer).toBe(true);
      }
    }
  });

  it('keeps every pattern in a named $defs entry that has its own message', () => {
    for (const [pointer, node] of objects) {
      if (!('pattern' in node)) continue;
      const match = /^#\/\$defs\/([^/]+)$/.exec(pointer);
      expect(match, `pattern at ${pointer}`).not.toBeNull();
      const name = match?.[1] ?? '';
      if (name === 'semver') continue; // reported as version_invalid
      expect(Object.keys(MESSAGES_EN)).toContain(`schema_pattern.${name}`);
    }
  });
});

describe('manifestSchema agrees with docs/tech/manifest-spec.md', () => {
  const spec = readFileSync(`${packageRoot}../../docs/tech/manifest-spec.md`, 'utf8');
  const row = (field: string) =>
    spec.split('\n').find((line) => line.startsWith(`| \`${field}\` |`)) ?? '';
  const backticked = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

  it('lists the same curated tags', () => {
    expect(backticked(row('tags')).slice(1)).toEqual(defs.tag?.enum);
  });

  it('lists the same platforms', () => {
    expect(backticked(row('platforms')).slice(1)).toEqual(defs.platform?.enum);
  });

  it('uses the same slug pattern inside the Harness ID pattern', () => {
    const slug = backticked(row('id')).find((text) => text?.startsWith('^')) ?? '';
    expect(slug).not.toBe('');
    expect(String(defs.harnessId?.pattern).endsWith(`/${slug.slice(1)}`)).toBe(true);
  });

  it('uses the same Model Slot name pattern', () => {
    const line = spec.split('\n').find((text) => text.startsWith('- Slot names:')) ?? '';
    expect(backticked(line)[0]).toBe(defs.slotName?.pattern);
  });
});
