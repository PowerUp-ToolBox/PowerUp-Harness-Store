import type { OutputUnit } from '@cfworker/json-schema';
import { MESSAGES_EN } from './codes.js';
import type { MessageKey } from './codes.js';
import {
  codePointLength,
  createProblem,
  describeActual,
  isRecord,
  markKeyProblem,
  preview,
  truncate,
} from './problem.js';
import type { PathSegment } from './problem.js';
import { resolveSchemaLocation } from './schema.js';
import type { Problem } from './types.js';

/**
 * Keywords that only wrap the errors of their subschemas. The library reports them next to
 * those errors ("Property "x" does not match schema"); the leaf errors carry the finding.
 */
const WRAPPER_KEYWORDS = new Set([
  '$ref',
  'properties',
  'patternProperties',
  'additionalProperties',
  'propertyNames',
  'items',
  'if',
]);

/**
 * Converts the JSON Schema library's errors for `document` into Problems.
 *
 * Only keywords the Manifest schema uses are understood; any other keyword throws, so a schema
 * change that needs a new problem code cannot slip through untranslated (the tests cover this).
 */
export function schemaProblems(errors: readonly OutputUnit[], document: unknown): Problem[] {
  const problems: Problem[] = [];
  errors.forEach((error, index) => {
    if (WRAPPER_KEYWORDS.has(error.keyword)) return;
    if (error.keyword === 'false' && isDeclaredProperty(errors[index - 1], error)) return;
    problems.push(...translate(error, document));
  });
  return problems;
}

/**
 * The library only treats a key as covered by `properties` when its value is valid, so a known
 * key with a bad value is also rejected by `additionalProperties: false`. That value's own
 * problems are already reported; the key itself is not unknown. The library emits each `false`
 * error right after the `additionalProperties` error that caused it, which locates the schema
 * object.
 */
function isDeclaredProperty(wrapper: OutputUnit | undefined, error: OutputUnit): boolean {
  if (wrapper?.keyword !== 'additionalProperties') {
    throw new Error(`A false schema outside additionalProperties at ${error.instanceLocation}`);
  }
  const tokens = decodePointer(wrapper.keywordLocation);
  tokens.pop();
  const { node } = resolveSchemaLocation(tokens);
  const properties = isRecord(node) ? node.properties : undefined;
  const key = decodePointer(error.instanceLocation).at(-1) ?? '';
  return isRecord(properties) && Object.hasOwn(properties, key);
}

