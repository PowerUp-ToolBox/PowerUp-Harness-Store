import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readPackageJson, readText, repoPath, ROOT_COMMANDS } from './repo.js';

interface Step {
  name?: string;
  env?: Record<string, string>;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}

interface Job {
  name?: string;
  'runs-on'?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> };
  'continue-on-error'?: unknown;
  env?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, unknown> | string[] | string;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const readWorkflow = (file: string) => parse(readText('.github', 'workflows', file)) as Workflow;
const workflow = readWorkflow('ci.yml');
const nightly = readWorkflow('nightly.yml');
const build = readWorkflow('build.yml');
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

/** Provider credentials a developer may have exported, which no ci:local command may get. */
const CONFORMANCE_ENV = {
  CONFORMANCE_OPENAI_API_KEY: 'sk-from-the-shell',
  CONFORMANCE_ANTHROPIC_API_KEY: 'sk-ant-from-the-shell',
  CONFORMANCE_OPENAI_COMPATIBLE_BASE_URL: 'https://provider.example/v1',
};

/** The jobs of `ci`, in workflow order. */
const CI_JOBS = [
  'lint-typecheck',
  'unit',
  'gateway-conformance',
  'store-tests',
  'supervisor-tests',
  'e2e-smoke',
  'acceptance',
];

/** Runs the local parity script (scripts/ci-local.mjs) with `args`, which never start a job. */
const ciLocal = (...args: string[]) =>
  spawnSync(process.execPath, [repoPath('scripts', 'ci-local.mjs'), ...args], {
    encoding: 'utf8',
  });

/**
 * A scratch folder with a fake pnpm (`pnpm.cjs`, which ci-local runs as the pnpm that started it)
 * and a fake `docker` on PATH, each logging its arguments and the GitHub provider variables to
 * `log`, with the names of the CONFORMANCE_* variables it got. The fake pnpm exits 0, or ends by SIGINT as Ctrl-C would, sent to ci-local too, when its
 * first argument is `interruptAt`. The fake docker always fails, so `store-tests` stops before it
 * reaches the Supabase CLI and a stack the developer runs.
 */
