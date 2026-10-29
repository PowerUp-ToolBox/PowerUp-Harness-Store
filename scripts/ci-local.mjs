#!/usr/bin/env node
/**
 * `pnpm ci:local [job ...]`: the jobs of .github/workflows/ci.yml run once on this machine, so a CI
 * failure reproduces without a push. With no job named it runs them all, in the order of the
 * workflow: `lint-typecheck` first, and when it fails the other jobs are skipped, as CI skips them.
 * The other jobs then run one after another and each passes or fails on its own. The OS matrix of
 * `supervisor-tests` is not repeated: it runs on this machine's OS only.
 *
 * Each run builds once first (CI builds in every job), with the dependencies already installed
 * (`pnpm install`). `store-tests` needs Docker: it stops a local Supabase stack left running,
 * starts it afresh, resets and seeds its database, serves the Edge Functions, runs the store
 * tests, and always stops the stack again, deleting its data (`stop --no-backup`), as the CI job
 * does. Its commands get the values of supabase/.env.example (Auth's GitHub provider pointed at
 * the fake GitHub of the sign-in tests) over any set in this shell or in supabase/.env, as CI has
 * no other: a real OAuth app configured there for manual testing would fail those tests.
 *
 * `e2e-smoke` and `acceptance` run the Desktop E2E journeys (apps/desktop/e2e) on the built app,
 * with the fake Provider as Ollama on port 11434 (set E2E_OLLAMA_PORT when a real Ollama has it);
 * `e2e-smoke` then runs the post-build smoke run on the unpackaged app (`smoke:unpackaged`). On
 * Windows, `supervisor-tests` and `e2e-smoke` first download the node.exe Node Harnesses run on
 * (`fetch-node`, kept in apps/desktop/vendor/), as CI does; elsewhere that does nothing.
 * `acceptance` needs Docker too: its Playwright setup restarts the local Supabase stack with the
 * fake GitHub, keeping its data, replaces the catalogue with the seed, and stops the stack again at
 * the end. On Linux run them under `xvfb-run` when there is no display.
 *
 * Commands get this shell's environment without any CONFORMANCE_* variable, so the Gateway
 * conformance suite never reaches a real Provider from here, as in `ci`; the E2E journeys pass the
 * app only the OS's own variables.
 *
 * Ctrl-C ends the command running and starts nothing else but the stop of the stack.
 *
 * Exit status: 0 when every job passed, 1 when one failed, 2 for an unknown job name, 130 after
 * Ctrl-C.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STORE = join(ROOT, 'apps', 'store');
/** The Supabase services the Store does not use, which the `store-tests` job does not start. */
const UNUSED_SERVICES = 'studio,imgproxy,postgres-meta,mailpit,logflare,vector,supavisor';
const FUNCTIONS_READY_MS = 120_000;

const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('CONFORMANCE_')),
);

/**
 * The environment of the `store-tests` commands: the variables of supabase/.env.example (`KEY=value`
 * lines) over `env`. The Supabase CLI reads supabase/.env only for a variable its environment does
 * not set, so these also win over a developer's own values there.
 */
function storeEnv() {
  const example = readFileSync(join(STORE, 'supabase', '.env.example'), 'utf8');
  const values = [...example.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/gm)];
  return { ...env, ...Object.fromEntries(values.map(([, key, value]) => [key, value.trim()])) };
}

/**
 * Set by Ctrl-C: the command running then ends, nothing else starts, and the stack is stopped.
 * The terminal sends SIGINT to the command running as well as to this script, whose listener runs
 * only once the event loop turns, which a spawnSync never lets it do: so a command that ends by
 * SIGINT sets it too, and the jobs loop yields to the event loop before each job.
 */
let interrupted = false;

/** Exit statuses of a command Ctrl-C ended: 128 + SIGINT, and Windows' STATUS_CONTROL_C_EXIT. */
const INTERRUPTED_STATUSES = [130, 0xc000013a];

/**
 * Runs a command with its output on this terminal, shown as `shown`; true when it exits 0. After
 * Ctrl-C only a command marked `always` (stopping the stack) still runs.
 */
