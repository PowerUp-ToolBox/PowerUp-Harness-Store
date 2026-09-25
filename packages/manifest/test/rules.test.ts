/**
 * Field-by-field rules of docs/tech/manifest-spec.md sections 2 to 6. Each case edits a valid
 * Manifest and lists exactly the problems and warnings that must result (as `code@path`).
 */
import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/index.js';
import { binaryManifest, findings, minimalManifest, problemsOf } from './helpers.js';

type Manifest = Record<string, unknown>;

interface Case {
  name: string;
  base?: 'minimal' | 'binary';
  edit: (manifest: Manifest) => void;
  problems?: string[];
  warnings?: string[];
}

function run({ base = 'minimal', edit }: Case) {
  const manifest = base === 'binary' ? binaryManifest() : minimalManifest();
  edit(manifest);
  return validateManifest(manifest);
}

function expectCase(testCase: Case): void {
  const result = run(testCase);
  expect(findings(problemsOf(result))).toEqual([...(testCase.problems ?? [])].sort());
  expect(findings(result.warnings)).toEqual([...(testCase.warnings ?? [])].sort());
}

/** A nested object inside a Manifest, for concise edits. */
function at(manifest: Manifest, ...path: string[]): Manifest {
  return path.reduce<Manifest>((node, key) => node[key] as Manifest, manifest);
}

const REQUIRED = [
  'manifestVersion',
  'id',
  'version',
  'name',
  'summary',
  'license',
  'platforms',
  'runtime',
  'entry',
  'ui',
  'models',
  'permissions',
];

describe('top-level fields', () => {
  it.each(REQUIRED)('%s is required', (field) => {
    expectCase({
      name: field,
      edit: (m) => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the field under test
        delete m[field];
      },
      problems: [`schema_required@${field}`],
    });
  });

  it.each<Case>([
    {
      name: 'manifestVersion 2',
      edit: (m) => (m.manifestVersion = 2),
      problems: ['schema_enum@manifestVersion'],
    },
    {
      name: 'manifestVersion "1"',
      edit: (m) => (m.manifestVersion = '1'),
      problems: ['schema_enum@manifestVersion'],
    },
    { name: 'name of 40 characters', edit: (m) => (m.name = 'n'.repeat(40)) },
    {
      name: 'name of 41 characters',
      edit: (m) => (m.name = 'n'.repeat(41)),
      problems: ['schema_max_length@name'],
    },
    { name: 'name counts code points, not UTF-16 units', edit: (m) => (m.name = '🚀✨') },
    {
      name: 'empty summary',
      edit: (m) => (m.summary = ''),
      problems: ['schema_min_length@summary'],
    },
    { name: 'summary of 120 characters', edit: (m) => (m.summary = 's'.repeat(120)) },
    {
      name: 'five tags',
      edit: (m) => (m.tags = ['coding', 'writing', 'research', 'data', 'other']),
    },
    { name: 'no tags at all', edit: (m) => delete m.tags },
    {
      name: 'a tag outside the curated list',
      edit: (m) => (m.tags = ['fun', 'games']),
      problems: ['schema_enum@tags[1]'],
    },
    {
      name: 'a repeated tag',
      edit: (m) => (m.tags = ['fun', 'data', 'fun']),
      problems: ['schema_unique_items@tags[2]'],
    },
    { name: 'license "proprietary"', edit: (m) => (m.license = 'proprietary') },
    { name: 'license GPL-3.0-or-later', edit: (m) => (m.license = 'GPL-3.0-or-later') },
    {
      name: 'license expression',
      edit: (m) => (m.license = 'MIT OR Apache-2.0'),
      problems: ['schema_pattern@license'],
    },
    {
      name: 'https homepage and sourceRepo',
      edit: (m) =>
        Object.assign(m, {
          homepage: 'https://example.com/a?b#c',
          sourceRepo: 'http://git.example.com/x',
        }),
    },
    {
      name: 'javascript: homepage',
      edit: (m) => (m.homepage = 'javascript:alert(1)'),
      problems: ['schema_pattern@homepage'],
    },
    {
      name: 'relative sourceRepo',
      edit: (m) => (m.sourceRepo = 'github.com/alice/x'),
      problems: ['schema_pattern@sourceRepo'],
    },
    { name: 'channel stable', edit: (m) => (m.channel = 'stable') },
    {
      name: 'channel beta (reserved for P1)',
      edit: (m) => (m.channel = 'beta'),
      problems: ['schema_enum@channel'],
    },
    { name: 'workspace optional', edit: (m) => (m.workspace = 'optional') },
    {
      name: 'workspace sometimes',
      edit: (m) => (m.workspace = 'sometimes'),
      problems: ['schema_enum@workspace'],
    },
    { name: 'changelog of exactly 5 KB', edit: (m) => (m.changelog = 'c'.repeat(5120)) },
    {
      name: 'changelog of 5 KB + 1 byte',
      edit: (m) => (m.changelog = 'c'.repeat(5121)),
      problems: ['schema_max_length@changelog'],
    },
    // 2 000 CJK characters are 6 000 bytes of UTF-8: the limit is bytes, not characters.
    {
      name: 'changelog over 5 KB in bytes only',
      edit: (m) => (m.changelog = '更'.repeat(2000)),
      problems: ['schema_max_length@changelog'],
    },
    { name: 'an unknown key', edit: (m) => (m.readme = 'x'), problems: ['unknown_key@readme'] },
    {
      name: 'X- is not x-',
      edit: (m) => (m['X-internal'] = 1),
      problems: ['unknown_key@X-internal'],
    },
    { name: 'an x- key of any shape', edit: (m) => (m['x-anything'] = [null, { deep: ['x'] }]) },
    { name: 'an x- key with no suffix', edit: (m) => (m['x-'] = 1) },
    {
      name: 'a __proto__ key',
      edit: (m) => Object.defineProperty(m, '__proto__', { value: {}, enumerable: true }),
      problems: ['unknown_key@__proto__'],
    },
    { name: 'a key with dots', edit: (m) => (m['a.b'] = 1), problems: ['unknown_key@["a.b"]'] },
  ])('$name', expectCase);
});

