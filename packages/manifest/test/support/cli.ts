/**
 * Shared by the CLI tests: running `main()` in process, the flags that carry a fixture's
 * options, and a check that a parsed `--json` output has exactly the ValidationResult shape.
 */
import { MESSAGES_EN, PROBLEM_CODES } from '../../src/index.js';
import type { ValidateManifestOptions } from '../../src/index.js';
import { main } from '../../src/node/cli.js';

export interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in this process with `args` (what follows `harness-manifest`). */
export async function runInProcess(args: readonly string[]): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const status = await main(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { status, stdout, stderr };
}

/** The flags that pass a fixture's expected.json `options` to validatePackage(). */
export function optionFlags(options: ValidateManifestOptions | undefined): string[] {
  return [
    ...(options?.publisher === undefined ? [] : ['--publisher', options.publisher]),
    ...(options?.publishedVersions ?? []).flatMap((version) => ['--published-version', version]),
  ];
}

const PROBLEM_KEYS = new Set(['path', 'code', 'message', 'messageKey', 'params']);
const CODES = new Set<string>(Object.values(PROBLEM_CODES));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every way `value` (a parsed `--json` output) differs from the ValidationResult type of P0-01.2:
 * `{ ok: true, manifest, warnings }` or `{ ok: false, problems, warnings }`, with Problems of
 * exactly `{ path, code, message, messageKey, params? }`. Empty when it matches.
 */
export function shapeErrors(value: unknown): string[] {
  if (!isRecord(value)) return ['the result is not an object'];
  const errors: string[] = [];
  const keys = Object.keys(value).sort().join(',');
  if (value.ok === true) {
    if (keys !== 'manifest,ok,warnings') errors.push(`keys of a valid result: ${keys}`);
    if (!isRecord(value.manifest)) errors.push('manifest is not an object');
  } else if (value.ok === false) {
    if (keys !== 'ok,problems,warnings') errors.push(`keys of an invalid result: ${keys}`);
    if (!Array.isArray(value.problems) || value.problems.length === 0) {
      errors.push('an invalid result has no problems');
    }
  } else {
    errors.push('ok is not a boolean');
  }
  if (!Array.isArray(value.warnings)) errors.push('warnings is not a list');
  const findings = [
    ...(Array.isArray(value.problems) ? (value.problems as unknown[]) : []).map(
      (item, index) => [`problems[${String(index)}]`, item] as const,
    ),
    ...(Array.isArray(value.warnings) ? (value.warnings as unknown[]) : []).map(
      (item, index) => [`warnings[${String(index)}]`, item] as const,
    ),
  ];
  for (const [at, finding] of findings) errors.push(...problemErrors(finding, at));
  return errors;
}

function problemErrors(problem: unknown, at: string): string[] {
  if (!isRecord(problem)) return [`${at} is not an object`];
  const errors: string[] = [];
  for (const key of Object.keys(problem)) {
    if (!PROBLEM_KEYS.has(key)) errors.push(`${at} has the extra key ${key}`);
  }
  for (const key of ['path', 'code', 'message', 'messageKey']) {
    if (typeof problem[key] !== 'string') errors.push(`${at}.${key} is not a string`);
  }
  const { code, messageKey, params } = problem;
  if (typeof code === 'string' && !CODES.has(code)) errors.push(`${at}.code ${code} is unknown`);
  if (typeof messageKey === 'string') {
    if (!Object.hasOwn(MESSAGES_EN, messageKey)) errors.push(`${at}.messageKey is unknown`);
    if (messageKey !== code && !messageKey.startsWith(`${String(code)}.`)) {
      errors.push(`${at}.messageKey ${messageKey} is not a variant of ${String(code)}`);
    }
  }
  if (params !== undefined) {
    if (!isRecord(params)) errors.push(`${at}.params is not an object`);
    else {
      for (const [key, param] of Object.entries(params)) {
        if (typeof param !== 'string' && typeof param !== 'number') {
          errors.push(`${at}.params.${key} is neither a string nor a number`);
        }
      }
    }
  }
  return errors;
}
