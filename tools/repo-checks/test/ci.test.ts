import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readPackageJson, readText, ROOT_COMMANDS } from './repo.js';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}

interface Job {
  'runs-on'?: string;
  'continue-on-error'?: unknown;
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, unknown> | string[] | string;
  jobs?: Record<string, Job>;
}

const workflow = parse(readText('.github', 'workflows', 'ci.yml')) as Workflow;
const rootManifest = readPackageJson();
const jobs = Object.entries(workflow.jobs ?? {});
const steps = jobs.flatMap(([, job]) => job.steps ?? []);
const runCommands = steps.flatMap((step) => (step.run ? [step.run.trim()] : []));

describe('CI workflow', () => {
  it('runs on every push and every pull request, without branch or path filters', () => {
    const on = workflow.on;
    expect(on).toBeDefined();
    const events = Array.isArray(on) ? on : typeof on === 'string' ? [on] : Object.keys(on ?? {});
    expect(events).toEqual(expect.arrayContaining(['push', 'pull_request']));
    if (on && !Array.isArray(on) && typeof on === 'object') {
      // `push:` / `pull_request:` with no filters parse as null.
      expect(on.push ?? null).toBeNull();
      expect(on.pull_request ?? null).toBeNull();
    }
  });

  it('runs exactly the root install, lint, typecheck, test and build commands, in that order', () => {
    expect(runCommands).toEqual([
      'pnpm install --frozen-lockfile',
      ...ROOT_COMMANDS.map((command) => `pnpm ${command}`),
    ]);
  });

  it('only invokes commands that exist as root scripts (no hand-rolled subset)', () => {
    for (const command of ROOT_COMMANDS) {
      expect(rootManifest.scripts?.[command], `root script "${command}"`).toEqual(
        expect.any(String),
      );
    }
  });

  it('fails the build when any step fails', () => {
    for (const [name, job] of jobs) {
      expect(job['continue-on-error'], `job ${name}`).toBeUndefined();
      for (const step of job.steps ?? []) {
        expect(step['continue-on-error'], step.name ?? step.run ?? step.uses).toBeUndefined();
      }
    }
    for (const command of runCommands) expect(command).not.toMatch(/\|\|\s*(true|:|exit 0)/);
  });

  it('takes Node from .nvmrc and pnpm from packageManager, like a local checkout', () => {
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['node-version-file']).toBe('.nvmrc');
    expect(setupNode?.with).not.toHaveProperty('node-version');

    const setupPnpm = steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'));
    expect(setupPnpm).toBeDefined();
    // No `version` input: the action reads package.json#packageManager.
    expect(setupPnpm?.with?.version).toBeUndefined();

    const setupPnpmIndex = steps.indexOf(setupPnpm ?? {});
    const installIndex = steps.findIndex((step) => step.run?.startsWith('pnpm install'));
    expect(setupPnpmIndex).toBeGreaterThanOrEqual(0);
    expect(setupPnpmIndex).toBeLessThan(installIndex);
  });
});
