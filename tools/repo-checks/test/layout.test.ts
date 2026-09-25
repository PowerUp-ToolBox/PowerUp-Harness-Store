import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  findWorkspacePackages,
  listDirectories,
  P0_LAYOUT,
  readPackageJson,
  readText,
  repoPath,
} from './repo.js';

const workspaceGlobs = parse(readText('pnpm-workspace.yaml')) as { packages: string[] };
const workspacePackages = findWorkspacePackages(workspaceGlobs.packages);
const rootManifest = readPackageJson();

/** One CONTEXT.md term each README must use to describe its package's role. */
const ROLE_TERMS: Record<string, string> = {
  'apps/desktop': 'Runtime',
  'apps/store': 'Store',
  'packages/manifest': 'Manifest',
  'packages/gateway': 'Model Gateway',
  'packages/sdk': 'Harness',
  'examples/hello-web': 'UI Kind',
  'examples/hello-term': 'UI Kind',
};

const layoutDirs = Object.entries(P0_LAYOUT).flatMap(([parent, names]) =>
  names.map((name) => `${parent}/${name}`),
);

describe('P0 workspace layout', () => {
  it.each(Object.entries(P0_LAYOUT))(
    '%s/ contains exactly the P0 package directories',
    (parent, names) => {
      expect(listDirectories(parent)).toEqual([...names].sort());
      // No stray files either: `ls apps packages examples` shows only the packages.
      expect(readdirSync(repoPath(parent)).sort()).toEqual([...names].sort());
    },
  );

  it.each(layoutDirs)('%s has a package.json and a README.md describing its purpose', (dir) => {
    expect(existsSync(repoPath(dir, 'package.json'))).toBe(true);
    const readme = readText(dir, 'README.md');
    expect(readme).toMatch(/^# \S/);
    expect(readme.length).toBeGreaterThan(200);
    const term = ROLE_TERMS[dir];
    expect(term, `no role term registered for ${dir}`).toBeDefined();
    expect(readme).toContain(term);
  });

  it('keeps test fixtures inside the package that owns them, never at the repo root', () => {
    expect(existsSync(repoPath('fixtures'))).toBe(false);
    expect(existsSync(repoPath('test', 'fixtures'))).toBe(false);
  });
});

describe('workspace package manifests', () => {
  it('discovers every P0 package through the workspace globs', () => {
    const dirs = workspacePackages.map((pkg) => pkg.dir);
    expect(dirs).toEqual(expect.arrayContaining(layoutDirs));
  });

  it('gives every package a unique name in the @harness-store scope', () => {
    const names = workspacePackages.map((pkg) => pkg.manifest.name);
    for (const name of names) expect(name).toMatch(/^@harness-store\/[a-z0-9-]+$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(workspacePackages.map((pkg) => [pkg.dir, pkg] as const))(
    '%s pins the same Node LTS range in engines.node as the root',
    (_dir, pkg) => {
      expect(rootManifest.engines?.node).toEqual(expect.any(String));
      expect(pkg.manifest.engines?.node).toBe(rootManifest.engines?.node);
    },
  );

  it.each(workspacePackages.map((pkg) => [pkg.dir, pkg] as const))(
    '%s defines a test script, so the root `pnpm test` never silently skips it',
    (_dir, pkg) => {
      expect(pkg.manifest.scripts?.test).toEqual(expect.any(String));
      expect(pkg.manifest.scripts?.test?.trim()).not.toBe('');
    },
  );
});
