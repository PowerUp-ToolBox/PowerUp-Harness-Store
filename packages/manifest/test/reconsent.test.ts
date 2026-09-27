/**
 * diffForReconsent: the table of ticket P0-01.3's "How to verify" step 3, then the finer points
 * of "widened" and of the added/removed lists.
 */
import { describe, expect, it } from 'vitest';
import { diffForReconsent, validateManifest } from '../src/index.js';
import type { Manifest, ReconsentDiff } from '../src/index.js';
import { binaryManifest, minimalManifest } from './helpers.js';

type Permissions = Manifest['permissions'];

/** A valid Manifest (checked, so the table never tests a Manifest the validator would reject). */
function manifest(changes: Partial<Manifest> = {}, base = minimalManifest()): Manifest {
  const result = validateManifest({ ...base, ...changes });
  if (!result.ok) throw new Error(`invalid test Manifest: ${JSON.stringify(result.problems)}`);
  return result.manifest;
}

function withPermissions(changes: Partial<Permissions>): Manifest {
  return manifest({
    permissions: {
      filesystem: { scope: 'workspace' },
      shell: false,
      network: { domains: ['api.github.com'] },
      ...changes,
    },
  });
}

const node = (entry: string) => manifest({ entry });
/** The minimal Manifest as a binary Harness: same permissions, a per-platform Entry. */
const binary = manifest({
  runtime: { kind: 'binary' },
  entry: {
    'darwin-arm64': 'bin/tool',
    'darwin-x64': 'bin/tool',
    'win32-x64': 'bin/tool.exe',
    'linux-x64': 'bin/tool',
  },
});

describe('diffForReconsent (How to verify, step 3)', () => {
  it.each<[string, Manifest, Manifest, Pick<ReconsentDiff, 'required' | 'reasons'>]>([
    [
      'scope widened (workspace to home)',
      withPermissions({ filesystem: { scope: 'workspace' } }),
      withPermissions({ filesystem: { scope: 'home' } }),
      { required: true, reasons: ['permissions_widened'] },
    ],
    [
      'scope narrowed (home to workspace)',
      withPermissions({ filesystem: { scope: 'home' } }),
      withPermissions({ filesystem: { scope: 'workspace' } }),
      { required: false, reasons: [] },
    ],
    [
      'shell false to true',
      withPermissions({ shell: false }),
      withPermissions({ shell: true }),
      { required: true, reasons: ['permissions_widened'] },
    ],
    [
      'shell true to false',
      withPermissions({ shell: true }),
      withPermissions({ shell: false }),
      { required: false, reasons: [] },
    ],
    [
      'network domain added',
      withPermissions({ network: { domains: ['api.github.com'] } }),
      withPermissions({ network: { domains: ['api.github.com', 'example.com'] } }),
      { required: true, reasons: ['permissions_widened'] },
    ],
    [
      'network domain removed',
      withPermissions({ network: { domains: ['api.github.com', 'example.com'] } }),
      withPermissions({ network: { domains: ['api.github.com'] } }),
      { required: false, reasons: [] },
    ],
    [
      'network domains to any',
      withPermissions({ network: { domains: ['api.github.com'] } }),
      withPermissions({ network: { any: true } }),
      { required: true, reasons: ['permissions_widened'] },
    ],
    [
      'entry changed',
      node('dist/index.js'),
      node('dist/main.js'),
      { required: true, reasons: ['entry_changed'] },
    ],
    [
      // A node Entry is a string and a binary Entry a map, so the Entry changes with the kind.
      'runtime kind changed',
      manifest(),
      binary,
      { required: true, reasons: ['entry_changed', 'runtime_kind_changed'] },
    ],
    ['no changes', manifest(), manifest(), { required: false, reasons: [] }],
  ])('%s', (_name, previous, next, expected) => {
    const diff = diffForReconsent(previous, next);
    expect({ required: diff.required, reasons: diff.reasons }).toEqual(expected);
  });
});

