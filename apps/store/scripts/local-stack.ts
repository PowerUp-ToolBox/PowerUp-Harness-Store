/**
 * Finds the running local Supabase stack (`supabase start`) and its keys. The seed script and the
 * store tests only ever talk to this local stack: they read its URL and keys from
 * `supabase status`, never from the environment, so they cannot reach a hosted project by mistake.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LocalStack {
  /** Kong gateway, e.g. `http://127.0.0.1:54321`. */
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Signs the HS256 JWTs the tests mint for test Publishers. */
  jwtSecret: string;
}

/** apps/store, found by walking up from this file (it runs from scripts/ and from dist/scripts/). */
export function storeRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'supabase', 'config.toml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('apps/store (supabase/config.toml) not found');
    dir = parent;
  }
  return dir;
}

/** The `KEY=value` lines of a dotenv file (no quoting or expansion); empty when it is absent. */
function readEnvFile(path: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match?.[1] !== undefined) entries.set(match[1], (match[2] ?? '').trim());
  }
  return entries;
}

/**
 * The environment the Supabase CLI runs with: the caller's, plus each variable of
 * supabase/.env.example that neither the environment nor supabase/.env (which the CLI reads
 * itself) sets. So config.toml's env(...) values (the GitHub provider) always resolve, to the fake
 * GitHub of the store tests unless the developer configured another.
 */
export function supabaseEnv(root: string = storeRoot()): NodeJS.ProcessEnv {
  const configured = readEnvFile(join(root, 'supabase', '.env'));
  const env: NodeJS.ProcessEnv = { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' };
  for (const [key, value] of readEnvFile(join(root, 'supabase', '.env.example'))) {
    if (env[key] === undefined && !configured.has(key)) env[key] = value;
  }
  return env;
}

/** The pinned Supabase CLI (the `supabase` devDependency): its Node entry point. */
export function supabaseBin(root: string = storeRoot()): string {
  const require = createRequire(join(root, 'package.json'));
  const manifestPath = require.resolve('supabase/package.json');
  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: { supabase: string } };
  return join(dirname(manifestPath), bin.supabase);
}

/** Runs the pinned Supabase CLI and returns its standard output. */
function supabaseCli(root: string, args: string[]): string {
  return execFileSync(process.execPath, [supabaseBin(root), ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: supabaseEnv(root),
  });
}

export function localStack(): LocalStack {
  const root = storeRoot();
  let output: string;
  try {
    output = supabaseCli(root, ['status', '--output', 'json']);
  } catch (error) {
    throw new Error(
      'The local Supabase stack is not running. Start it with `pnpm --filter @harness-store/store db:start`.',
      { cause: error },
    );
  }
  const status = JSON.parse(
    output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1),
  ) as Record<string, unknown>;
  const field = (name: string): string => {
    const value = status[name];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`\`supabase status\` did not report ${name}`);
    }
    return value;
  };
  return {
    apiUrl: field('API_URL'),
    anonKey: field('ANON_KEY'),
    serviceRoleKey: field('SERVICE_ROLE_KEY'),
    jwtSecret: field('JWT_SECRET'),
  };
}