function run(
  command,
  args,
  { cwd = ROOT, shown = [command, ...args], always = false, commandEnv = env } = {},
) {
  if (interrupted && !always) return false;
  console.log(`\n$ ${shown.join(' ')}${cwd === ROOT ? '' : `  (in ${cwd})`}`);
  const result = spawnSync(command, args, { cwd, env: commandEnv, stdio: 'inherit' });
  if (result.error !== undefined) console.error(result.error.message);
  if (result.signal === 'SIGINT' || INTERRUPTED_STATUSES.includes(result.status)) {
    interrupted = true;
  }
  return result.status === 0;
}

/** Runs pnpm: the one that started this script when there is one, as repo-checks does. */
function pnpm(args, cwd = ROOT, commandEnv = env) {
  const execPath = process.env.npm_execpath;
  const options = { cwd, shown: ['pnpm', ...args], commandEnv };
  if (execPath !== undefined && /pnpm\.c?js$/.test(execPath)) {
    return run(process.execPath, [execPath, ...args], options);
  }
  if (process.platform === 'win32') {
    return run('cmd.exe', ['/d', '/s', '/c', 'pnpm', ...args], options);
  }
  return run('pnpm', args, options);
}

/** Runs each step in order, stopping at the first that fails. */
const steps = (...each) => each.every((step) => step());

/** The CI jobs, in workflow order. Their ids are the job ids of ci.yml. */
const JOBS = [
  {
    id: 'lint-typecheck',
    run: () =>
      steps(
        () => pnpm(['lint']),
        () => pnpm(['typecheck']),
        () => pnpm(['check:catalogs']),
      ),
  },
  { id: 'unit', run: () => pnpm(['test']) },
  {
    id: 'gateway-conformance',
    run: () => pnpm(['--filter', '@harness-store/gateway', 'exec', 'vitest', 'run', 'conformance']),
  },
  { id: 'store-tests', run: storeTests },
  {
    id: 'supervisor-tests',
    run: () =>
      steps(
        () => pnpm(['--filter', '@harness-store/desktop', 'run', 'fetch-node']),
        () => pnpm(['--filter', '@harness-store/desktop', 'run', 'test:launch']),
        () => pnpm(['--filter', '@harness-store/desktop', 'run', 'test:install']),
      ),
  },
  {
    id: 'e2e-smoke',
    run: () =>
      steps(
        () => pnpm(['--filter', '@harness-store/desktop', 'run', 'fetch-node']),
        () => pnpm(['--filter', '@harness-store/desktop', 'run', 'e2e:smoke']),
        () => pnpm(['--filter', '@harness-store/desktop', 'run', 'smoke:unpackaged']),
      ),
  },
  {
    id: 'acceptance',
    run: () =>
      hasDocker('acceptance') &&
      pnpm(['--filter', '@harness-store/desktop', 'run', 'e2e:acceptance']),
  },
];

/** Whether Docker runs (asked with `commandEnv`); when not, says that `job` needs it. */
function hasDocker(job, commandEnv = env) {
  if (spawnSync('docker', ['info'], { env: commandEnv, stdio: 'ignore' }).status === 0) return true;
  console.error(
    `\n${job} needs Docker, which is not running or not installed: start Docker and run ` +
      `\`pnpm ci:local ${job}\` again.`,
  );
  return false;
}

