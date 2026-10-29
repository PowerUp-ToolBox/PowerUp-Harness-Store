/**
 * Ticket P0-08.1: what the Publish flow leaves out of a Harness Package. The fixed rules have one
 * home (src/main/runtime/package-exclusions.ts); the reference Harnesses' build and pack scripts
 * keep a standalone copy (examples/<name>/scripts/excluded.mjs), which must agree with it.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exclusionRules, isAlwaysExcluded } from '../../src/main/runtime/package-exclusions.js';

const EXAMPLES = join(import.meta.dirname, '../../../../examples');

/** Paths and whether the fixed rules leave them out. */
const TABLE: readonly (readonly [string, boolean])[] = [
  ['manifest.json', false],
  ['README.md', false],
  ['assets/icon.png', false],
  ['.git', true],
  ['.git/config', true],
  ['vendor/lib/.git', true],
  ['vendor/lib/.git/HEAD', true],
  ['.github/workflows/ci.yml', false],
  ['.gitignore', false],
  ['node_modules/.cache/x.json', true],
  ['packages/a/node_modules/.cache/b/c', true],
  ['node_modules/left-pad/index.js', false],
  ['node_modules/.cache', false],
  ['.DS_Store', true],
  ['assets/.DS_Store', true],
  ['Thumbs.db', true],
  ['docs/Thumbs.db', true],
  ['src/.index.ts.swp', true],
  ['notes.swp', true],
  ['notes.swp.txt', false],
  ['ds_store', false],
];

describe('the fixed exclusion rules', () => {
  it.each(TABLE)('%s → excluded: %s', (path, expected) => {
    expect(isAlwaysExcluded(path)).toBe(expected);
  });

  it.each(['hello-web', 'hello-term'])(
    'examples/%s/scripts/excluded.mjs agrees with the desktop module on every path',
    async (example) => {
      const module = (await import(
        pathToFileURL(join(EXAMPLES, example, 'scripts/excluded.mjs')).href
      )) as { excluded: (path: string) => boolean };
      for (const [path] of TABLE) {
        expect([path, module.excluded(path)]).toEqual([path, isAlwaysExcluded(path)]);
      }
    },
  );
});

describe('.harnessignore', () => {
  it('leaves out what its gitignore patterns match, relative to the folder root', () => {
    const rules = exclusionRules('dist/\n*.log\n/secret.txt\n');
    expect(rules.excludesFolder('dist')).toBe(true);
    expect(rules.excludesFolder('src/dist')).toBe(true);
    expect(rules.excludesFile('debug.log')).toBe(true);
    expect(rules.excludesFile('logs/debug.log')).toBe(true);
    expect(rules.excludesFile('secret.txt')).toBe(true);
    expect(rules.excludesFile('src/secret.txt')).toBe(false);
    expect(rules.excludesFile('dist')).toBe(false);
    expect(rules.excludesFile('manifest.json')).toBe(false);
  });

  it('cannot bring back a fixed exclusion with !, and leaves itself out', () => {
    const rules = exclusionRules('!.DS_Store\n!.git/\n!.harnessignore\n');
    expect(rules.excludesFile('.DS_Store')).toBe(true);
    expect(rules.excludesFolder('.git')).toBe(true);
    expect(rules.excludesFile('.harnessignore')).toBe(true);
  });

  it('! brings back what an earlier pattern of its own left out', () => {
    const rules = exclusionRules('*.log\n!keep.log\n');
    expect(rules.excludesFile('debug.log')).toBe(true);
    expect(rules.excludesFile('keep.log')).toBe(false);
  });

  it('without one, only the fixed rules and the file name itself apply', () => {
    const rules = exclusionRules(null);
    expect(rules.excludesFolder('node_modules/.cache')).toBe(true);
    expect(rules.excludesFolder('node_modules')).toBe(false);
    expect(rules.excludesFile('.harnessignore')).toBe(true);
  });
});