describe('id (Harness ID)', () => {
  it.each([
    'alice/hello-web',
    'a/abc',
    '0/000',
    'alice-bob/a-b-c',
    `${'p'.repeat(39)}/${'s'.repeat(40)}`,
  ])('%s is valid', (id) => {
    expectCase({ name: id, edit: (m) => (m.id = id) });
  });

  it.each([
    'Alice/hello',
    'alice/Hello',
    'alice/ab',
    'alice/-abc',
    'alice/abc-',
    'alice/a_c',
    '-alice/abc',
    'alice',
    'alice/abc/def',
    '/abc',
    `${'p'.repeat(40)}/abc`,
    `alice/${'s'.repeat(41)}`,
  ])('%s is rejected', (id) => {
    expectCase({ name: id, edit: (m) => (m.id = id), problems: ['schema_pattern@id'] });
  });
});

describe('version', () => {
  it.each(['0.0.0', '0.1.0', '1.2.3-alpha', '1.2.3-alpha.1', '10.20.30-rc.1.x-y', '1.0.0-0'])(
    '%s is valid',
    (version) => {
      expectCase({ name: version, edit: (m) => (m.version = version) });
    },
  );

  it.each([
    'v1.2.3',
    '1.2',
    '1',
    '01.2.3',
    '1.02.3',
    '1.2.3-01',
    '1.2.3-',
    '1.2.3+build',
    '1.2.3-beta+build',
    ' 1.2.3',
    '1.2.3 ',
    '=1.2.3',
    // Passes the pattern; the semver library rejects it (above Number.MAX_SAFE_INTEGER).
    '99999999999999999999.0.0',
  ])('%s is rejected once, as version_invalid', (version) => {
    expectCase({
      name: version,
      edit: (m) => (m.version = version),
      problems: ['version_invalid@version'],
    });
  });

  it('a non-string version is a type problem', () => {
    expectCase({ name: 'number', edit: (m) => (m.version = 1), problems: ['schema_type@version'] });
  });
});

