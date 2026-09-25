import { codeOfMessageKey, interpolate, MESSAGES_EN } from './codes.js';
import type { MessageKey, ProblemParams } from './codes.js';
import type { Problem } from './types.js';

/** One step into a JSON document: an object key or an array index. */
export type PathSegment = string | number;

/** Keys written without brackets in a path: `models.slots.fast`, `entry.win32-x64`. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Formats a JSON location for people: `models.slots.default`, `platforms[1]`, `["a.b"]`.
 * The Manifest root itself is `$`.
 */
export function formatPath(segments: readonly PathSegment[]): string {
  if (segments.length === 0) return '$';
  let path = '';
  for (const segment of segments) {
    if (typeof segment === 'number') path += `[${String(segment)}]`;
    else if (BARE_KEY.test(segment)) path += path === '' ? segment : `.${segment}`;
    else path += `[${JSON.stringify(segment)}]`;
  }
  return path;
}

export function createProblem(
  messageKey: MessageKey,
  path: readonly PathSegment[],
  params?: ProblemParams,
): Problem {
  const problem: Problem = {
    path: formatPath(path),
    code: codeOfMessageKey(messageKey),
    message: interpolate(MESSAGES_EN[messageKey], params),
    messageKey,
  };
  if (params !== undefined && Object.keys(params).length > 0) problem.params = params;
  return problem;
}

const PREVIEW_LENGTH = 60;

/**
 * How much JSON text {@link preview} renders before it stops, in UTF-16 code units. Two code
 * units per code point at most, so this always exceeds {@link PREVIEW_LENGTH} code points and
 * a value cut short still ends in `…`.
 */
const PREVIEW_UNITS = 4 * PREVIEW_LENGTH;

/**
 * `JSON.stringify`, typed honestly: it returns undefined for `undefined`, functions and symbols
 * (the standard library declares `string`).
 */
export const stringifyJson: (value: unknown) => string | undefined = JSON.stringify;

/**
 * A short JSON rendering of a value for messages: strings keep their quotes, and anything past
 * {@link PREVIEW_LENGTH} code points is cut and ends in `…`. For JSON values the result is
 * `JSON.stringify` cut to that length, but the work is bounded by the length too: a value from an
 * untrusted Manifest may be nested thousands of levels deep (which overflows the call stack of
 * `JSON.stringify`) or hold millions of items.
 */
export function preview(value: unknown): string {
  let out = '';
  const write = (node: unknown): void => {
    if (out.length > PREVIEW_UNITS) return;
    if (typeof node === 'string') {
      out += stringifyJson(clip(node)) ?? '';
    } else if (Array.isArray(node)) {
      out += '[';
      for (let index = 0; index < node.length && out.length <= PREVIEW_UNITS; index++) {
        if (index > 0) out += ',';
        const item: unknown = node[index];
        write(hasJsonForm(item) ? item : null);
      }
      out += ']';
    } else if (isRecord(node)) {
      out += '{';
      let first = true;
      for (const key of Object.keys(node)) {
        if (out.length > PREVIEW_UNITS) break;
        if (!hasJsonForm(node[key])) continue;
        out += `${first ? '' : ','}${stringifyJson(clip(key)) ?? ''}:`;
        first = false;
        write(node[key]);
      }
      out += '}';
    } else if (typeof node === 'number' || typeof node === 'boolean' || node === null) {
      out += String(stringifyJson(node));
    } else if (typeof node === 'bigint' || typeof node === 'symbol') {
      // Not JSON: only `options` from a careless caller can hold these, or the two below.
      out += clip(node.toString());
    } else {
      out += typeof node; // `undefined` or `function`
    }
  };
  write(value);
  return truncate(out);
}

/** False for what `JSON.stringify` skips in objects and writes as `null` in arrays. */
function hasJsonForm(value: unknown): boolean {
  return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';
}

/**
 * The first {@link PREVIEW_LENGTH} + 1 code points of `text`: enough to render its preview and
 * to know whether it was cut.
 */
function clip(text: string): string {
  if (text.length <= PREVIEW_LENGTH) return text;
  let out = '';
  let length = 0;
  for (const char of text) {
    if (length > PREVIEW_LENGTH) break;
    out += char;
    length++;
  }
  return out;
}

/** Length in Unicode code points, as JSON Schema's minLength and maxLength count it. */
export function codePointLength(text: string): number {
  let length = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- counting, not reading
  for (const _ of text) length++;
  return length;
}

/** Cuts text at {@link PREVIEW_LENGTH} code points (never inside a surrogate pair). */
export function truncate(text: string): string {
  let out = '';
  let length = 0;
  for (const char of text) {
    if (length === PREVIEW_LENGTH) return `${out}…`;
    out += char;
    length++;
  }
  return out;
}

/** The JSON type name of a value, as JSON Schema's `type` keyword spells it. */
export function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** `actual` param for type problems: the type, plus the value itself for scalars. */
export function describeActual(value: unknown): string {
  const type = jsonTypeOf(value);
  return type === 'object' || type === 'array' || type === 'null'
    ? type
    : `${type} ${preview(value)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Problems about an object key rather than its value (a Model Slot name that breaks the pattern,
 * an `entry` key that is not a platform). They share the path of the value under that key but are
 * independent findings: a value of the wrong type does not make a bad key name good.
 */
const keyProblems = new WeakSet<Problem>();

export function markKeyProblem(problem: Problem): Problem {
  keyProblems.add(problem);
  return problem;
}

export function isKeyProblem(problem: Problem): boolean {
  return keyProblems.has(problem);
}

/**
 * Removes Problems that repeat an earlier Problem's path and code (about the same key, or the
 * same value), keeping the first.
 */
export function dedupe(problems: readonly Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.path}\u0000${problem.code}\u0000${String(isKeyProblem(problem))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
