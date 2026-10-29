import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readPackageJson, readText, repoPath, ROOT_COMMANDS } from './repo.js';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}

interface Job {
  'runs-on'?: string;
  needs?: string | string[];
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> };
  'continue-on-error'?: unknown;
  env?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, unknown> | string[] | string;
  jobs?: Record<string, Job>;
}

const readWorkflow = (file: string) => parse(readText('.github', 'workflows', file)) as Workflow;
const workflow = readWorkflow('ci.yml');
const nightly = readWorkflow('nightly.yml');
const rootManifest = readPackageJson();
const jobs = Object.entries(workflow.jobs ?? {});
const steps = jobs.flatMap(([, job]) => job.steps ?? []);
const runCommands = steps.flatMap((step) => (step.run ? [step.run.trim()] : []));
const commandsOf = (job: string, from = workflow) =>
  (from.jobs?.[job]?.steps ?? []).flatMap((step) => (step.run ? [step.run.trim()] : []));
const eventsOf = (from: Workflow) => {
  const on = from.on;
  return Array.isArray(on) ? on : typeof on === 'string' ? [on] : Object.keys(on ?? {});
};

/** The jobs of `ci`, in workflow order. P0-13.2 appends the Desktop E2E jobs. */
const CI_JOBS = [
  'lint-typecheck',
  'unit',
  'gateway-conformance',
  'store-tests',
  'supervisor-tests',
];

/** Runs the local parity script (scripts/ci-local.mjs) with `args`, which never start a job. */
const ciLocal = (...args: string[]) =>
  spawnSync(process.execPath, [repoPath('scripts', 'ci-local.mjs'), ...args], {
    encoding: 'utf8',
  });

describe('CI workflow', () => {
  it('runs on every push and every pull request, without branch or path filters', () => {
    const on = workflow.on;
    expect(on).toBeDefined();
    expect(eventsOf(workflow)).toEqual(expect.arrayContaining(['push', 'pull_request']));
    if (on && !Array.isArray(on) && typeof on === 'object') {
      // `push:` / `pull_request:` with no filters parse as null.
      expect(on.push ?? null).toBeNull();
      expect(on.pull_request ?? null).toBeNull();
    }
  });

  it('has the job graph of P0-13: lint-typecheck first, every other job needing it alone', () => {
    expect(Object.keys(workflow.jobs ?? {})).toEqual(CI_JOBS);
    expect(workflow.jobs?.['lint-typecheck']?.needs).toBeUndefined();
    for (const name of CI_JOBS.slice(1)) {
      // A failed lint-typecheck skips the job; nothing else orders the jobs, so they fan out.
      const needs = workflow.jobs?.[name]?.needs;
      expect([needs].flat(), `job ${name}`).toEqual(['lint-typecheck']);
    }
  });

  it('every job installs from the lockfile and builds before anything else', () => {
    for (const [name] of jobs) {
      expect(commandsOf(name).slice(0, 2), `job ${name}`).toEqual([
        'pnpm install --frozen-lockfile',
        'pnpm build',
      ]);
    }
  });

  it('lint-typecheck runs the root lint and typecheck, then the catalog check', () => {
    expect(commandsOf('lint-typecheck')).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm build',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm check:catalogs',
    ]);
    // The P0-04.2 parity test, which names each key missing from one of en and zh-CN.
    expect(rootManifest.scripts?.['check:catalogs']).toBe(
      'pnpm --filter @harness-store/desktop exec vitest run test/i18n/catalogs.test.ts',
    );
  });

  it('unit runs the root test command, which needs no Docker', () => {
    expect(commandsOf('unit')).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm build',
      'pnpm test',
    ]);
  });

  it('gateway-conformance runs the Gateway conformance suite, with no Provider secret', () => {
    expect(commandsOf('gateway-conformance').at(-1)).toBe(
      'pnpm --filter @harness-store/gateway exec vitest run conformance',
    );
    // No Provider secret reaches any ci job, so the live suite always skips there.
    expect(readText('.github', 'workflows', 'ci.yml')).not.toMatch(/\bsecrets\./);
    for (const [, job] of jobs) {
      expect(Object.keys(job.env ?? {}).filter((name) => name.startsWith('CONFORMANCE_'))).toEqual(
        [],
      );
    }
  });

  it('store-tests starts a local Supabase stack, runs the Store tests, and always stops it', () => {
    const commands = commandsOf('store-tests');
    const order = [
      'pnpm install --frozen-lockfile',
      'pnpm build',
      // The Supabase CLI through apps/store/scripts/supabase.ts, which fills in config.toml's
      // env(...) values (the GitHub provider of the sign-in tests).
      'node dist/scripts/supabase.js start',
      'pnpm run db:reset',
      'node dist/scripts/supabase.js functions serve',
      'pnpm run test:store',
      'node dist/scripts/supabase.js stop',
    ].map((prefix) => commands.findIndex((command) => command.includes(prefix)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const stop = workflow.jobs?.['store-tests']?.steps?.find((step) =>
      step.run?.includes('supabase.js stop'),
    );
    expect(stop).toMatchObject({ if: 'always()' });
  });

  it('supervisor-tests runs the Supervisor and installer tests on macOS, Windows and Linux, each on its own', () => {
    const job = workflow.jobs?.['supervisor-tests'];
    expect(job?.strategy?.matrix?.os).toEqual(['macos-latest', 'windows-latest', 'ubuntu-latest']);
    expect(job?.['runs-on']).toBe('${{ matrix.os }}');
    expect(job?.strategy?.['fail-fast']).toBe(false);
    expect(commandsOf('supervisor-tests').slice(2)).toEqual([
      'pnpm --filter @harness-store/desktop run test:launch',
      'pnpm --filter @harness-store/desktop run test:install',
    ]);
  });

  it('only invokes commands that exist as root scripts (no hand-rolled subset)', () => {
    for (const command of [...ROOT_COMMANDS, 'check:catalogs']) {
      expect(rootManifest.scripts?.[command], `root script "${command}"`).toEqual(
        expect.any(String),
      );
    }
  });

  it('fails the build when any step fails', () => {
    for (const [name, job] of [...jobs, ...Object.entries(nightly.jobs ?? {})]) {
      expect(job['continue-on-error'], `job ${name}`).toBeUndefined();
      for (const step of job.steps ?? []) {
        expect(step['continue-on-error'], step.name ?? step.run ?? step.uses).toBeUndefined();
      }
    }
    for (const command of runCommands) expect(command).not.toMatch(/\|\|\s*(true|:|exit 0)/);
  });

  it('takes Node from .nvmrc and pnpm from packageManager in every job, like a local checkout', () => {
    for (const [name, job] of [...jobs, ...Object.entries(nightly.jobs ?? {})]) {
      const jobSteps = job.steps ?? [];
      const setupNode = jobSteps.find((step) => step.uses?.startsWith('actions/setup-node@'));
      expect(setupNode?.with?.['node-version-file'], `job ${name}`).toBe('.nvmrc');
      expect(setupNode?.with).not.toHaveProperty('node-version');
      // The pnpm store cache, keyed on pnpm-lock.yaml.
      expect(setupNode?.with?.cache, `job ${name}`).toBe('pnpm');

      const setupPnpm = jobSteps.find((step) => step.uses?.startsWith('pnpm/action-setup@'));
      expect(setupPnpm, `job ${name}`).toBeDefined();
      // No `version` input: the action reads package.json#packageManager.
      expect(setupPnpm?.with?.version).toBeUndefined();

      const setupPnpmIndex = jobSteps.indexOf(setupPnpm ?? {});
      const installIndex = jobSteps.findIndex((step) => step.run?.startsWith('pnpm install'));
      expect(setupPnpmIndex).toBeGreaterThanOrEqual(0);
      expect(setupPnpmIndex).toBeLessThan(installIndex);
    }
  });
});