describe('platforms, runtime and entry', () => {
  it.each<Case>([
    {
      name: 'no platforms',
      edit: (m) => (m.platforms = []),
      problems: ['schema_min_items@platforms'],
    },
    {
      name: 'an unknown platform',
      edit: (m) => (m.platforms = ['linux-x64', 'linux-riscv64']),
      problems: ['schema_enum@platforms[1]'],
    },
    {
      name: 'a repeated platform',
      edit: (m) => (m.platforms = ['linux-x64', 'linux-x64']),
      problems: ['schema_unique_items@platforms[1]'],
    },
    {
      name: 'platforms as a string',
      edit: (m) => (m.platforms = 'linux-x64'),
      problems: ['schema_type@platforms'],
    },
    {
      name: 'runtime kind python (P0.5)',
      edit: (m) => (m.runtime = { kind: 'python', python: '3.12' }),
      problems: ['schema_enum@runtime.kind', 'unknown_key@runtime.python'],
    },
    {
      name: 'runtime without kind',
      edit: (m) => (m.runtime = { node: '22' }),
      problems: ['schema_required@runtime.kind'],
    },
    {
      name: 'node runtime without node',
      edit: (m) => (m.runtime = { kind: 'node' }),
      problems: ['schema_required@runtime.node'],
    },
    {
      name: 'node runtime on Node 20',
      edit: (m) => (m.runtime = { kind: 'node', node: '20' }),
      problems: ['schema_enum@runtime.node'],
    },
    { name: 'node entry .mjs', edit: (m) => (m.entry = 'server/main.mjs') },
    { name: 'node entry .cjs', edit: (m) => (m.entry = 'index.cjs') },
    {
      name: 'node entry .ts',
      edit: (m) => (m.entry = 'src/index.ts'),
      problems: ['schema_pattern@entry'],
    },
    {
      name: 'node entry with ./',
      edit: (m) => (m.entry = './dist/index.js'),
      problems: ['schema_pattern@entry'],
    },
    {
      name: 'node entry escaping the package',
      edit: (m) => (m.entry = '../index.js'),
      problems: ['schema_pattern@entry'],
    },
    {
      name: 'node entry absolute',
      edit: (m) => (m.entry = '/usr/lib/index.js'),
      problems: ['schema_pattern@entry'],
    },
    {
      name: 'node entry with a drive letter',
      edit: (m) => (m.entry = 'C:/app/index.js'),
      problems: ['schema_pattern@entry'],
    },
    {
      name: 'node entry with backslashes',
      edit: (m) => (m.entry = 'dist\\index.js'),
      problems: ['schema_pattern@entry'],
    },
    {
      name: 'node entry as an object',
      edit: (m) => (m.entry = { 'linux-x64': 'dist/index.js' }),
      problems: ['schema_type@entry'],
    },
    { name: 'entry as a number', edit: (m) => (m.entry = 42), problems: ['schema_type@entry'] },
    {
      name: 'binary runtime with a string entry',
      base: 'binary',
      edit: (m) => (m.entry = 'bin/reviewer'),
      problems: ['schema_type@entry'],
    },
    {
      name: 'binary entry missing two platforms',
      base: 'binary',
      edit: (m) => (m.entry = { 'darwin-arm64': 'bin/reviewer' }),
      problems: [
        'entry_missing_for_platform@entry.win32-x64',
        'entry_missing_for_platform@entry.linux-x64',
      ],
    },
    {
      name: 'binary entry for an undeclared platform',
      base: 'binary',
      edit: (m) => (at(m, 'entry')['linux-arm64'] = 'bin/linux-arm64/reviewer'),
      warnings: ['ignored_key@entry.linux-arm64'],
    },
    {
      name: 'binary entry keyed by something that is not a platform',
      base: 'binary',
      edit: (m) => (at(m, 'entry').default = 'bin/reviewer'),
      problems: ['schema_enum@entry.default'],
    },
    {
      name: 'binary entry escaping the package',
      base: 'binary',
      edit: (m) => (at(m, 'entry')['linux-x64'] = 'bin/../../etc/passwd'),
      problems: ['schema_pattern@entry.linux-x64'],
    },
    {
      name: 'binary entry that is not a string',
      base: 'binary',
      edit: (m) => (at(m, 'entry')['linux-x64'] = ['bin/a']),
      problems: ['schema_type@entry.linux-x64'],
    },
    {
      name: 'binary runtime with a node version',
      base: 'binary',
      edit: (m) => (at(m, 'runtime').node = '22'),
      warnings: ['ignored_key@runtime.node'],
    },
    {
      name: 'an unknown runtime kind skips the kind-dependent entry rules',
      edit: (m) => (m.runtime = { kind: 'deno' }),
      problems: ['schema_enum@runtime.kind'],
    },
  ])('$name', expectCase);
});

