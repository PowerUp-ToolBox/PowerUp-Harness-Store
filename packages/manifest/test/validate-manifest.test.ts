import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/index.js';
import { findings, loadFixture, minimalManifest, problemsOf } from './helpers.js';

const minimalText = loadFixture('valid-minimal-node').manifestText;

describe('input forms', () => {
  it('accepts JSON text, with or without a byte order mark', () => {
    expect(validateManifest(minimalText).ok).toBe(true);
    expect(validateManifest(`\uFEFF${minimalText}`).ok).toBe(true);
  });

  it('accepts UTF-8 bytes from any ArrayBuffer view, with or without a byte order mark', () => {
    const bytes = new TextEncoder().encode(minimalText);
    expect(validateManifest(bytes).ok).toBe(true);
    expect(validateManifest(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])).ok).toBe(true);
    expect(validateManifest(new DataView(bytes.buffer)).ok).toBe(true);
    const offset = new Uint8Array([0x20, ...bytes, 0x20]).subarray(1, bytes.length + 1);
    expect(validateManifest(offset).ok).toBe(true);
  });

  it.each([
    ['a syntax error', '{ "manifestVersion": 1, }'],
    ['an empty string', ''],
    ['a truncated document', minimalText.slice(0, 40)],
    ['trailing text', `${minimalText} extra`],
  ])('reports %s as a single schema_invalid_json problem at $', (_name, text) => {
    const result = validateManifest(text);
    expect(result).toEqual({
      ok: false,
      problems: [
        {
          path: '$',
          code: 'schema_invalid_json',
          messageKey: 'schema_invalid_json',
          message: expect.stringMatching(/^The Manifest is not valid JSON: .+/) as string,
          params: { detail: expect.any(String) as string },
        },
      ],
      warnings: [],
    });
  });

  it('reports bytes that are not UTF-8 as schema_invalid_json', () => {
    const result = validateManifest(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    expect(findings(problemsOf(result))).toEqual(['schema_invalid_json@$']);
  });

  it.each([
    ['undefined', undefined],
    ['a function', () => 1],
    ['a BigInt', { ...minimalManifest(), manifestVersion: 1n }],
    [
      'a circular structure',
      (() => {
        const manifest: Record<string, unknown> = minimalManifest();
        manifest['x-self'] = manifest;
        return manifest;
      })(),
    ],
  ])('reports %s, which has no JSON form, as schema_invalid_json', (_name, value) => {
    const [problem] = problemsOf(validateManifest(value));
    expect(problem).toMatchObject({
      path: '$',
      code: 'schema_invalid_json',
      messageKey: 'schema_invalid_json.not_serializable',
    });
  });

  it('validates a JavaScript value as the JSON it serialises to', () => {
    const manifest = { ...minimalManifest(), tags: undefined, changelog: undefined };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest).not.toHaveProperty('tags');
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '1'],
    ['a string', '"manifest"'],
  ])('reports %s at the root as schema_type at $', (_name, text) => {
    expect(findings(problemsOf(validateManifest(text)))).toEqual(['schema_type@$']);
  });

  it('reports an empty object with every required key', () => {
    const problems = problemsOf(validateManifest({}));
    expect(problems.every((problem) => problem.code === 'schema_required')).toBe(true);
    expect(problems).toHaveLength(12);
  });

  it('treats keys with lone surrogates as unknown instead of crashing', () => {
    const result = validateManifest('{"\\ud800": 1}');
    expect(findings(problemsOf(result))).toContain('unknown_key@["\uFFFD"]');
  });

  it('survives deeply nested and very large values in linear time', () => {
    const deep = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    const text = minimalText.replace('"tags": [', `"foo": ${deep}, "tags": [`);
    expect(findings(problemsOf(validateManifest(text)))).toEqual(['unknown_key@foo']);

    const platforms = Array.from({ length: 200_000 }, () => 'linux-x64');
    const started = performance.now();
    const problems = problemsOf(validateManifest({ ...minimalManifest(), platforms }));
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(problems).toHaveLength(platforms.length - 1);
    expect(problems.every((problem) => problem.code === 'schema_unique_items')).toBe(true);
  });
});

describe('the returned Manifest', () => {
  it('is a copy: later changes to the input do not reach it', () => {
    const input = minimalManifest();
    const result = validateManifest(input);
    if (!result.ok) throw new Error('expected ok');
    (input.models as { slots: Record<string, unknown> }).slots.fast = {};
    input.name = 'Changed';
    expect(result.manifest.name).toBe('Hello Web');
    expect(Object.keys(result.manifest.models.slots)).toEqual(['default']);
  });

  it('leaves out top-level x- keys and keeps every other key as written', () => {
    const input = { 'x-first': 1, ...minimalManifest(), 'x-last': { a: 1 } };
    const result = validateManifest(input);
    if (!result.ok) throw new Error('expected ok');
    expect(result.manifest).toEqual(minimalManifest());
    expect(Object.keys(result.manifest)).toEqual(Object.keys(minimalManifest()));
  });

  it('does not apply defaults (the type marks defaulted keys optional)', () => {
    const input = minimalManifest();
    delete input.workspace;
    const result = validateManifest(input);
    if (!result.ok) throw new Error('expected ok');
    expect(result.manifest).not.toHaveProperty('workspace');
    expect(result.manifest).not.toHaveProperty('channel');
    expect(result.manifest.ui).toEqual({ kind: 'web' });
  });
});