function translate(error: OutputUnit, document: unknown): Problem[] {
  const instanceTokens = decodePointer(error.instanceLocation);
  const path = toPathSegments(document, instanceTokens);
  const value = valueAt(document, path);

  // A `false` schema only appears as `additionalProperties: false`: the key is not defined here.
  // (The library reports this keyword's location as the instance location, so it is not used.)
  if (error.keyword === 'false') {
    const key = String(path.at(-1));
    return [
      markKeyProblem(
        createProblem(path.length === 1 ? 'unknown_key' : 'unknown_key.nested', path, { key }),
      ),
    ];
  }

  const keywordTokens = decodePointer(error.keywordLocation);
  const keyword = keywordTokens.pop();
  if (keyword !== error.keyword) {
    throw new Error(`Unexpected keyword location ${error.keywordLocation} for ${error.keyword}`);
  }
  const { node, definition } = resolveSchemaLocation(keywordTokens);
  if (!isRecord(node)) throw new Error(`No schema object at ${error.keywordLocation}`);
  // Under `propertyNames` the instance is the key itself, and `path` ends with that key.
  const isPropertyName = keywordTokens.includes('propertyNames');
  const key = String(path.at(-1));

  switch (error.keyword) {
    case 'required': {
      const required = node.required as string[];
      const object = isRecord(value) ? value : {};
      return required
        .filter((name) => !Object.hasOwn(object, name))
        .map((name) =>
          isSlotsPath(path) && name === 'default'
            ? createProblem('slot_default_missing', [...path, name])
            : createProblem('schema_required', [...path, name], { key: name }),
        );
    }
    case 'type': {
      const expected = ([] as unknown[]).concat(node.type).map(String).join(' or ');
      return [createProblem('schema_type', path, { expected, actual: describeActual(value) })];
    }
    case 'const':
      return [
        createProblem('schema_enum.const', path, {
          allowed: JSON.stringify(node.const),
          actual: preview(value),
        }),
      ];
    case 'enum': {
      const allowed = (node.enum as unknown[]).map((item) => JSON.stringify(item)).join(', ');
      return [
        isPropertyName
          ? markKeyProblem(createProblem('schema_enum.property_name', path, { key, allowed }))
          : createProblem('schema_enum', path, { allowed, actual: preview(value) }),
      ];
    }
    case 'pattern': {
      const subject = isPropertyName ? key : value;
      if (definition === 'semver') {
        return [createProblem('version_invalid', path, { version: truncate(String(subject)) })];
      }
      const specific = `schema_pattern.${definition ?? ''}`;
      const messageKey: MessageKey = Object.hasOwn(MESSAGES_EN, specific)
        ? (specific as MessageKey)
        : 'schema_pattern';
      const params: Record<string, string> = {
        pattern: String(node.pattern),
        actual: preview(subject),
      };
      if (!isPropertyName) return [createProblem(messageKey, path, params)];
      params.key = key;
      return [markKeyProblem(createProblem(messageKey, path, params))];
    }
    case 'minLength':
    case 'maxLength':
      return [
        createProblem(
          error.keyword === 'minLength' ? 'schema_min_length' : 'schema_max_length',
          path,
          {
            limit: Number(node[error.keyword]),
            actual: codePointLength(String(value)),
          },
        ),
      ];
    case 'minItems':
    case 'maxItems':
      return [
        createProblem(
          error.keyword === 'minItems' ? 'schema_min_items' : 'schema_max_items',
          path,
          {
            limit: Number(node[error.keyword]),
            actual: Array.isArray(value) ? value.length : 0,
          },
        ),
      ];
    case 'maxProperties':
      return [
        createProblem('schema_max_properties', path, {
          limit: Number(node.maxProperties),
          actual: isRecord(value) ? Object.keys(value).length : 0,
        }),
      ];
    case 'minimum':
    case 'maximum':
      return [
        createProblem(error.keyword === 'minimum' ? 'schema_minimum' : 'schema_maximum', path, {
          limit: Number(node[error.keyword]),
          actual: Number(value),
        }),
      ];
    default:
      throw new Error(`The Manifest schema uses an untranslated keyword: ${error.keyword}`);
  }
}

function isSlotsPath(path: readonly PathSegment[]): boolean {
  return path.length === 2 && path[0] === 'models' && path[1] === 'slots';
}

/**
 * Splits the library's `#/a/b` locations into unescaped tokens. The library URI-encodes each
 * token after JSON-pointer escaping (`~0`, `~1`), so both are undone here.
 */
function decodePointer(pointer: string): string[] {
  const body = pointer.startsWith('#') ? pointer.slice(1) : pointer;
  if (body === '') return [];
  return body
    .split('/')
    .slice(1)
    .map((token) => decodeURI(token).replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** Pointer tokens to path segments: tokens that index into arrays become numbers. */
function toPathSegments(document: unknown, tokens: readonly string[]): PathSegment[] {
  const segments: PathSegment[] = [];
  let node: unknown = document;
  for (const token of tokens) {
    if (Array.isArray(node)) {
      const index = Number(token);
      segments.push(index);
      node = node[index] as unknown;
    } else {
      segments.push(token);
      node = isRecord(node) && Object.hasOwn(node, token) ? node[token] : undefined;
    }
  }
  return segments;
}

function valueAt(document: unknown, path: readonly PathSegment[]): unknown {
  let node: unknown = document;
  for (const segment of path) {
    if (typeof segment === 'number')
      node = Array.isArray(node) ? (node[segment] as unknown) : undefined;
    else node = isRecord(node) && Object.hasOwn(node, segment) ? node[segment] : undefined;
  }
  return node;
}