describe('ui (UI Kind)', () => {
  it.each<Case>([
    { name: 'terminal', edit: (m) => (m.ui = { kind: 'terminal' }) },
    {
      name: 'web with every option',
      edit: (m) =>
        (m.ui = {
          kind: 'web',
          path: '/app/',
          readyTimeoutSeconds: 5,
          window: { width: 800, height: 600 },
        }),
    },
    { name: 'no kind', edit: (m) => (m.ui = {}), problems: ['schema_required@ui.kind'] },
    {
      name: 'kind window',
      edit: (m) => (m.ui = { kind: 'window' }),
      problems: ['schema_enum@ui.kind'],
    },
    {
      name: 'path without leading slash',
      edit: (m) => (m.ui = { kind: 'web', path: 'app' }),
      problems: ['schema_pattern@ui.path'],
    },
    {
      name: 'protocol-relative path',
      edit: (m) => (m.ui = { kind: 'web', path: '//evil.example' }),
      problems: ['schema_pattern@ui.path'],
    },
    {
      name: 'backslash path',
      edit: (m) => (m.ui = { kind: 'web', path: '/\\evil.example' }),
      problems: ['schema_pattern@ui.path'],
    },
    {
      name: 'fractional timeout',
      edit: (m) => (m.ui = { kind: 'web', readyTimeoutSeconds: 7.5 }),
      problems: ['schema_type@ui.readyTimeoutSeconds'],
    },
    {
      name: 'zero-width window',
      edit: (m) => (m.ui = { kind: 'web', window: { width: 0 } }),
      problems: ['schema_minimum@ui.window.width'],
    },
    {
      name: 'unknown window key',
      edit: (m) => (m.ui = { kind: 'web', window: { depth: 3 } }),
      problems: ['unknown_key@ui.window.depth'],
    },
    {
      name: 'x- keys are top-level only',
      edit: (m) => (m.ui = { kind: 'web', 'x-note': 1 }),
      problems: ['unknown_key@ui.x-note'],
    },
    {
      name: 'web-only options on a terminal UI Kind',
      edit: (m) => (m.ui = { kind: 'terminal', path: '/', window: {} }),
      warnings: ['ignored_key@ui.path', 'ignored_key@ui.window'],
    },
  ])('$name', expectCase);
});

