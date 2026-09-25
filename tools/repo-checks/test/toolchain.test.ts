import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Linter } from 'eslint';
import * as prettier from 'prettier';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  findWorkspacePackages,
  readPackageJson,
  readText,
  repoPath,
  repoRoot,
  walkRepoFiles,
  type PackageJson,
} from './repo.js';

const rootManifest = readPackageJson();
const workspaceGlobs = (parse(readText('pnpm-workspace.yaml')) as { packages: string[] }).packages;
const workspacePackages = findWorkspacePackages(workspaceGlobs);
/** A TypeScript package is one with its own tsconfig.json; apps/store (Deno) has none. */
const typeScriptPackages = workspacePackages.filter((pkg) =>
  existsSync(join(pkg.path, 'tsconfig.json')),
);
const tsCases = typeScriptPackages.map((pkg) => [pkg.dir, pkg] as const);

interface TsConfig {
  extends?: string;
  files?: string[];
  include?: string[];
  references?: { path: string }[];
  compilerOptions?: Record<string, unknown>;
}

/** Reads a tsconfig with TypeScript's own (comment-tolerant) parser. */
function readTsConfig(path: string): TsConfig {
  const result = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (result.error) {
    throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText, '\n'));
  }
  return result.config as TsConfig;
}

/** Fully resolved compiler options after following `extends`. */
function resolvedOptions(path: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(path, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error(`Cannot parse ${path}`);
  return parsed.options;
}

function allDependencies(manifest: PackageJson): string[] {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  });
}

describe('Node LTS pin', () => {
  const nvmrc = readText('.nvmrc').trim();
  const engines = rootManifest.engines?.node ?? '';

  it('pins the same Node major in .nvmrc and engines.node', () => {
    expect(nvmrc).toMatch(/^\d+$/);
    const minimum = /^>=(\d+)\.\d+\.\d+$/.exec(engines);
    expect(minimum, `engines.node "${engines}" should be a ">=x.y.z" floor`).not.toBeNull();
    expect(minimum?.[1]).toBe(nvmrc);
  });

  it('pins an even-numbered (LTS) Node major', () => {
    expect(Number(nvmrc) % 2).toBe(0);
  });

  it('is running on a Node that satisfies engines.node', () => {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    const [, floorMajor = '0', floorMinor = '0'] = /^>=(\d+)\.(\d+)/.exec(engines) ?? [];
    const [minMajor, minMinor] = [Number(floorMajor), Number(floorMinor)];
    expect(major > minMajor || (major === minMajor && minor >= minMinor)).toBe(true);
  });
});

describe('TypeScript configuration', () => {
  it('enables strict mode in the shared tsconfig.base.json', () => {
    const base = readTsConfig(repoPath('tsconfig.base.json'));
    expect(base.compilerOptions).toMatchObject({ strict: true, noUncheckedIndexedAccess: true });
  });

  it.each(tsCases)('%s extends the shared base config and stays strict', (_dir, pkg) => {
    for (const file of ['tsconfig.json', 'tsconfig.build.json']) {
      const path = join(pkg.path, file);
      if (!existsSync(path)) continue;
      expect(readTsConfig(path).extends).toBe('../../tsconfig.base.json');
      const options = resolvedOptions(path);
      expect(options.strict).toBe(true);
      for (const flag of ['noImplicitAny', 'strictNullChecks', 'strictFunctionTypes'] as const) {
        expect(options[flag], `${pkg.dir}/${file} must not relax ${flag}`).not.toBe(false);
      }
    }
  });

  it('builds the project references graph from the root tsconfig.json', () => {
    const solution = readTsConfig(repoPath('tsconfig.json'));
    expect(solution.files).toEqual([]);
    const references = solution.references ?? [];
    expect(references.length).toBeGreaterThan(0);
    for (const { path } of references) {
      const target = repoPath(path.endsWith('.json') ? path : join(path, 'tsconfig.json'));
      expect(existsSync(target), `${path} does not exist`).toBe(true);
      expect(resolvedOptions(target).composite, `${path} must be composite`).toBe(true);
    }
  });

  it('keeps apps/store (Deno Edge Functions) out of the project references graph', () => {
    const references = readTsConfig(repoPath('tsconfig.json')).references ?? [];
    expect(references.map(({ path }) => path).filter((p) => p.startsWith('apps/store'))).toEqual(
      [],
    );
    expect(existsSync(repoPath('apps', 'store', 'tsconfig.json'))).toBe(false);
  });
});