async function storeTests() {
  const jobEnv = storeEnv();
  /** The apps/store wrapper around the pinned Supabase CLI (scripts/supabase.ts). */
  const supabase = (args, always = false) =>
    run(process.execPath, ['dist/scripts/supabase.js', ...args], {
      cwd: STORE,
      shown: ['node', 'dist/scripts/supabase.js', ...args],
      always,
      commandEnv: jobEnv,
    });
  if (!hasDocker('store-tests', jobEnv)) return false;
  let functions;
  try {
    console.log(
      '\nstore-tests stops the local Supabase stack and deletes its data, now and at the end.',
    );
    // A stack left running, and any `functions serve` attached to it, would be reused or would
    // stop the Edge Runtime this job starts; CI starts from nothing, so start from nothing here.
    if (!supabase(['stop', '--no-backup'])) return false;
    if (!supabase(['start', '-x', UNUSED_SERVICES])) return false;
    // Applies the migrations from empty once more, then runs the seed script.
    if (!pnpm(['run', 'db:reset'], STORE, jobEnv)) return false;
    functions = await serveFunctions(jobEnv);
    if (functions === undefined) return false;
    const passed = pnpm(['run', 'test:store'], STORE, jobEnv);
    if (!passed) functions.printLog();
    return passed;
  } finally {
    try {
      functions?.stop();
    } finally {
      // Also after a failure, Ctrl-C or a failed stop of `functions serve`, so no container is
      // left behind.
      supabase(['stop', '--no-backup'], true);
    }
  }
}

/**
 * Starts `supabase functions serve` in the background, its output in a temp log file, and waits
 * until it serves. Undefined (the log printed) when it exits or is not ready in two minutes.
 */
async function serveFunctions(jobEnv) {
  const logDir = mkdtempSync(join(tmpdir(), 'harness-store-functions-'));
  const logPath = join(logDir, 'functions.log');
  const log = openSync(logPath, 'w');
  console.log(`\n$ node dist/scripts/supabase.js functions serve  (in ${STORE}, log ${logPath})`);
  const child = spawn(process.execPath, ['dist/scripts/supabase.js', 'functions', 'serve'], {
    cwd: STORE,
    env: jobEnv,
    stdio: ['ignore', log, log],
    // Its own process group on macOS and Linux, so stop() ends the CLI and what it started.
    detached: process.platform !== 'win32',
  });
  closeSync(log);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const functions = {
    printLog() {
      console.error(`\nEdge Functions log (${logPath}):\n${readFileSync(logPath, 'utf8')}`);
    },
    stop() {
      if (!exited && child.pid !== undefined) {
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
          } else {
            process.kill(-child.pid, 'SIGTERM');
          }
        } catch {
          // Already gone.
        }
      }
      try {
        // Windows may still hold the log open for a moment after taskkill (the CLI, an antivirus).
        rmSync(logDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        console.error(`Could not remove ${logDir}: ${error.message}`);
      }
    },
  };
  const deadline = Date.now() + FUNCTIONS_READY_MS;
  while (!interrupted && !exited && Date.now() < deadline) {
    if (readFileSync(logPath, 'utf8').includes('Serving functions on')) return functions;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  functions.printLog();
  functions.stop();
  return undefined;
}

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      `Usage: pnpm ci:local [job ...]\n\nRuns the CI jobs once on this machine: ${JOBS.map((job) => job.id).join(', ')}.`,
    );
    return 0;
  }
  if (args.includes('--list')) {
    for (const job of JOBS) console.log(job.id);
    return 0;
  }
  const unknown = args.filter((name) => !JOBS.some((job) => job.id === name));
  if (unknown.length > 0) {
    console.error(
      `Unknown job ${unknown.join(', ')}; the jobs are ${JOBS.map((job) => job.id).join(', ')}.`,
    );
    return 2;
  }
  const selected = args.length === 0 ? JOBS : JOBS.filter((job) => args.includes(job.id));

  process.on('SIGINT', () => {
    interrupted = true;
  });

  const results = new Map();
  const built = pnpm(['build']);
  for (const job of selected) {
    // Lets the SIGINT listener run if Ctrl-C came between two commands.
    await new Promise((resolve) => setImmediate(resolve));
    const skip = !built || interrupted || results.get('lint-typecheck') === 'failed';
    if (skip) {
      results.set(job.id, 'skipped');
      continue;
    }
    console.log(`\n== ${job.id}`);
    results.set(job.id, (await job.run()) ? 'passed' : 'failed');
  }

  console.log(`\n${interrupted ? 'Interrupted.\n' : built ? '' : 'pnpm build failed.\n'}`);
  for (const [id, result] of results) console.log(`${result.padEnd(8)} ${id}`);
  if (interrupted) return 130;
  return built && [...results.values()].every((result) => result === 'passed') ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