describe('models (Model Slots, Model Requirements, Recommended Models)', () => {
  const slots = (value: unknown) => (m: Manifest) => (m.models = { slots: value });

  it.each<Case>([
    { name: 'only a default Slot with no keys', edit: slots({ default: {} }) },
    {
      name: 'eight Slots',
      edit: slots(
        Object.fromEntries(['default', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => [n, {}])),
      ),
    },
    {
      name: 'nine Slots',
      edit: slots(
        Object.fromEntries(['default', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => [n, {}])),
      ),
      problems: ['schema_max_properties@models.slots'],
    },
    {
      name: 'no slots key',
      edit: (m) => (m.models = {}),
      problems: ['schema_required@models.slots'],
    },
    {
      name: 'no default Slot',
      edit: slots({ fast: {} }),
      problems: ['slot_default_missing@models.slots.default'],
    },
    {
      name: 'an upper-case Slot name',
      edit: slots({ default: {}, Fast: {} }),
      problems: ['schema_pattern@models.slots.Fast'],
    },
    {
      name: 'a Slot name of 33 characters',
      edit: slots({ default: {}, ['s'.repeat(33)]: {} }),
      problems: [`schema_pattern@models.slots.${'s'.repeat(33)}`],
    },
    {
      name: 'a Slot that is not an object',
      edit: slots({ default: 'gpt-5' }),
      problems: ['schema_type@models.slots.default'],
    },
    {
      name: 'an unknown Slot key',
      edit: slots({ default: { model: 'x' } }),
      problems: ['unknown_key@models.slots.default.model'],
    },
    {
      name: 'an unknown requirement',
      edit: slots({ default: { requirements: { audio: true } } }),
      problems: ['unknown_key@models.slots.default.requirements.audio'],
    },
    {
      name: 'minContext 0',
      edit: slots({ default: { requirements: { minContext: 0 } } }),
      problems: ['schema_minimum@models.slots.default.requirements.minContext'],
    },
    {
      name: 'tools as a string',
      edit: slots({ default: { requirements: { tools: 'yes' } } }),
      problems: ['schema_type@models.slots.default.requirements.tools'],
    },
    {
      name: 'five Recommended Models',
      edit: slots({ default: { recommended: ['a/1', 'b/2', 'c/3', 'd/4', 'e/5'] } }),
    },
    {
      name: 'six Recommended Models',
      edit: slots({ default: { recommended: ['a/1', 'b/2', 'c/3', 'd/4', 'e/5', 'f/6'] } }),
      problems: ['schema_max_items@models.slots.default.recommended'],
    },
    {
      name: 'a model id without provider',
      edit: slots({ default: { recommended: ['claude-sonnet-4-5'] } }),
      problems: ['schema_pattern@models.slots.default.recommended[0]'],
    },
    {
      name: 'an upper-case provider',
      edit: slots({ default: { recommended: ['OpenAI/gpt-5'] } }),
      problems: ['schema_pattern@models.slots.default.recommended[0]'],
    },
    {
      name: 'OpenRouter ids keep their own slash',
      edit: slots({
        default: { recommended: ['openrouter/anthropic/claude-sonnet-4-5', 'ollama/qwen3:8b'] },
      }),
    },
    {
      name: 'a repeated Recommended Model',
      edit: slots({ default: {}, fast: { recommended: ['openai/gpt-5', 'openai/gpt-5'] } }),
      problems: ['schema_unique_items@models.slots.fast.recommended[1]'],
    },
  ])('$name', expectCase);

  it('explains an invalid Slot name with the offending key', () => {
    const manifest = minimalManifest();
    manifest.models = { slots: { default: {}, my_slot: {} } };
    const [problem] = problemsOf(validateManifest(manifest));
    expect(problem).toMatchObject({
      code: 'schema_pattern',
      messageKey: 'schema_pattern.slotName',
      path: 'models.slots.my_slot',
      params: { key: 'my_slot' },
    });
    expect(problem?.message).toContain('"my_slot"');
  });
});

