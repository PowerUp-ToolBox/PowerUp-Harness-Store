import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Problem, ValidateManifestOptions, ValidationResult } from '../src/index.js';

export const packageRoot = fileURLToPath(new URL('..', import.meta.url));
export const fixturesRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));

export interface ExpectedFinding {
  code: string;
  path: string;
}

export interface ExpectedFindings {
  problems: ExpectedFinding[];
  warnings: ExpectedFinding[];
}

/**
 * How test/support/packages.ts turns a fixture folder into a hostile archive, for the failure
 * classes a folder cannot hold (or git cannot keep).
 */
export interface ArchiveRecipe {
  /** Entries added to the zip as they are, such as `../escape.txt`. */
  addEntries?: { name: string; text: string }[];
  /** Symbolic links added to the zip (Unix mode S_IFLNK, the target as content). */
  symlinks?: { name: string; target: string }[];
  /** This many empty files added under `filler/`. */
  fillerFiles?: number;
  /** The zip starts this many bytes into the file (a sparse file of zeros before it). */
  offsetBytes?: number;
  /** This many bytes cut off the end of the zip. */
  truncateBytes?: number;
}

/**
 * fixtures/<name>/expected.json. Each fixture folder is a whole Harness Package; `problems` and
 * `warnings` are what validatePackage() finds in it, as a folder, as a zip of the folder and as
 * files in memory alike (and what the CLI prints).
 */
export interface FixtureExpectation extends ExpectedFindings {
  description: string;
  options?: ValidateManifestOptions;
  /** What validateManifest() finds in manifest.json alone, when that differs. */
  manifest?: ExpectedFindings;
  /** A hostile archive built from the folder, and what validatePackage() finds in it. */
  archive?: ExpectedFindings & { recipe: ArchiveRecipe };
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

/** What validateManifest() must find in a fixture's manifest.json. */
export function manifestExpectation(expected: FixtureExpectation): ExpectedFindings {
  return expected.manifest ?? { problems: expected.problems, warnings: expected.warnings };
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