describe('diffForReconsent: acceptance criteria', () => {
  it('workspace to home: required, permissions_widened; home to workspace: not required', () => {
    const workspace = withPermissions({ filesystem: { scope: 'workspace' } });
    const home = withPermissions({ filesystem: { scope: 'home' } });
    expect(diffForReconsent(workspace, home)).toEqual({
      required: true,
      reasons: ['permissions_widened'],
      added: ['permissions.filesystem.scope:home'],
      removed: ['permissions.filesystem.scope:workspace'],
    });
    expect(diffForReconsent(home, workspace)).toMatchObject({ required: false, reasons: [] });
  });

  it('only the entry changes, permissions identical: required with only entry_changed', () => {
    expect(diffForReconsent(node('dist/index.js'), node('dist/main.mjs'))).toEqual({
      required: true,
      reasons: ['entry_changed'],
      added: ['entry:dist/main.mjs'],
      removed: ['entry:dist/index.js'],
    });
  });
});

describe('diffForReconsent: the filesystem ladder none < workspace < home < paths', () => {
  const scopes = ['none', 'workspace', 'home', 'paths'] as const;
  const filesystem = (scope: (typeof scopes)[number]) =>
    withPermissions({
      filesystem: scope === 'paths' ? { scope, paths: ['~/notes'] } : { scope },
    });

  for (const [i, from] of scopes.entries()) {
    for (const [j, to] of scopes.entries()) {
      if (i === j) continue;
      it(`${from} to ${to} ${j > i ? 'widens' : 'narrows'}`, () => {
        expect(diffForReconsent(filesystem(from), filesystem(to)).required).toBe(j > i);
      });
    }
  }

  it('a new path under an unchanged paths scope widens; a removed one narrows', () => {
    const paths = (...list: string[]) =>
      withPermissions({ filesystem: { scope: 'paths', paths: list } });
    expect(diffForReconsent(paths('~/a'), paths('~/a', '~/b'))).toEqual({
      required: true,
      reasons: ['permissions_widened'],
      added: ['permissions.filesystem.paths:~/b'],
      removed: [],
    });
    expect(diffForReconsent(paths('~/a', '~/b'), paths('~/a'))).toEqual({
      required: false,
      reasons: [],
      added: [],
      removed: ['permissions.filesystem.paths:~/b'],
    });
    // The same paths in another order are the same permission.
    expect(diffForReconsent(paths('~/a', '~/b'), paths('~/b', '~/a')).required).toBe(false);
    // Replacing a path is both.
    expect(diffForReconsent(paths('~/a'), paths('~/b'))).toMatchObject({
      required: true,
      added: ['permissions.filesystem.paths:~/b'],
      removed: ['permissions.filesystem.paths:~/a'],
    });
  });

  it('ignores paths outside scope paths, which have no effect', () => {
    const home = (paths: string[]) => withPermissions({ filesystem: { scope: 'home', paths } });
    expect(diffForReconsent(home([]), home(['~/x']))).toEqual({
      required: false,
      reasons: [],
      added: [],
      removed: [],
    });
  });

  it('lists every path of a new paths scope as added', () => {
    const before = withPermissions({ filesystem: { scope: 'home' } });
    const after = withPermissions({ filesystem: { scope: 'paths', paths: ['/etc', '~/x'] } });
    expect(diffForReconsent(before, after)).toEqual({
      required: true,
      reasons: ['permissions_widened'],
      added: [
        'permissions.filesystem.scope:paths',
        'permissions.filesystem.paths:/etc',
        'permissions.filesystem.paths:~/x',
      ],
      removed: ['permissions.filesystem.scope:home'],
    });
  });
});

