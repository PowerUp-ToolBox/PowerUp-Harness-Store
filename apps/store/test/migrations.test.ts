/**
 * Static checks of supabase/migrations that need no database: the rules every migration must
 * follow so that a new table or function is never reachable through PostgREST by accident. The
 * behaviour itself is tested against a running stack in test-store/.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', 'supabase', 'migrations');
const files = readdirSync(dir).sort();
const sql = files.map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');

/** Functions anon may call as RPCs (added by later P0-07 tickets). */
const PUBLIC_RPCS = new Set<string>(['latest_versions', 'search_harnesses']);

function names(pattern: RegExp): string[] {
  return [...sql.matchAll(pattern)].map((match) => match[1] ?? '');
}

/** Every `public.<name>` listed in the statements that `pattern` matches. */
function listed(pattern: RegExp): Set<string> {
  return new Set(
    [...sql.matchAll(pattern)].flatMap((match) =>
      [...(match[1] ?? '').matchAll(/public\.([a-z_]+)/g)].map((name) => name[1] ?? ''),
    ),
  );
}

describe('supabase/migrations', () => {
  it('are named <14-digit timestamp>_<snake_case>.sql, with distinct timestamps', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    expect(new Set(files.map((file) => file.slice(0, 14))).size).toBe(files.length);
  });

  it('enable row-level security on every table and revoke the default grants to anon and authenticated', () => {
    const tables = names(/create table public\.([a-z_]+)/g);
    expect(tables).toEqual(
      expect.arrayContaining([
        'profiles',
        'harnesses',
        'harness_versions',
        'reports',
        'download_events',
        'admin_actions',
      ]),
    );
    const secured = new Set(names(/alter table public\.([a-z_]+) enable row level security/g));
    const revoked = listed(/revoke all on table([^;]*)from anon, authenticated;/g);
    for (const table of tables) {
      expect(secured, table).toContain(table);
      expect(revoked, table).toContain(table);
    }
  });

  it('revoke EXECUTE from public, anon and authenticated on every function that is not a public RPC', () => {
    const functions = names(/create (?:or replace )?function public\.([a-z_]+)\(/g);
    expect(functions.length).toBeGreaterThan(0);
    const revoked = listed(/revoke execute on function([^;]*)from public, anon, authenticated;/g);
    for (const name of functions) {
      if (!PUBLIC_RPCS.has(name)) expect(revoked, name).toContain(name);
    }
  });

  it('keep the private schema out of the API, and its functions from anon', () => {
    const config = readFileSync(join(import.meta.dirname, '..', 'supabase', 'config.toml'), 'utf8');
    expect(/^schemas = (.*)$/m.exec(config)?.[1]).not.toContain('private');
    const functions = names(/create (?:or replace )?function private\.([a-z_]+)\(/g);
    expect(functions).toContain('own_harness_ids');
    const revoked = new Set(
      [...sql.matchAll(/revoke execute on function([^;]*)from public, anon;/g)].flatMap((match) =>
        [...(match[1] ?? '').matchAll(/private\.([a-z_]+)/g)].map((name) => name[1] ?? ''),
      ),
    );
    for (const name of functions) expect(revoked, name).toContain(name);
  });

  it('grant EXECUTE on each public RPC to anon and authenticated, never to PUBLIC', () => {
    const revoked = listed(/revoke execute on function([^;]*)from public;/g);
    const granted = listed(/grant execute on function([^;]*)to anon, authenticated\b/g);
    for (const name of PUBLIC_RPCS) {
      expect(revoked, name).toContain(name);
      expect(granted, name).toContain(name);
    }
  });
});

describe('supabase/config.toml', () => {
  const config = readFileSync(join(import.meta.dirname, '..', 'supabase', 'config.toml'), 'utf8');
  const section = (name: string) => {
    const start = config.indexOf(`\n[${name}]\n`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const rest = config.slice(start + name.length + 4);
    return rest.slice(0, rest.search(/\n\[/));
  };

  it('turns email signup off, so a GitHub login cannot be claimed through signup metadata', () => {
    expect(section('auth.email')).toMatch(/^enable_signup = false$/m);
  });

  it('lets Storage accept a 500 MB Harness Package', () => {
    expect(section('storage')).toMatch(/^file_size_limit = "500MiB"$/m);
  });

  it('leaves the caller check to each Edge Function: verify_jwt is off for every function', () => {
    const functions = readdirSync(join(import.meta.dirname, '..', 'supabase', 'functions'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name);
    expect(functions).toEqual(
      expect.arrayContaining(['admin', 'download', 'publish', 'report', 'unpublish']),
    );
    for (const name of functions) {
      expect(section(`functions.${name}`)).toMatch(/^verify_jwt = false$/m);
    }
  });
});