describe('permissions (Declared Permissions)', () => {
  const permissions = (value: unknown) => (m: Manifest) => (m.permissions = value);
  const base = { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } };

  it.each(['filesystem', 'shell', 'network'])('%s is required', (key) => {
    const value: Record<string, unknown> = { ...base };
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key under test
    delete value[key];
    expectCase({
      name: key,
      edit: permissions(value),
      problems: [`schema_required@permissions.${key}`],
    });
  });

  it.each<Case>([
    { name: 'scope home', edit: permissions({ ...base, filesystem: { scope: 'home' } }) },
    {
      name: 'scope paths with paths',
      edit: permissions({ ...base, filesystem: { scope: 'paths', paths: ['~/notes', '/tmp/x'] } }),
    },
    {
      name: 'scope root',
      edit: permissions({ ...base, filesystem: { scope: 'root' } }),
      problems: ['schema_enum@permissions.filesystem.scope'],
    },
    {
      name: 'scope paths without paths',
      edit: permissions({ ...base, filesystem: { scope: 'paths' } }),
      problems: ['schema_required@permissions.filesystem.paths'],
    },
    {
      name: 'scope paths with no paths',
      edit: permissions({ ...base, filesystem: { scope: 'paths', paths: [] } }),
      problems: ['schema_min_items@permissions.filesystem.paths'],
    },
    {
      name: 'an empty path',
      edit: permissions({ ...base, filesystem: { scope: 'paths', paths: [''] } }),
      problems: ['schema_min_length@permissions.filesystem.paths[0]'],
    },
    {
      name: 'a repeated path',
      edit: permissions({ ...base, filesystem: { scope: 'paths', paths: ['~/a', '~/a'] } }),
      problems: ['schema_unique_items@permissions.filesystem.paths[1]'],
    },
    {
      name: 'empty paths with another scope (spec example)',
      edit: permissions({ ...base, filesystem: { scope: 'workspace', paths: [] } }),
    },
    {
      name: 'paths with another scope',
      edit: permissions({ ...base, filesystem: { scope: 'home', paths: ['~/a'] } }),
      warnings: ['ignored_key@permissions.filesystem.paths'],
    },
    {
      name: 'shell as a string',
      edit: permissions({ ...base, shell: 'no' }),
      problems: ['schema_type@permissions.shell'],
    },
    { name: 'network any', edit: permissions({ ...base, network: { any: true } }) },
    {
      name: 'network domains and wildcards',
      edit: permissions({
        ...base,
        network: { domains: ['api.github.com', '*.example.com', 'localhost'] },
      }),
    },
    {
      name: 'network with neither domains nor any',
      edit: permissions({ ...base, network: {} }),
      problems: ['schema_required@permissions.network'],
    },
    {
      name: 'network any false',
      edit: permissions({ ...base, network: { any: false } }),
      problems: ['schema_enum@permissions.network.any'],
    },
    {
      name: 'network any next to domains',
      edit: permissions({ ...base, network: { any: true, domains: ['a.com'] } }),
      warnings: ['ignored_key@permissions.network.domains'],
    },
    {
      name: 'an upper-case domain',
      edit: permissions({ ...base, network: { domains: ['API.github.com'] } }),
      problems: ['schema_pattern@permissions.network.domains[0]'],
    },
    {
      name: 'a URL instead of a domain',
      edit: permissions({ ...base, network: { domains: ['https://api.github.com'] } }),
      problems: ['schema_pattern@permissions.network.domains[0]'],
    },
    {
      name: 'a repeated domain',
      edit: permissions({ ...base, network: { domains: ['a.com', 'a.com'] } }),
      problems: ['schema_unique_items@permissions.network.domains[1]'],
    },
    {
      name: 'twenty domains',
      edit: permissions({
        ...base,
        network: { domains: Array.from({ length: 20 }, (_, i) => `d${String(i)}.com`) },
      }),
    },
    {
      name: 'twenty-one domains',
      edit: permissions({
        ...base,
        network: { domains: Array.from({ length: 21 }, (_, i) => `d${String(i)}.com`) },
      }),
      problems: ['schema_max_items@permissions.network.domains'],
    },
    {
      name: 'an unknown permission',
      edit: permissions({ ...base, camera: true }),
      problems: ['unknown_key@permissions.camera'],
    },
  ])('$name', expectCase);
});