describe('nightly workflow', () => {
  const job = nightly.jobs?.['gateway-conformance'];

  it('runs on a schedule and on demand only, never on a push or a pull request', () => {
    expect(eventsOf(nightly).sort()).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('runs the live Gateway conformance suite with the CONFORMANCE_* repository secrets', () => {
    expect(Object.keys(nightly.jobs ?? {})).toEqual(['gateway-conformance']);
    expect(commandsOf('gateway-conformance', nightly).at(-1)).toBe(
      'pnpm --filter @harness-store/gateway exec vitest run conformance-live',
    );
    // Each variable conformance-live.test.ts reads, from the secret or variable of its own name.
    const live = readText('packages', 'gateway', 'test', 'conformance-live.test.ts');
    const read = [...live.matchAll(/env\('([A-Z_]+)'\)/g)].map(
      (match) => `CONFORMANCE_${match[1] ?? ''}`,
    );
    expect(Object.keys(job?.env ?? {}).sort()).toEqual([...new Set(read)].sort());
    for (const [name, value] of Object.entries(job?.env ?? {})) {
      expect(value).toMatch(new RegExp(`^\\$\\{\\{ (secrets|vars)\\.${name} \\}\\}$`));
    }
    for (const name of ['CONFORMANCE_ANTHROPIC_API_KEY', 'CONFORMANCE_OPENAI_API_KEY']) {
      expect(job?.env?.[name]).toBe(`\${{ secrets.${name} }}`);
    }
  });
});

describe('local CI parity (pnpm ci:local)', () => {
  it('is a root script that runs scripts/ci-local.mjs, linted with the root files', () => {
    expect(rootManifest.scripts?.['ci:local']).toBe('node scripts/ci-local.mjs');
    expect(rootManifest.scripts?.['lint:root']).toContain('"scripts/*.mjs"');
  });

  it('has a job for each ci job, under the same name and in the same order', () => {
    const result = ciLocal('--list');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(CI_JOBS);
  });

  it('refuses a job name ci does not have, naming it, before running anything', () => {
    const result = ciLocal('lint-typecheck', 'e2e');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown job e2e');
    expect(result.stdout).not.toContain('$ ');
  });

  it('runs the same commands as each ci job', () => {
    const script = readText('scripts', 'ci-local.mjs');
    // Each command after install and build, as the script spells it.
    for (const job of ['lint-typecheck', 'unit', 'gateway-conformance', 'supervisor-tests']) {
      for (const command of commandsOf(job).slice(2)) {
        const args = command.replace(/^pnpm /, '').split(' ');
        expect(script, `${job}: ${command}`).toContain(
          `pnpm([${args.map((arg) => `'${arg}'`).join(', ')}])`,
        );
      }
    }
  });
});
