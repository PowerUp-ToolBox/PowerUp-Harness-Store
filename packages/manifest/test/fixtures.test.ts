import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROBLEM_CODES, validateManifest } from '../src/index.js';
import { findings, fixtureNames, fixturesRoot, loadFixture, problemsOf } from './helpers.js';

const names = fixtureNames();

describe('fixtures/', () => {
  it('has a folder named after every problem code (P0-01 spec, story 21)', () => {
    for (const code of Object.values(PROBLEM_CODES)) {
      expect(names, `fixtures/${code}/ is missing`).toContain(code);
    }
  });

  it('has the valid fixtures other packages rely on', () => {
    expect(names).toEqual(
      expect.arrayContaining(['valid-minimal-node', 'valid-binary-multi-platform']),
    );
  });

  it.each(names)('%s has a manifest.json and an expected.json', (name) => {
    expect(existsSync(`${fixturesRoot}${name}/manifest.json`)).toBe(true);
    expect(existsSync(`${fixturesRoot}${name}/expected.json`)).toBe(true);
    const { expected } = loadFixture(name);
    expect(expected.description.length).toBeGreaterThan(10);
  });

  it.each(names.filter((name) => (Object.values(PROBLEM_CODES) as string[]).includes(name)))(
    '%s/ produces the code it is named after',
    (name) => {
      const { expected } = loadFixture(name);
      const codes = [...expected.problems, ...expected.warnings].map((finding) => finding.code);
      expect(codes).toContain(name);
    },
  );
});

describe.each(names)('validateManifest(fixtures/%s/manifest.json)', (name) => {
  const { manifestText, expected } = loadFixture(name);
  const result = validateManifest(manifestText, expected.options);

  it('produces exactly the problems in expected.json, in any order', () => {
    expect(findings(problemsOf(result))).toEqual(findings(expected.problems));
  });

  it('produces exactly the warnings in expected.json, in any order', () => {
    expect(findings(result.warnings)).toEqual(findings(expected.warnings));
  });

  it('is ok exactly when no problems are expected', () => {
    expect(result.ok).toBe(expected.problems.length === 0);
  });

  it('gives the same answer for the text, its UTF-8 bytes and the parsed value', () => {
    const bytes = new TextEncoder().encode(manifestText);
    expect(validateManifest(bytes, expected.options)).toEqual(result);
    if (expected.problems.some((problem) => problem.code === 'schema_invalid_json')) return;
    expect(validateManifest(JSON.parse(manifestText), expected.options)).toEqual(result);
  });
});
