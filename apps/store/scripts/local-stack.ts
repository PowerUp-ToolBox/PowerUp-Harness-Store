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

/** Runs the pinned Supabase CLI (the `supabase` devDependency) through its Node entry point. */
function supabaseCli(root: string, args: string[]): string {
  const require = createRequire(join(root, 'package.json'));
  const manifestPath = require.resolve('supabase/package.json');
  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: { supabase: string } };
  return execFileSync(process.execPath, [join(dirname(manifestPath), bin.supabase), ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
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