describe('scripts of TypeScript packages', () => {
  it('covers every P0 TypeScript package', () => {
    expect(typeScriptPackages.map((pkg) => pkg.dir)).toEqual(
      expect.arrayContaining([
        'apps/desktop',
        'examples/hello-term',
        'examples/hello-web',
        'packages/gateway',
        'packages/manifest',
        'packages/sdk',
      ]),
    );
  });

  it.each(tsCases)('%s wires lint, typecheck and test to the shared tools', (_dir, pkg) => {
    const scripts = pkg.manifest.scripts ?? {};
    expect(scripts.lint).toMatch(/^eslint\b/);
    expect(scripts.typecheck).toMatch(/^tsc\b/);
    expect(scripts.test).toMatch(/^vitest run\b/);
    if (existsSync(join(pkg.path, 'tsconfig.build.json'))) {
      expect(scripts.build).toMatch(/^tsc --build tsconfig\.build\.json\b/);
    }
  });
});

describe('ESLint configuration', () => {
  it.each(tsCases)('%s extends the shared root ESLint config', async (_dir, pkg) => {
    const configPath = join(pkg.path, 'eslint.config.js');
    expect(existsSync(configPath)).toBe(true);
    expect(readText(pkg.dir, 'eslint.config.js')).toContain("from '../../eslint.config.js'");

    const load = async (path: string) =>
      ((await import(pathToFileURL(path).href)) as { default: Linter.Config[] }).default;
    const root = await load(repoPath('eslint.config.js'));
    const local = await load(configPath);
    // Extended, not copied: every shared config object is present by identity.
    for (const entry of root) expect(local).toContain(entry);
  });
});

describe('Prettier configuration', () => {
  const prettierConfigNames = [
    /^\.prettierrc(\..+)?$/,
    /^prettier\.config\.[cm]?[jt]s$/,
    /^\.prettierrc\.[cm]?[jt]s$/,
  ];

  it.each(workspacePackages.map((pkg) => [pkg.dir, pkg] as const))(
    '%s inherits the root Prettier config instead of copying it',
    async (_dir, pkg) => {
      const local = readdirSync(pkg.path).filter((name) =>
        prettierConfigNames.some((pattern) => pattern.test(name)),
      );
      expect(local).toEqual([]);
      expect(pkg.manifest.prettier).toBeUndefined();
      const resolved = await prettier.resolveConfigFile(join(pkg.path, 'package.json'));
      expect(resolved).toBe(repoPath('.prettierrc.json'));
    },
  );
});

describe('single test runner and single-language stack (ADR-0003)', () => {
  const manifests = [
    { dir: '.', manifest: rootManifest },
    ...workspacePackages.map(({ dir, manifest }) => ({ dir, manifest })),
  ];
  const files = walkRepoFiles();

  it('uses Vitest everywhere and never another test runner', () => {
    const forbidden = /^(jest|@jest\/.*|ts-jest|babel-jest|mocha|ava|jasmine|tap|uvu)$/;
    for (const { dir, manifest } of manifests) {
      expect(
        allDependencies(manifest).filter((dep) => forbidden.test(dep)),
        dir,
      ).toEqual([]);
    }
    expect(files.filter((file) => /(^|\/)jest\.config\.[cm]?[jt]s$/.test(file))).toEqual([]);
  });

  it('contains no Rust or Python sources or project files', () => {
    // Fixture directories hold test data (e.g. a rejected `python` Harness Package),
    // not code this repository builds or runs.
    const offenders = files.filter(
      (file) =>
        !/(^|\/)fixtures\//.test(file) &&
        /(\.rs|\.py|(^|\/)Cargo\.toml|(^|\/)pyproject\.toml|(^|\/)requirements\.txt)$/.test(file),
    );
    expect(offenders).toEqual([]);
  });

  it('depends on no second desktop or UI framework', () => {
    const forbidden =
      /^(@tauri-apps\/.*|tauri|vue|svelte|@angular\/core|solid-js|preact|lit|nw|neutralinojs)$/;
    for (const { dir, manifest } of manifests) {
      expect(
        allDependencies(manifest).filter((dep) => forbidden.test(dep)),
        dir,
      ).toEqual([]);
    }
  });
});

describe('repository hygiene', () => {
  const isIgnored = (path: string): boolean =>
    spawnSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: repoRoot }).status ===
    0;

  it.each([
    'node_modules/x',
    'packages/manifest/node_modules/x',
    'packages/manifest/dist/index.js',
    'packages/manifest/coverage/index.html',
    'packages/manifest/dist/tsconfig.build.tsbuildinfo',
    'packages/manifest/tsconfig.tsbuildinfo',
  ])('git-ignores generated file %s', (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each(['pnpm-lock.yaml', 'packages/manifest/fixtures/valid-minimal-node/manifest.json'])(
    'does not git-ignore %s',
    (path) => {
      expect(isIgnored(path)).toBe(false);
    },
  );

  it('keeps the pnpm lockfile at the repo root', () => {
    expect(existsSync(repoPath('pnpm-lock.yaml'))).toBe(true);
  });
});
