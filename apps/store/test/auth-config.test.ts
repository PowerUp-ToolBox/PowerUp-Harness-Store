/**
 * Ticket P0-07.2, the Store side of the GitHub sign-in that needs no Docker: config.toml enables
 * only the GitHub provider, takes its credentials from the environment, allows the desktop app's
 * callback URL, and `pnpm db:start` can always fill those values in.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { supabaseEnv } from '../scripts/local-stack.ts';

const supabaseDir = join(import.meta.dirname, '..', 'supabase');
const config = readFileSync(join(supabaseDir, 'config.toml'), 'utf8');

/** The `key = value` lines of one `[section]` of config.toml (not of its sub-sections). */
function section(name: string): Map<string, string> {
  const start = config.indexOf(`\n[${name}]\n`);
  if (start < 0) throw new Error(`No [${name}] in config.toml`);
  const body = config.slice(start + name.length + 4).split(/\n\[/)[0] ?? '';
  return new Map(
    [...body.matchAll(/^([a-z_]+)\s*=\s*(.+)$/gm)].map((match) => [match[1] ?? '', match[2] ?? '']),
  );
}

describe('supabase/config.toml', () => {
  it('enables GitHub with its client id, secret and URL from the environment only', () => {
    const github = section('auth.external.github');
    expect(github.get('enabled')).toBe('true');
    for (const key of ['client_id', 'secret', 'url']) {
      expect(github.get(key), key).toMatch(/^"env\(SUPABASE_AUTH_EXTERNAL_GITHUB_[A-Z_]+\)"$/);
    }
  });

  it('allows the desktop app’s harnessstore://auth-callback as a redirect', () => {
    expect(section('auth').get('additional_redirect_urls')).toContain(
      '"harnessstore://auth-callback"',
    );
  });

  it('has every env(...) variable it reads under [auth.external.github] in .env.example', () => {
    const example = readFileSync(join(supabaseDir, '.env.example'), 'utf8');
    const names = [...section('auth.external.github').values()].flatMap((value) =>
      [...value.matchAll(/env\(([A-Z_]+)\)/g)].map((match) => match[1] ?? ''),
    );
    expect(names).toHaveLength(3);
    for (const name of names) expect(example).toMatch(new RegExp(`^${name}=`, 'm'));
  });

  it('keeps every other OAuth provider and email signup off', () => {
    const enabled = [...config.matchAll(/\n\[auth\.external\.([a-z_]+)\]\nenabled = true/g)];
    expect(enabled.map((match) => match[1])).toEqual(['github']);
    expect(section('auth.email').get('enable_signup')).toBe('false');
  });
});

describe('supabaseEnv', () => {
  let root: string;
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env.HARNESS_TEST_FROM_PROCESS;
  });

  it('fills a variable from .env.example only when neither the environment nor .env sets it', () => {
    root = mkdtempSync(join(tmpdir(), 'harness-store-env-'));
    mkdirSync(join(root, 'supabase'));
    writeFileSync(
      join(root, 'supabase', '.env.example'),
      '# comment\nHARNESS_TEST_FROM_PROCESS=example\nHARNESS_TEST_FROM_DOTENV=example\nHARNESS_TEST_DEFAULT=example\n',
    );
    writeFileSync(join(root, 'supabase', '.env'), 'HARNESS_TEST_FROM_DOTENV=\n');
    process.env.HARNESS_TEST_FROM_PROCESS = 'process';

    const env = supabaseEnv(root);
    expect(env.HARNESS_TEST_FROM_PROCESS).toBe('process');
    // Left to the CLI, which reads supabase/.env itself (an empty value means real GitHub).
    expect(env.HARNESS_TEST_FROM_DOTENV).toBeUndefined();
    expect(env.HARNESS_TEST_DEFAULT).toBe('example');
    expect(env.SUPABASE_TELEMETRY_DISABLED).toBe('1');
  });
});
