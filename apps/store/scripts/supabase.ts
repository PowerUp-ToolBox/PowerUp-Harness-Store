/**
 * Runs the pinned Supabase CLI with the arguments given, from apps/store, in the environment of
 * {@link supabaseEnv}: `node dist/scripts/supabase.js start` is `supabase start` with the GitHub
 * provider's env(...) values filled in. The package scripts (db:start, db:reset, functions:serve)
 * and CI go through it.
 */
import { spawnSync } from 'node:child_process';
import { storeRoot, supabaseBin, supabaseEnv } from './local-stack.ts';

const root = storeRoot();
const result = spawnSync(process.execPath, [supabaseBin(root), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: supabaseEnv(root),
});
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
