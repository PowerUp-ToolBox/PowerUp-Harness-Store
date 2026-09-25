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
 * `JSON.stringify`, typed honestly: it returns undefined for `undefined`, functions and symbols
 * (the standard library declares `string`).
 */
export const stringifyJson: (value: unknown) => string | undefined = JSON.stringify;

/** A short JSON rendering of a value for messages: strings keep their quotes. */
export function preview(value: unknown): string {
  return truncate(stringifyJson(value) ?? String(value));
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

/** Removes Problems that repeat an earlier Problem's path and code, keeping the first. */
export function dedupe(problems: readonly Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = `${problem.path}\u0000${problem.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
