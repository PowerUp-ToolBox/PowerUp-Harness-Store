/**
 * The acceptance criteria of ticket P0-01.2 (#31), one test each, in the ticket's order.
 */
import { readdirSync, readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { interpolate, MESSAGES_EN, PROBLEM_CODES, validateManifest } from '../src/index.js';
import type { MessageKey, Problem } from '../src/index.js';
import {
  binaryManifest,
  findings,
  fixtureNames,
  loadFixture,
  minimalManifest,
  packageRoot,
  problemsOf,
} from './helpers.js';
import { mutatedManifest } from './mutations.js';

describe('P0-01.2 acceptance criteria', () => {
  it('1. the minimal node example from manifest-spec.md section 8 is ok, typed, with no warnings', () => {
    const example = minimalManifest();
    expect(validateManifest(example)).toEqual({ ok: true, manifest: example, warnings: [] });
    expect(validateManifest(loadFixture('valid-minimal-node').manifestText)).toEqual({
      ok: true,
      manifest: example,
      warnings: [],
    });
  });

  it('2. a missing default Slot is reported, and every other independent rule still runs', () => {
    const manifest = minimalManifest();
    manifest.models = { slots: { fast: {} } };
    delete manifest.summary;
    manifest.tags = ['fun', 'fun'];

    const problems = problemsOf(validateManifest(manifest));

    expect(findings(problems)).toEqual(
      findings([
        { code: 'slot_default_missing', path: 'models.slots.default' },
        { code: 'schema_required', path: 'summary' },
        { code: 'schema_unique_items', path: 'tags[1]' },
      ]),
    );
  });

  it('3. an unknown top-level key is rejected at its path; an x- key produces no problem', () => {
    const withFoo = { ...minimalManifest(), foo: 'bar' };
    expect(findings(problemsOf(validateManifest(withFoo)))).toEqual(['unknown_key@foo']);

    const withPrivate = { ...minimalManifest(), 'x-internal': { anything: [1, 2, 3] } };
    const result = validateManifest(withPrivate);
    expect(result).toEqual({ ok: true, manifest: minimalManifest(), warnings: [] });
  });

  it('4. a binary Harness missing an entry for a declared platform names that platform', () => {
    const manifest = binaryManifest();
    manifest.platforms = ['darwin-arm64', 'win32-x64'];
    manifest.entry = { 'darwin-arm64': 'bin/mac-arm64/reviewer' };

    const problems = problemsOf(validateManifest(manifest));

    expect(problems).toEqual([
      expect.objectContaining({
        code: 'entry_missing_for_platform',
        path: 'entry.win32-x64',
        params: { platform: 'win32-x64' },
      }),
    ]);
    expect(problems[0]?.message).toContain('win32-x64');
  });

  it('5. options.publisher "alice" with id "bob/foo" is a publisher_mismatch', () => {
    const manifest = { ...minimalManifest(), id: 'bob/foo' };
    expect(findings(problemsOf(validateManifest(manifest, { publisher: 'alice' })))).toEqual([
      'publisher_mismatch@id',
    ]);
    expect(validateManifest(manifest).ok).toBe(true);
    expect(validateManifest(manifest, { publisher: 'bob' }).ok).toBe(true);
  });

  it('6. version must be strictly greater than every entry of options.publishedVersions', () => {
    const options = { publishedVersions: ['1.2.0'] };
    const older = { ...minimalManifest(), version: '1.1.0' };
    const newer = { ...minimalManifest(), version: '1.3.0' };

    expect(findings(problemsOf(validateManifest(older, options)))).toEqual([
      'version_not_greater@version',
    ]);
    expect(validateManifest(newer, options)).toMatchObject({ ok: true, warnings: [] });
  });

  describe('7. every problem and warning has a non-empty path, code, message and messageKey', () => {
    const check = (list: readonly Problem[]) => {
      for (const finding of list) {
        for (const field of ['path', 'code', 'message', 'messageKey'] as const) {
          expect(typeof finding[field], `${field} of ${JSON.stringify(finding)}`).toBe('string');
          expect(finding[field].trim(), `${field} of ${JSON.stringify(finding)}`).not.toBe('');
        }
        expect(Object.values(PROBLEM_CODES)).toContain(finding.code);
        expect(Object.keys(MESSAGES_EN)).toContain(finding.messageKey);
        // The message is its English template filled from params, with no placeholder left
        // unfilled (user data such as a key named "{0}" may of course contain braces).
        const template = MESSAGES_EN[finding.messageKey as MessageKey];
        for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
          expect(
            finding.params,
            `${finding.messageKey} needs params.${String(name)}`,
          ).toHaveProperty(String(name));
        }
        expect(finding.message).toBe(interpolate(template, finding.params));
      }
    };

    it.each(fixtureNames())('in fixtures/%s', (name) => {
      const { manifestText, expected } = loadFixture(name);
      const result = validateManifest(manifestText, expected.options);
      check(problemsOf(result));
      check(result.warnings);
    });

    it('for arbitrary JSON input', () => {
      fc.assert(
        fc.property(fc.jsonValue(), (value) => {
          const result = validateManifest(value);
          check(problemsOf(result));
          check(result.warnings);
        }),
        { numRuns: 300 },
      );
    });

    it('for random mutations of valid Manifests', () => {
      fc.assert(
        fc.property(mutatedManifest(), (manifest) => {
          const result = validateManifest(manifest);
          check(problemsOf(result));
          check(result.warnings);
        }),
        { numRuns: 1000 },
      );
    });
  });

  it('8. validateManifest imports no fs and no network code and uses no Node-only globals', () => {
    // The whole pure entry point is covered, not just one file. The browser bundle test proves
    // the same at run time, in a sandbox that has no Node globals at all.
    const sources = readdirSync(`${packageRoot}src`).filter((file) => file.endsWith('.ts'));
    expect(sources).toContain('validate-manifest.ts');
    for (const file of sources) {
      const code = readFileSync(`${packageRoot}src/${file}`, 'utf8');
      expect(code, file).not.toMatch(/from ['"](node:|fs|path|os|http|https|net|child_process)/);
      expect(code, file).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|require)\s*\(/);
      expect(code, file).not.toMatch(/\b(process|Buffer|__dirname|__filename|global)\s*[.[]/);
    }
  });
});