describe('diffForReconsent: network', () => {
  const domains = (...list: string[]) => withPermissions({ network: { domains: list } });
  const any = withPermissions({ network: { any: true } });

  it('any back to a list narrows, and the listed domains are not "added" (any allowed them)', () => {
    expect(diffForReconsent(any, domains('api.github.com'))).toEqual({
      required: false,
      reasons: [],
      added: [],
      removed: ['permissions.network.any'],
    });
  });

  it('a list to any adds any and does not "remove" the domains (any still allows them)', () => {
    expect(diffForReconsent(domains('api.github.com'), any)).toEqual({
      required: true,
      reasons: ['permissions_widened'],
      added: ['permissions.network.any'],
      removed: [],
    });
  });

  it('ignores domains next to any: true, which have no effect', () => {
    const anyWith = (list: string[]) => withPermissions({ network: { any: true, domains: list } });
    expect(diffForReconsent(anyWith([]), anyWith(['a.example']))).toEqual({
      required: false,
      reasons: [],
      added: [],
      removed: [],
    });
  });

  it('replacing a domain widens, and lists both', () => {
    expect(diffForReconsent(domains('a.example'), domains('b.example'))).toEqual({
      required: true,
      reasons: ['permissions_widened'],
      added: ['permissions.network.domains:b.example'],
      removed: ['permissions.network.domains:a.example'],
    });
  });

  it('an empty list to an empty list is no change', () => {
    expect(diffForReconsent(domains(), domains()).required).toBe(false);
  });
});

describe('diffForReconsent: entry and runtime kind', () => {
  const withEntry = (entry: Record<string, string>) => manifest({ entry }, binaryManifest());
  const entry = binaryManifest().entry as Record<string, string>;

  it('fires on a changed per-platform path, naming the platform', () => {
    const next = withEntry({ ...entry, 'linux-x64': 'bin/linux-x64/reviewer-2' });
    expect(diffForReconsent(withEntry(entry), next)).toEqual({
      required: true,
      reasons: ['entry_changed'],
      added: ['entry.linux-x64:bin/linux-x64/reviewer-2'],
      removed: ['entry.linux-x64:bin/linux-x64/reviewer'],
    });
  });

  it('fires on any change to the per-platform map, even for a platform that is not declared', () => {
    const next = withEntry({ ...entry, 'linux-arm64': 'bin/linux-arm64/reviewer' });
    expect(diffForReconsent(withEntry(entry), next)).toMatchObject({
      required: true,
      reasons: ['entry_changed'],
      added: ['entry.linux-arm64:bin/linux-arm64/reviewer'],
    });
  });

  it('does not fire when only the order of the map changes', () => {
    const reversed = Object.fromEntries(Object.entries(entry).reverse());
    expect(diffForReconsent(withEntry(entry), withEntry(reversed)).required).toBe(false);
  });

  it('lists the runtime kind and the Entry when the kind changes', () => {
    const diff = diffForReconsent(manifest(), binaryManifest() as unknown as Manifest);
    expect(diff.added).toEqual([
      'permissions.filesystem.scope:paths',
      'permissions.filesystem.paths:~/.gitconfig',
      'permissions.filesystem.paths:~/.config/code-reviewer',
      'permissions.shell',
      'permissions.network.domains:api.github.com',
      'permissions.network.domains:*.githubusercontent.com',
      'entry.darwin-arm64:bin/mac-arm64/reviewer',
      'entry.win32-x64:bin/win-x64/reviewer.exe',
      'entry.linux-x64:bin/linux-x64/reviewer',
      'runtime.kind:binary',
    ]);
    expect(diff.removed).toEqual([
      'permissions.filesystem.scope:none',
      'entry:dist/index.js',
      'runtime.kind:node',
    ]);
    expect(diff.reasons).toEqual(['permissions_widened', 'entry_changed', 'runtime_kind_changed']);
  });

  it('ignores everything else: name, version, Model Slots, UI Kind, platforms', () => {
    const next = manifest({
      name: 'Renamed',
      version: '9.9.9',
      ui: { kind: 'terminal' },
      platforms: ['linux-x64'],
      models: { slots: { default: {}, fast: {} } },
    });
    expect(diffForReconsent(manifest(), next)).toEqual({
      required: false,
      reasons: [],
      added: [],
      removed: [],
    });
  });

  it('does not modify its arguments', () => {
    const previous = manifest();
    const next = binaryManifest() as unknown as Manifest;
    const copies = structuredClone([previous, next]);
    diffForReconsent(previous, next);
    expect([previous, next]).toEqual(copies);
  });
});
