import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment variable that points the checks at another checkout. Only the
 * regression tests set it, to run a check file against a scratch copy of the repo.
 */
export const REPO_ROOT_ENV = 'REPO_CHECKS_ROOT';

/**
 * Absolute path of the monorepo root, with a trailing separator. By default the
 * checkout this file lives in (tools/repo-checks/test/).
 */
export const repoRoot = process.env[REPO_ROOT_ENV]
  ? join(resolve(process.env[REPO_ROOT_ENV]), sep)
  : fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The P0 layout required by P0-01.1. These package directories must always exist;
 * later packages are added alongside them without editing this list.
 */
export const P0_LAYOUT = {
  apps: ['desktop', 'store'],
  packages: ['gateway', 'manifest', 'sdk'],
  examples: ['hello-term', 'hello-web'],
} as const;

/** Workspace globs every product package must live under. */
export const LAYOUT_GLOBS = Object.keys(P0_LAYOUT).map((dir) => `${dir}/*`);

/** The four root commands a developer and CI both run. */
export const ROOT_COMMANDS = ['lint', 'typecheck', 'test', 'build'] as const;

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  prettier?: unknown;
}

export interface WorkspacePackage {
  /** Directory relative to the repo root, always with forward slashes (e.g. `packages/manifest`). */
  dir: string;
  /** Absolute directory. */
  path: string;
  manifest: PackageJson;
}

export function repoPath(...segments: string[]): string {
  return join(repoRoot, ...segments);
}

export function readText(...segments: string[]): string {
  return readFileSync(repoPath(...segments), 'utf8');
}

export function readJson(...segments: string[]): unknown {
  return JSON.parse(readText(...segments));
}

export function readPackageJson(...segments: string[]): PackageJson {
  return readJson(...segments, 'package.json') as PackageJson;
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function listDirectories(...segments: string[]): string[] {
  return readdirSync(repoPath(...segments), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every workspace package on disk: each directory matched by a `<dir>/*` glob in
 * pnpm-workspace.yaml that contains a package.json. Mirrors how pnpm discovers them.
 */
export function findWorkspacePackages(globs: readonly string[]): WorkspacePackage[] {
  const found: WorkspacePackage[] = [];
  for (const glob of globs) {
    if (!glob.endsWith('/*') || glob.slice(0, -2).includes('*')) {
      throw new Error(`Unsupported workspace glob in this check: ${glob}`);
    }
    const parent = glob.slice(0, -2);
    if (!existsSync(repoPath(parent))) continue;
    for (const name of listDirectories(parent)) {
      const dir = `${parent}/${name}`;
      if (!existsSync(repoPath(dir, 'package.json'))) continue;
      found.push({ dir, path: repoPath(dir), manifest: readPackageJson(dir) });
    }
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Walks the repository, skipping VCS metadata, dependencies and build output. */
export function walkRepoFiles(): string[] {
  const skip = new Set(['.git', 'node_modules', 'dist', 'coverage']);
  const files: string[] = [];
  const visit = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (statSync(child).isFile()) files.push(toPosix(relative(repoRoot, child)));
    }
  };
  visit(repoRoot);
  return files.sort();
}

/**
 * Environment for a nested pnpm: the parent pnpm's `npm_*` / `pnpm_*` variables are
 * dropped so the child resolves its own workspace and config from `cwd`.
 */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(npm|pnpm)_/i.test(key)),
  );
}

/** Runs pnpm (the same binary that launched this test run, when there is one). */
export function runPnpm(args: string[], cwd: string): SpawnSyncReturns<string> {
  const execPath = process.env.npm_execpath;
  const options = { cwd, encoding: 'utf8' as const, env: childEnv(), timeout: 120_000 };
  if (execPath && /pnpm\.c?js$/.test(execPath)) {
    return spawnSync(process.execPath, [execPath, ...args], options);
  }
  return spawnSync('pnpm', args, { ...options, shell: process.platform === 'win32' });
}