function fakeTools(interruptAt?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-local-'));
  const log = join(dir, 'log');
  const record = `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool, args: process.argv.slice(2), githubClientId: process.env.SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID ?? null, githubUrl: process.env.SUPABASE_AUTH_EXTERNAL_GITHUB_URL ?? null, conformance: Object.keys(process.env).filter((name) => name.startsWith('CONFORMANCE_')) }) + '\\n');`;
  writeFileSync(
    join(dir, 'pnpm.cjs'),
    `const tool = 'pnpm';\n${record}\n` +
      `if (process.argv[2] === ${JSON.stringify(interruptAt ?? null)}) {\n` +
      `  process.kill(process.ppid, 'SIGINT');\n  process.kill(process.pid, 'SIGINT');\n}\n`,
  );
  writeFileSync(
    join(dir, 'docker'),
    `#!/usr/bin/env node\nconst tool = 'docker';\n${record}\nprocess.exitCode = 1;\n`,
  );
  chmodSync(join(dir, 'docker'), 0o755);
  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            tool: string;
            args: string[];
            githubClientId: string | null;
            githubUrl: string | null;
            conformance: string[];
          },
      );
  const runCiLocal = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [repoPath('scripts', 'ci-local.mjs'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        npm_execpath: join(dir, 'pnpm.cjs'),
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
      },
    });
  return { dir, calls, runCiLocal };
}

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

  it('e2e-smoke runs the Store-less Desktop E2E journey on macOS, Windows and Linux, each on its own', () => {
    const job = workflow.jobs?.['e2e-smoke'];
    expect(job?.strategy?.matrix?.os).toEqual(['macos-latest', 'windows-latest', 'ubuntu-latest']);
    expect(job?.['runs-on']).toBe('${{ matrix.os }}');
    expect(job?.strategy?.['fail-fast']).toBe(false);
    const journey = commandsOf('e2e-smoke').find((command) => command.includes('e2e:smoke'));
    // On a virtual display on Linux, as is everywhere else.
    expect(journey).toContain('xvfb-run -a pnpm --filter @harness-store/desktop run e2e:smoke');
    expect(journey).toContain('\n  pnpm --filter @harness-store/desktop run e2e:smoke');
  });

  it('acceptance runs the acceptance journey on Linux, with a keyring for the session and a virtual display', () => {
    const job = workflow.jobs?.acceptance;
    expect(job?.['runs-on']).toBe('ubuntu-latest');
    const journey = commandsOf('acceptance').find((command) => command.includes('e2e:acceptance'));
    expect(journey).toMatch(/^dbus-run-session -- /);
    expect(journey).toContain('gnome-keyring-daemon --unlock --components=secrets');
    expect(journey).toContain(
      'xvfb-run -a pnpm --filter @harness-store/desktop run e2e:acceptance',
    );
  });

  it('the Desktop E2E jobs keep the Electron sandbox, list flaky journeys and upload traces on failure', () => {
    // The sandbox is allowed on the runner (Ubuntu 24.04 restricts user namespaces), never turned off.
    for (const command of runCommands) expect(command).not.toContain('--no-sandbox');
    const app = readText('apps', 'desktop', 'e2e', 'support', 'app.ts');
    expect(app).not.toContain('--no-sandbox');
    // Playwright adds --no-sandbox to an Electron launch on Linux unless told not to.
    expect(app).toContain('chromiumSandbox: true,');
    expect(app).toContain("commandLine.hasSwitch('no-sandbox')");
    for (const name of ['e2e-smoke', 'acceptance']) {
      const jobSteps = workflow.jobs?.[name]?.steps ?? [];
      const sandbox = jobSteps.find((step) => step.run?.includes('apparmor_restrict_unprivileged'));
      expect(sandbox?.run, name).toBe(
        'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
      );
      expect(
        jobSteps.find((step) => step.run === 'node apps/desktop/scripts/e2e-summary.mjs'),
        name,
      ).toMatchObject({ if: 'always()' });
      const upload = jobSteps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
      expect(upload, name).toMatchObject({ if: 'failure()' });
      expect(upload?.with?.path, name).toBe('apps/desktop/e2e/test-results/');
    }
  });

  it('the Desktop E2E records its own trace and screenshot, which Playwright does not for Electron', () => {
    // `use.trace` and `use.screenshot` only reach browsers Playwright launches, so they would
    // promise artifacts an `_electron` journey never writes.
    const config = readText('apps', 'desktop', 'e2e', 'playwright.config.ts');
    expect(config).not.toMatch(/^\s*(trace|screenshot):/m);
    const app = readText('apps', 'desktop', 'e2e', 'support', 'app.ts');
    expect(app).toContain('.context().tracing.start(');
    expect(app).toContain("testInfo.outputPath('trace.zip')");
    expect(app).toContain("testInfo.outputPath('test-failed-1.png')");
    expect(app).toContain("testInfo.outputPath('profile-logs')");
  });

  it('the Playwright config retries once in CI only and gives each journey a 10-minute budget', () => {
    const config = readText('apps', 'desktop', 'e2e', 'playwright.config.ts');
    expect(config).toContain('retries: process.env.CI ? 1 : 0,');
    expect(config).toContain('timeout: 10 * 60_000,');
    expect(config).toContain("['json', { outputFile: 'test-results/results.json' }]");
    const desktop = readPackageJson('apps', 'desktop');
    expect(desktop.scripts?.['e2e:smoke']).toBe(
      'playwright test --config e2e/playwright.config.ts --project=smoke',
    );
    expect(desktop.scripts?.['e2e:acceptance']).toBe(
      'playwright test --config e2e/playwright.config.ts --project=acceptance',
    );
    // `pnpm e2e` builds first, as the journeys drive the built app; `pnpm test` never runs them.
    expect(rootManifest.scripts?.e2e).toBe(
      'pnpm build && pnpm --filter @harness-store/desktop run e2e',
    );
  });

  it('only invokes commands that exist as root scripts (no hand-rolled subset)', () => {
    for (const command of [...ROOT_COMMANDS, 'check:catalogs']) {
      expect(rootManifest.scripts?.[command], `root script "${command}"`).toEqual(
        expect.any(String),
      );
    }
  });

  it('fails the build when any step fails', () => {
    const allJobs = [
      ...jobs,
      ...Object.entries(nightly.jobs ?? {}),
      ...Object.entries(build.jobs ?? {}),
    ];
    for (const [name, job] of allJobs) {
      expect(job['continue-on-error'], `job ${name}`).toBeUndefined();
      for (const step of job.steps ?? []) {
        expect(step['continue-on-error'], step.name ?? step.run ?? step.uses).toBeUndefined();
        expect(step.run ?? '', step.name).not.toMatch(/\|\|\s*(true|:|exit 0)/);
      }
    }
  });

  it('takes Node from .nvmrc and pnpm from packageManager in every job, like a local checkout', () => {
    // build's `release` job only downloads the builds and runs gh: no Node, no install.
    const packageJob = build.jobs?.package;
    const nodeJobs = [
      ...jobs,
      ...Object.entries(nightly.jobs ?? {}),
      ...(packageJob ? [['package', packageJob] as const] : []),
    ];
    expect(nodeJobs.map(([name]) => name)).toContain('package');
    for (const [name, job] of nodeJobs) {
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

describe('required checks (README.md)', () => {
  it('names each ci check as GitHub lists it: the job name, once per matrix OS', () => {
    const readme = readText('README.md');
    const checks = jobs.flatMap(([id, job]) => {
      const name = job.name ?? id;
      const os = job.strategy?.matrix?.os;
      return Array.isArray(os)
        ? os.map((each) => name.replace('${{ matrix.os }}', String(each)))
        : [name];
    });
    expect(checks).toHaveLength(11);
    for (const check of checks) expect(readme, check).toContain(`| ${check} |`);
  });
});

describe('nightly workflow', () => {
  const job = nightly.jobs?.['gateway-conformance'];
  const conformance = job?.steps?.find((step) => step.name === 'Conformance');

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
    expect(Object.keys(conformance?.env ?? {}).sort()).toEqual([...new Set(read)].sort());
    for (const [name, value] of Object.entries(conformance?.env ?? {})) {
      expect(value).toMatch(new RegExp(`^\\$\\{\\{ (secrets|vars)\\.${name} \\}\\}$`));
    }
    for (const name of ['CONFORMANCE_ANTHROPIC_API_KEY', 'CONFORMANCE_OPENAI_API_KEY']) {
      expect(conformance?.env?.[name]).toBe(`\${{ secrets.${name} }}`);
    }
  });

  it('gives the value of a secret to the Conformance step alone, never to install or build', () => {
    // Job-level env would reach every step: the setup actions, dependency install scripts, builds.
    expect(job?.env).toBeUndefined();
    for (const step of job?.steps ?? []) {
      if (step === conformance) continue;
      for (const value of Object.values(step.env ?? {})) {
        // Elsewhere only whether a secret is set, never its value.
        if (value.includes('secrets.')) expect(value).toMatch(/^\$\{\{ .* != '' \}\}$/);
      }
      expect(JSON.stringify(step.with ?? {}), step.name).not.toContain('secrets.');
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

  // The fakes are a Node script with a shebang and a POSIX signal; repo-checks runs in `unit`, on
  // Linux, and locally on macOS or Linux.
  describe.skipIf(process.platform === 'win32')('with fake pnpm and docker', () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it.each([
      ['pnpm build', 'build', ['build']],
      ['the unit job', 'test', ['build', 'lint', 'typecheck', 'check:catalogs', 'test']],
    ])('after Ctrl-C during %s starts nothing else and exits 130', (_, at, ran) => {
      const tools = fakeTools(at);
      dirs.push(tools.dir);
      const result = tools.runCiLocal([]);
      expect(result.status, result.stderr).toBe(130);
      expect(tools.calls().map((call) => call.args[0])).toEqual(ran);
      expect(tools.calls().some((call) => call.tool === 'docker')).toBe(false);
      expect(result.stdout).toMatch(/skipped\s+supervisor-tests/);
    });

    it('gives no command a CONFORMANCE_* variable of the shell, so no job reaches a real Provider', () => {
      const tools = fakeTools();
      dirs.push(tools.dir);
      const result = tools.runCiLocal([], CONFORMANCE_ENV);
      // store-tests fails at the fake docker; every other job ran.
      expect(result.status, result.stderr).toBe(1);
      const calls = tools.calls();
      expect(calls.map((call) => call.args.join(' '))).toEqual(
        expect.arrayContaining([
          'build',
          'test',
          '--filter @harness-store/gateway exec vitest run conformance',
          'info',
        ]),
      );
      for (const call of calls) expect(call.conformance, call.args.join(' ')).toEqual([]);
    });

    it('runs store-tests with the fake GitHub of .env.example over a real OAuth app in the shell', () => {
      const tools = fakeTools();
      dirs.push(tools.dir);
      const result = tools.runCiLocal(['store-tests'], {
        SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID: 'a-real-oauth-app',
        SUPABASE_AUTH_EXTERNAL_GITHUB_URL: '',
      });
      expect(result.status).toBe(1);
      const docker = tools.calls().find((call) => call.tool === 'docker');
      expect(docker?.args).toEqual(['info']);
      expect(docker?.githubClientId).toBe('fake-github-client');
      expect(docker?.githubUrl).toBe('http://fake-github:8080');
    });

    it('without Docker fails acceptance, saying it needs Docker, before the journey starts', () => {
      const tools = fakeTools();
      dirs.push(tools.dir);
      const result = tools.runCiLocal(['acceptance']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('acceptance needs Docker');
      expect(tools.calls().map((call) => call.args.join(' '))).toEqual(['build', 'info']);
      expect(result.stdout).toMatch(/failed\s+acceptance/);
    });

    it('without Docker fails store-tests, saying it needs Docker, before any Supabase command', () => {
      const tools = fakeTools();
      dirs.push(tools.dir);
      const result = tools.runCiLocal(['store-tests']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('store-tests needs Docker');
      expect(result.stdout).not.toContain('supabase.js');
      expect(result.stdout).toMatch(/failed\s+store-tests/);
    });
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

  it('runs the same journeys as the Desktop E2E jobs', () => {
    const script = readText('scripts', 'ci-local.mjs');
    for (const job of ['e2e-smoke', 'acceptance']) {
      const journey = commandsOf(job).find((command) => command.includes(' run e2e:'));
      const name = /run (e2e:\w+)/.exec(journey ?? '')?.[1];
      expect(name, job).toBeDefined();
      expect(script, job).toContain(
        `pnpm(['--filter', '@harness-store/desktop', 'run', '${name ?? ''}'])`,
      );
    }
  });

  it('runs the same commands as the store-tests job', () => {
    const script = readText('scripts', 'ci-local.mjs');
    const commands = commandsOf('store-tests').slice(2);
    const supabase = (args: string) => `supabase([${args}]`;
    for (const command of commands) {
      const start = /^node dist\/scripts\/supabase\.js start -x (\S+)$/.exec(command);
      if (start) {
        // The same services left out, so the two cannot drift apart.
        expect(script).toContain(`const UNUSED_SERVICES = '${start[1] ?? ''}';`);
        expect(script).toContain(supabase(`'start', '-x', UNUSED_SERVICES`));
      } else if (command.startsWith('pnpm run ')) {
        const args = command.replace(/^pnpm /, '').split(' ');
        expect(script, command).toContain(
          `pnpm([${args.map((arg) => `'${arg}'`).join(', ')}], STORE, jobEnv)`,
        );
      } else if (command.includes('supabase.js functions serve')) {
        expect(script).toContain(`['dist/scripts/supabase.js', 'functions', 'serve']`);
        expect(script).toContain(`'Serving functions on'`);
      } else if (command.startsWith('node dist/scripts/supabase.js ')) {
        const args = command.replace(/^node dist\/scripts\/supabase\.js /, '').split(' ');
        expect(script, command).toContain(supabase(args.map((arg) => `'${arg}'`).join(', ')));
      } else {
        // Only the failure log is left; ci-local prints it with printLog().
        expect(command).toBe('cat "$RUNNER_TEMP/functions.log"');
      }
    }
    expect(commands.length).toBe(6);
  });
});

describe('build workflow', () => {
  const packageJob = build.jobs?.package;
  const release = build.jobs?.release;
  const packageSteps = packageJob?.steps ?? [];
  const stepIndex = (name: string) => packageSteps.findIndex((step) => step.name === name);

  it('runs on pushes to main, v* tags and on demand, never on a pull request', () => {
    expect(eventsOf(build).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(build.on).toMatchObject({ push: { branches: ['main'], tags: ['v*'] } });
    expect(Object.keys((build.on as { push: object }).push).sort()).toEqual(['branches', 'tags']);
  });

  it('has a package job and a release job, and may only write contents in the tag-gated release', () => {
    expect(Object.keys(build.jobs ?? {})).toEqual(['package', 'release']);
    expect(build.permissions).toEqual({ contents: 'read' });
    expect(packageJob?.permissions).toBeUndefined();
    expect(release?.permissions).toEqual({ contents: 'write' });
    expect(release?.if).toBe("startsWith(github.ref, 'refs/tags/v')");
    expect(release?.needs).toBe('package');
    // A draft, for the maintainer to publish, with the notes on opening an unsigned app.
    const create = commandsOf('release', build).find((command) =>
      command.includes('gh release create'),
    );
    expect(create).toContain('--draft');
    expect(create).toContain('--notes-file .github/release-notes.md');
  });

  it('packages each target on a runner of its own OS and architecture', () => {
    expect(packageJob?.['runs-on']).toBe('${{ matrix.os }}');
    expect(packageJob?.strategy?.['fail-fast']).toBe(false);
    const include = packageJob?.strategy?.matrix?.include as
      { name: string; os: string; arch: string }[] | undefined;
    expect(include?.map(({ name, os, arch }) => ({ name, os, arch }))).toEqual([
      { name: 'macos-arm64', os: 'macos-latest', arch: 'arm64' },
      { name: 'macos-x64', os: 'macos-15-intel', arch: 'x64' },
      { name: 'windows-x64', os: 'windows-latest', arch: 'x64' },
      { name: 'linux-x64', os: 'ubuntu-latest', arch: 'x64' },
    ]);
    const packaging = packageSteps.find((step) => step.name === 'Package')?.run ?? '';
    expect(packaging).toContain(
      'pnpm --filter @harness-store/desktop exec electron-builder --${{ matrix.arch }} --publish never',
    );
  });

  it('signs and notarises nothing', () => {
    expect(packageJob?.env?.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
    const text = readText('.github', 'workflows', 'build.yml')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(text).not.toMatch(/notari[sz]|codesign|CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|signtool/i);
    expect(text).not.toMatch(/\bsecrets\./);
  });

  it('installs, builds and packages, then smoke-runs the build before checking and uploading it', () => {
    expect(commandsOf('package', build).slice(0, 2)).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm build',
    ]);
    const order = ['Package', 'Smoke run', 'Check the build', 'Upload the build'].map(stepIndex);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const smoke = packageSteps[stepIndex('Smoke run')];
    expect(smoke?.if).toBeUndefined();
    expect(smoke?.run).toContain('xvfb-run -a pnpm --filter @harness-store/desktop run smoke');
    expect(smoke?.run).not.toContain('--no-sandbox');
    // The sandbox is allowed on the Linux runner before the app starts, never turned off.
    const sandbox = stepIndex('Allow the Electron sandbox');
    expect(packageSteps[sandbox]?.run).toBe(
      'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    );
    expect(sandbox).toBeLessThan(stepIndex('Smoke run'));
    expect(packageSteps[stepIndex('Upload the build')]?.with?.['if-no-files-found']).toBe('error');
  });
});
