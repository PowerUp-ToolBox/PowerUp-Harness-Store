import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_MANIFEST_VALUES } from '../src/document.js';
import { manifestSchema, validateManifest } from '../src/index.js';
import { validateAgainstSchema } from '../src/schema.js';
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
});

/** Counts JSON values the way the limit does: every object, array, string, number, boolean, null. */
function countValues(value: unknown): number {
  if (Array.isArray(value))
    return 1 + value.reduce<number>((sum, item) => sum + countValues(item), 0);
  if (typeof value === 'object' && value !== null) {
    return 1 + Object.values(value).reduce<number>((sum, item) => sum + countValues(item), 0);
  }
  return 1;
}

const nested = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
const nestedObject = (depth: number) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;

describe('hostile input: every Manifest gets problems, never an exception', () => {
  const tooLarge = {
    path: '$',
    code: 'schema_invalid_json',
    messageKey: 'schema_invalid_json.too_large',
    params: { limit: MAX_MANIFEST_VALUES },
  };

  // Each of these fields quotes the value it rejects in its message (schema_enum `actual`).
  it.each([
    [
      'workspace',
      (text: string, value: string) => text.replace('"workspace": "none"', `"workspace": ${value}`),
    ],
    [
      'channel',
      (text: string, value: string) => text.replace('"tags": [', `"channel": ${value}, "tags": [`),
    ],
    [
      'manifestVersion',
      (text: string, value: string) =>
        text.replace('"manifestVersion": 1', `"manifestVersion": ${value}`),
    ],
    [
      'tags[0]',
      (text: string, value: string) => text.replace('"tags": ["fun"]', `"tags": [${value}]`),
    ],
    [
      'runtime.node',
      (text: string, value: string) => text.replace('"node": "22"', `"node": ${value}`),
    ],
    [
      'an unknown key',
      (text: string, value: string) => text.replace('"tags": [', `"foo": ${value}, "tags": [`),
    ],
  ])('reports 10 000-deep nesting under %s as too large to check', (_field, embed) => {
    for (const value of [nested(10_000), nestedObject(10_000)]) {
      const text = embed(minimalText, value);
      expect(text).not.toBe(minimalText);
      expect(validateManifest(text)).toEqual({
        ok: false,
        problems: [{ ...tooLarge, message: expect.stringContaining('too large') as string }],
        warnings: [],
      });
    }
  });

  it('quotes a deeply nested value that fits the limit, shortened', () => {
    const text = minimalText.replace('"workspace": "none"', `"workspace": ${nested(1_900)}`);
    const [problem] = problemsOf(validateManifest(text));
    expect(problem).toMatchObject({ path: 'workspace', code: 'schema_enum' });
    expect(problem?.params?.actual).toBe(`${'['.repeat(60)}…`);
  });

  it.each([
    ['100 000 invalid platforms', () => ({ platforms: Array(100_000).fill('bad') })],
    ['100 000 duplicate platforms', () => ({ platforms: Array(100_000).fill('linux-x64') })],
    ['1 000 000 tags', () => ({ tags: Array(1_000_000).fill('fun') })],
    [
      '100 000 invalid Model Slots',
      () => ({
        models: {
          slots: Object.fromEntries(
            Array.from({ length: 100_000 }, (_, i) => [`s${String(i)}`, { bad: 1 }]),
          ),
        },
      }),
    ],
  ])('reports %s as too large to check, quickly', (_name, changes) => {
    const input = { ...minimalManifest(), ...changes() };
    const started = performance.now();
    expect(problemsOf(validateManifest(input))).toEqual([expect.objectContaining(tooLarge)]);
    expect(problemsOf(validateManifest(JSON.stringify(input)))).toEqual([
      expect.objectContaining(tooLarge),
    ]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it(`checks a Manifest of exactly ${String(MAX_MANIFEST_VALUES)} values, and rejects one more`, () => {
    const withPaths = (count: number) => {
      const manifest = minimalManifest();
      const paths = Array.from({ length: count }, (_, i) => `~/p${String(i)}`);
      (manifest.permissions as Record<string, unknown>).filesystem = { scope: 'paths', paths };
      return manifest;
    };
    const base = countValues(withPaths(0));
    const atLimit = withPaths(MAX_MANIFEST_VALUES - base);
    expect(countValues(atLimit)).toBe(MAX_MANIFEST_VALUES);
    expect(findings(problemsOf(validateManifest(atLimit)))).toEqual([
      'schema_max_items@permissions.filesystem.paths',
    ]);
    expect(problemsOf(validateManifest(withPaths(MAX_MANIFEST_VALUES - base + 1)))).toEqual([
      expect.objectContaining(tooLarge),
    ]);
  });

  it('keeps the limit ten times above the largest valid Manifest, whose size the schema bounds', () => {
    const bound = maxValuesOf(manifestSchema);
    expect(bound).toBeLessThan(200); // the too_large message and manifest-spec.md §7 say so
    expect(bound * 10).toBeLessThanOrEqual(MAX_MANIFEST_VALUES);
    const result = validateManifest(largestValidManifest());
    expect(result.ok).toBe(true);
    expect(countValues(largestValidManifest())).toBe(bound);
  });

  it('does not count top-level x- keys, which are never validated', () => {
    const input = { ...minimalManifest(), 'x-data': Array(100_000).fill({ deep: nested(10) }) };
    expect(validateManifest(input).ok).toBe(true);
    const text = minimalText.replace('"tags": [', `"x-deep": ${nested(100_000)}, "tags": [`);
    expect(validateManifest(text).ok).toBe(true);
  });

  // The JSON Schema library gathers errors with push(...errors), which throws once one call
  // passes more arguments than the stack holds: about 125 000 with Node's default stack, about
  // 25 000 with a 200 KB one. The value limit keeps the worst case far below that.
  it.each<[string, (manifest: Manifest, index: number) => void]>([
    [
      'invalid Slot names with values of the wrong type',
      (m, i) => (slotsOf(m)[`S${String(i)}`] = 5),
    ],
    ['invalid Slot names with unknown keys', (m, i) => (slotsOf(m)[`S${String(i)}`] = { a: 1 })],
    ['unknown requirement keys', (m, i) => (requirementsOf(m)[`k${String(i)}`] = 1)],
    ['invalid platforms', (m) => (m.platforms as unknown[]).push('bad')],
    [
      'invalid domains',
      (m) => ((m.permissions as Manifest).network = { domains: domainsOf(m).concat('BAD') }),
    ],
  ])('keeps schema errors bounded at the limit: %s', (_name, grow) => {
    const manifest = minimalManifest();
    for (let i = 0; countValues(manifest) < MAX_MANIFEST_VALUES - 1; i++) grow(manifest, i);
    expect(countValues(manifest)).toBeLessThanOrEqual(MAX_MANIFEST_VALUES);
    expect(validateAgainstSchema(manifest).length).toBeLessThan(20_000);
    expect(problemsOf(validateManifest(manifest)).length).toBeGreaterThan(900);
  });
});

/**
 * The most values a Manifest valid under `schema` can hold: every list and map in the schema must
 * have a maximum size. A list without `maxItems` counts as bounded only when its items come from
 * an enum, since validateManifest() rejects repeated values in lists. Top-level `x-` keys
 * (`patternProperties`) are not counted, as the limit does not count them either.
 */
function maxValuesOf(schema: unknown): number {
  const node = resolveRef(schema);
  if (node.type === 'array') {
    const items = resolveRef(node.items);
    const count =
      typeof node.maxItems === 'number'
        ? node.maxItems
        : Array.isArray(items.enum)
          ? items.enum.length
          : Number.POSITIVE_INFINITY;
    return 1 + count * maxValuesOf(items);
  }
  if (isObjectSchema(node)) {
    const properties = Object.values((node.properties ?? {}) as Record<string, unknown>).map(
      maxValuesOf,
    );
    const additional = node.additionalProperties;
    if (typeof additional === 'object' && additional !== null) {
      const count = typeof node.maxProperties === 'number' ? node.maxProperties : Infinity;
      return 1 + count * Math.max(maxValuesOf(additional), ...properties);
    }
    // Closed by `additionalProperties: false`, or by `propertyNames` naming the properties.
    if (additional !== false && node.propertyNames === undefined) return Infinity;
    return 1 + properties.reduce((sum, count) => sum + count, 0);
  }
  return 1;
}

function isObjectSchema(node: Record<string, unknown>): boolean {
  const types = ([] as unknown[]).concat(node.type);
  return types.includes('object') || node.properties !== undefined;
}

function resolveRef(schema: unknown): Record<string, unknown> {
  const node = schema as Record<string, unknown>;
  if (typeof node.$ref !== 'string') return node;
  const name = node.$ref.replace('#/$defs/', '');
  const siblings = { ...node };
  delete siblings.$ref;
  return { ...resolveRef((manifestSchema.$defs as Record<string, unknown>)[name]), ...siblings };
}

/** A valid Manifest with every optional key and every list and map at its maximum size. */
function largestValidManifest(): Manifest {
  const platforms = [
    'darwin-arm64',
    'darwin-x64',
    'win32-x64',
    'win32-arm64',
    'linux-x64',
    'linux-arm64',
  ];
  const slot = {
    description: 'Main model',
    requirements: { tools: true, minContext: 64_000, vision: false, json: true },
    recommended: ['a/1', 'b/2', 'c/3', 'd/4', 'e/5'],
  };
  const names = ['default', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const list = (count: number, item: (i: number) => string) =>
    Array.from({ length: count }, (_, i) => item(i));
  return {
    ...minimalManifest(),
    tags: ['coding', 'writing', 'research', 'data', 'fun'],
    homepage: 'https://example.com',
    sourceRepo: 'https://example.com/src',
    channel: 'stable',
    platforms,
    runtime: { kind: 'binary', node: '22' },
    entry: Object.fromEntries(platforms.map((platform) => [platform, `bin/${platform}`])),
    ui: { kind: 'web', path: '/', readyTimeoutSeconds: 30, window: { width: 800, height: 600 } },
    models: { slots: Object.fromEntries(names.map((name) => [name, slot])) },
    permissions: {
      filesystem: { scope: 'paths', paths: list(20, (i) => `~/p${String(i)}`) },
      shell: true,
      network: { domains: list(20, (i) => `d${String(i)}.example.com`), any: true },
    },
    changelog: 'First release.',
  };
}

type Manifest = Record<string, unknown>;
const slotsOf = (m: Manifest) => (m.models as { slots: Manifest }).slots;
const requirementsOf = (m: Manifest) =>
  ((slotsOf(m).default as Manifest).requirements ??= {}) as Manifest;
const domainsOf = (m: Manifest) =>
  (m.permissions as { network: { domains?: unknown[] } }).network.domains ?? [];

describe('numbers beyond the range of a double', () => {
  // JSON.parse turns these numerals into Infinity or -Infinity. The JSON Schema library accepts
  // Infinity as an integer, and JSON.stringify writes it as null.
  const web = '"ui": {\n    "kind": "web"\n  }';
  const tools = '"tools": false';
  const cases: [path: string, text: string][] = [
    [
      'models.slots.default.requirements.minContext',
      minimalText.replace(tools, '"minContext": 1e400'),
    ],
    [
      'models.slots.default.requirements.minContext',
      minimalText.replace(tools, '"minContext": 1e999'),
    ],
    [
      'ui.window.width',
      minimalText.replace(
        web,
        '"ui": { "kind": "web", "window": { "width": 1e400, "height": 1 } }',
      ),
    ],
    [
      'ui.window.height',
      minimalText.replace(
        web,
        '"ui": { "kind": "web", "window": { "width": 1, "height": 1E+309 } }',
      ),
    ],
    [
      'ui.readyTimeoutSeconds',
      minimalText.replace(web, '"ui": { "kind": "web", "readyTimeoutSeconds": -1e400 }'),
    ],
  ];

  it.each(cases)('reports %s as schema_type, as text and as bytes', (path, text) => {
    expect(text).not.toBe(minimalText);
    for (const input of [text, new TextEncoder().encode(text)]) {
      const result = validateManifest(input);
      expect(result.ok).toBe(false);
      const problems = problemsOf(result);
      // A type problem hides the value's other problems (schema_minimum for -Infinity).
      expect(findings(problems)).toEqual([`schema_type@${path}`]);
      expect(problems[0]).toMatchObject({
        messageKey: 'schema_type.non_finite',
        params: { actual: expect.stringMatching(/^number -?Infinity$/) as string },
      });
    }
  });

  it('reports every such number, in document order, and still runs the other rules', () => {
    const text = minimalText
      .replace(tools, '"minContext": 1e400')
      .replace(web, '"ui": { "kind": "web", "window": { "width": 1e400, "height": -1e400 } }')
      .replace('"name": "Hello Web",', '');
    const problems = problemsOf(validateManifest(text));
    expect(problems.map(({ code, path }) => `${code}@${path}`)).toEqual([
      'schema_required@name',
      'schema_type@ui.window.width',
      'schema_type@ui.window.height',
      'schema_type@models.slots.default.requirements.minContext',
    ]);
  });

  it('keeps the JSON Schema message where the schema expects another type', () => {
    const text = minimalText.replace('"Hello Web"', '1e400');
    const problems = problemsOf(validateManifest(text));
    expect(problems).toEqual([
      expect.objectContaining({
        path: 'name',
        messageKey: 'schema_type',
        message: 'Expected string; found number Infinity.',
      }),
    ]);
  });

  it('ignores them under top-level x- keys, which are never validated', () => {
    const text = minimalText.replace('"tags": [', '"x-big": [1e400, {"a": -1e400}], "tags": [');
    expect(validateManifest(text)).toMatchObject({ ok: true, warnings: [] });
  });

  it('never returns a Manifest that changes on a JSON round trip', () => {
    const numeral = fc.oneof(
      fc.integer().map(String),
      fc.double({ noNaN: true }).map((value) => String(value)),
      fc.constantFrom(
        '1e308',
        '1.7976931348623157e308',
        '1.8e308',
        '1e309',
        '-1e400',
        '1e-400',
        '9007199254740993',
      ),
    );
    const field = fc.constantFrom<(text: string, value: string) => string>(
      (text, value) => text.replace(tools, `"minContext": ${value}`),
      (text, value) =>
        text.replace(
          web,
          `"ui": { "kind": "web", "window": { "width": ${value}, "height": ${value} } }`,
        ),
      (text, value) =>
        text.replace(web, `"ui": { "kind": "web", "readyTimeoutSeconds": ${value} }`),
    );
    fc.assert(
      fc.property(numeral, field, (value, embed) => {
        const result = validateManifest(embed(minimalText, value));
        if (!result.ok) return;
        const roundTripped = JSON.parse(JSON.stringify(result.manifest)) as unknown;
        expect(roundTripped).toEqual(result.manifest);
        expect(validateManifest(roundTripped)).toEqual(result);
      }),
      { numRuns: 500 },
    );
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

  it("compares the id's publisher segment case-insensitively too (the schema flags the case)", () => {
    const result = validateManifest(manifest({ id: 'Alice/hello-web' }), { publisher: 'alice' });
    expect(findings(problemsOf(result))).toEqual(['schema_pattern@id']);
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
    ['null', null],
    ['a string', 'alice'],
    ['an array', []],
  ])('throws a descriptive TypeError when options is %s', (_name, options) => {
    expect(() => validateManifest(minimalText, options as never)).toThrow(
      new TypeError('options must be an object when given'),
    );
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