describe('options', () => {
  const manifest = (changes: Record<string, unknown> = {}) => ({
    ...minimalManifest(),
    ...changes,
  });

  it('compares the publisher case-insensitively, as GitHub logins are', () => {
    expect(validateManifest(manifest(), { publisher: 'Alice' }).ok).toBe(true);
    expect(validateManifest(manifest(), { publisher: 'ALICE' }).ok).toBe(true);
  });

  it('names both publishers in publisher_mismatch', () => {
    const [problem] = problemsOf(
      validateManifest(manifest({ id: 'bob/foo' }), { publisher: 'Alice' }),
    );
    expect(problem).toMatchObject({
      path: 'id',
      params: { idPublisher: 'bob', publisher: 'alice' },
    });
  });

  it('skips publisher_mismatch when the id has no publisher segment (the schema reports it)', () => {
    const result = validateManifest(manifest({ id: 'no-slash' }), { publisher: 'alice' });
    expect(findings(problemsOf(result))).toEqual(['schema_pattern@id']);
  });

  it.each([
    [[], '0.1.0', true],
    [['0.0.9'], '0.1.0', true],
    [['0.1.0'], '0.1.0', false],
    [['0.2.0', '0.1.0', '0.3.0-beta.1'], '0.3.0-beta.2', true],
    [['0.2.0', '0.1.0', '0.3.0-beta.1'], '0.3.0-alpha.9', false],
    [['1.0.0-rc.1'], '1.0.0', true],
    [['1.0.0'], '1.0.0-rc.2', false],
    [['1.0.0-beta.10'], '1.0.0-beta.2', false],
  ])('publishedVersions %j and version %s: ok is %s', (publishedVersions, version, ok) => {
    const result = validateManifest(manifest({ version }), { publishedVersions });
    expect(result.ok).toBe(ok);
    if (!ok) expect(findings(problemsOf(result))).toEqual(['version_not_greater@version']);
  });

  it('reports the latest published version, whatever the input order', () => {
    const [problem] = problemsOf(
      validateManifest(manifest({ version: '1.0.0' }), {
        publishedVersions: ['1.1.0', '2.0.0', '1.9.9'],
      }),
    );
    expect(problem?.params).toEqual({ version: '1.0.0', latest: '2.0.0' });
  });

  it('skips version_not_greater when version is invalid (version_invalid says why)', () => {
    const result = validateManifest(manifest({ version: '1.0' }), { publishedVersions: ['2.0.0'] });
    expect(findings(problemsOf(result))).toEqual(['version_invalid@version']);
  });

  it('runs no option rule without options', () => {
    expect(validateManifest(manifest({ id: 'bob/foo', version: '0.0.1' })).ok).toBe(true);
  });

  it.each([
    ['a non-string publisher', { publisher: 42 }],
    ['publishedVersions that is not an array', { publishedVersions: '1.0.0' }],
    ['a published version with a v prefix', { publishedVersions: ['v1.0.0'] }],
    ['a published version with build metadata', { publishedVersions: ['1.0.0+b'] }],
    ['a non-string published version', { publishedVersions: [1] }],
  ])('throws a TypeError for %s (a caller bug, not a Manifest problem)', (_name, options) => {
    expect(() => validateManifest(minimalText, options as never)).toThrow(TypeError);
  });
});

describe('problem list', () => {
  it('puts manifestVersion problems first, whatever else fails', () => {
    const result = validateManifest({ ...minimalManifest(), name: 1, manifestVersion: 2, foo: 1 });
    expect(problemsOf(result)[0]).toMatchObject({ path: 'manifestVersion', code: 'schema_enum' });
    expect(problemsOf(result)).toHaveLength(3);
  });

  it('reports a finding once even when two rules detect it', () => {
    // The schema pattern and the semver library both reject this version.
    const result = validateManifest({ ...minimalManifest(), version: 'v1.0.0' });
    expect(problemsOf(result)).toHaveLength(1);
  });

  it('interpolates params into message and keeps them raw in params', () => {
    const [problem] = problemsOf(
      validateManifest({ ...minimalManifest(), summary: 's'.repeat(130) }),
    );
    expect(problem).toEqual({
      path: 'summary',
      code: 'schema_max_length',
      messageKey: 'schema_max_length',
      message: 'Must be at most 120 characters long; found 130.',
      params: { limit: 120, actual: 130 },
    });
  });

  it('shortens long values quoted in messages', () => {
    const [problem] = problemsOf(
      validateManifest({ ...minimalManifest(), license: 'x '.repeat(500) }),
    );
    expect(problem?.params?.actual).toMatch(/…$/);
    expect(String(problem?.params?.actual).length).toBeLessThan(80);
  });

  it('keeps warnings when there are also problems', () => {
    const manifest = { ...minimalManifest(), name: '', ui: { kind: 'terminal', path: '/' } };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    expect(findings(result.warnings)).toEqual(['ignored_key@ui.path']);
  });
});
