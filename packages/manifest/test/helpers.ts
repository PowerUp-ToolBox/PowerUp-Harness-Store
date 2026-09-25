import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Problem, ValidateManifestOptions, ValidationResult } from '../src/index.js';

export const packageRoot = fileURLToPath(new URL('..', import.meta.url));
export const fixturesRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));

export interface ExpectedFinding {
  code: string;
  path: string;
}

/** fixtures/<name>/expected.json */
export interface FixtureExpectation {
  description: string;
  options?: ValidateManifestOptions;
  problems: ExpectedFinding[];
  warnings: ExpectedFinding[];
}

export interface Fixture {
  name: string;
  manifestText: string;
  expected: FixtureExpectation;
}

export function fixtureNames(): string[] {
  return readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadFixture(name: string): Fixture {
  const read = (file: string) => readFileSync(`${fixturesRoot}${name}/${file}`, 'utf8');
  return {
    name,
    manifestText: read('manifest.json'),
    expected: JSON.parse(read('expected.json')) as FixtureExpectation,
  };
}

/** The spec's section 8 example as a fresh, mutable object. */
export function minimalManifest(): Record<string, unknown> {
  return JSON.parse(loadFixture('valid-minimal-node').manifestText) as Record<string, unknown>;
}

/** The binary fixture (every optional field, two Slots) as a fresh, mutable object. */
export function binaryManifest(): Record<string, unknown> {
  return JSON.parse(loadFixture('valid-binary-multi-platform').manifestText) as Record<
    string,
    unknown
  >;
}

/** Problems of a result (empty when ok). */
export function problemsOf(result: ValidationResult): Problem[] {
  return result.ok ? [] : result.problems;
}

/** `code@path` strings, sorted, for order-insensitive comparison. */
export function findings(list: readonly (Problem | ExpectedFinding)[]): string[] {
  return list.map(({ code, path }) => `${code}@${path}`).sort();
}
