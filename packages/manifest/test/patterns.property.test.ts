/**
 * Property tests for the Harness ID and Model Slot name rules (P0-01 spec, Testing Decisions):
 * for arbitrary strings, validateManifest agrees with a straightforward, regex-free reading of
 * docs/tech/manifest-spec.md.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/index.js';
import { minimalManifest, problemsOf } from './helpers.js';

const isLowerAlnum = (char: string) => (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
const isLowerAlnumOrHyphen = (char: string) => isLowerAlnum(char) || char === '-';

/**
 * `publisher/slug`. publisher: a GitHub login in lower case (1 to 39 characters, letters, digits
 * and hyphens, starting with a letter or digit). slug: `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`.
 */
function isHarnessId(id: string): boolean {
  const parts = id.split('/');
  if (parts.length !== 2) return false;
  const [publisher = '', slug = ''] = parts;
  const publisherChars = Array.from(publisher);
  const slugChars = Array.from(slug);
  return (
    publisherChars.length >= 1 &&
    publisherChars.length <= 39 &&
    isLowerAlnum(publisherChars[0] ?? '') &&
    publisherChars.every(isLowerAlnumOrHyphen) &&
    slugChars.length >= 3 &&
    slugChars.length <= 40 &&
    isLowerAlnum(slugChars[0] ?? '') &&
    isLowerAlnum(slugChars.at(-1) ?? '') &&
    slugChars.every(isLowerAlnumOrHyphen)
  );
}

/** `^[a-z][a-z0-9-]{0,31}$` */
function isSlotName(name: string): boolean {
  const chars = Array.from(name);
  const first = chars[0] ?? '';
  return (
    chars.length >= 1 &&
    chars.length <= 32 &&
    first >= 'a' &&
    first <= 'z' &&
    chars.every(isLowerAlnumOrHyphen)
  );
}

/** Strings that often land near the rules' edges, plus fully arbitrary ones. */
function candidates(extraChars: string[]): fc.Arbitrary<string> {
  const near = fc
    .array(fc.constantFrom('a', 'z', 'm', '0', '9', '-', ...extraChars), { maxLength: 45 })
    .map((chars) => chars.join(''));
  return fc.oneof(
    near,
    fc.string({ maxLength: 45 }),
    fc.string({ unit: 'grapheme', maxLength: 10 }),
  );
}

describe('Harness ID', () => {
  it('is accepted exactly when it is publisher/slug as the spec defines it', () => {
    const ids = fc.oneof(
      candidates(['/', 'A', '_', '.', ' ']),
      fc
        .tuple(candidates(['A', '_']), candidates(['A', '.']))
        .map(([publisher, slug]) => `${publisher}/${slug}`),
    );
    fc.assert(
      fc.property(ids, (id) => {
        const problems = problemsOf(validateManifest({ ...minimalManifest(), id }));
        const idProblems = problems.filter((problem) => problem.path === 'id');
        expect(idProblems.length === 0).toBe(isHarnessId(id));
        expect(problems).toEqual(idProblems);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('Model Slot names', () => {
  it('are accepted exactly when they match the spec, and never break other rules', () => {
    const names = candidates(['A', '_', '.', ' ', '/']).filter((name) => name !== 'default');
    fc.assert(
      fc.property(names, (name) => {
        const manifest = minimalManifest();
        manifest.models = { slots: { default: {}, [name]: { description: 'extra' } } };
        const problems = problemsOf(validateManifest(manifest));
        expect(problems.length === 0).toBe(isSlotName(name));
        for (const problem of problems) {
          expect(problem).toMatchObject({ code: 'schema_pattern', params: { key: name } });
        }
      }),
      { numRuns: 2000 },
    );
  });
});
