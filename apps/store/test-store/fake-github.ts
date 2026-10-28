/**
 * The fake GitHub of the sign-in tests, and the browser that walks through it. Real GitHub OAuth
 * cannot run in CI, so supabase/.env.example points the stack's GitHub provider at
 * http://fake-github:8080 (config.toml `url`): this module runs fake-github-server.mjs there, in a
 * container on the stack's Docker network, so Auth reaches it on every OS (a server on the host
 * would need host.docker.internal, which Linux Docker does not provide).
 *
 * Auth calls it server to server (token exchange, user API). The consent page itself is played
 * by {@link signInBrowser}: the browser the app opens follows Auth's redirects, and where GitHub
 * would show its consent screen it answers as an approving User would.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeRoot } from '../scripts/local-stack.ts';

/** The provider URL supabase/.env.example gives Auth: the container's alias on the network. */
export const FAKE_GITHUB_URL = 'http://fake-github:8080';

/** A GitHub account as the fake GitHub reports it. */
export interface GitHubIdentity {
  id: number;
  login: string;
  name: string;
  email: string;
}

function projectId(): string {
  const config = readFileSync(join(storeRoot(), 'supabase', 'config.toml'), 'utf8');
  const id = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  if (id === undefined) throw new Error('No project_id in supabase/config.toml');
  return id;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const containerName = () => `supabase_fake_github_${projectId()}`;

/**
 * Starts the fake GitHub on the stack's network under the alias `fake-github`. It reuses the
 * Storage API image, which the stack has already pulled and which ships Node, so nothing new is
 * downloaded. Resolves once it listens.
 */
export async function startFakeGitHub(): Promise<void> {
  const id = projectId();
  const name = containerName();
  const image = docker([
    'inspect',
    `supabase_storage_${id}`,
    '--format',
    '{{.Config.Image}}',
  ]).trim();
  const script = readFileSync(join(import.meta.dirname, 'fake-github-server.mjs'), 'utf8');
  stopFakeGitHub();
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--network',
    `supabase_network_${id}`,
    '--network-alias',
    'fake-github',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '--eval',
    script,
  ]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (docker(['logs', name]).includes('fake GitHub listening')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The fake GitHub did not start: ${docker(['logs', name])}`);
}

/** Removes the fake GitHub's container, if it runs. */
export function stopFakeGitHub(): void {
  try {
    docker(['rm', '--force', containerName()]);
  } catch {
    // Not running.
  }
}

/**
 * The User's browser for the app's `openExternal`: follows the redirects of the Store's GitHub
 * sign-in, consents on the fake GitHub as `identity`, and hands the final
 * `harnessstore://auth-callback` URL to `deliver`, as the OS hands it to the app. Records every
 * URL it visits in `visited`.
 */
export function signInBrowser(
  identity: () => GitHubIdentity,
  deliver: (url: string) => boolean,
  visited: string[] = [],
): (url: string) => Promise<void> {
  return async (start) => {
    let url = start;
    for (let hop = 0; hop < 10; hop += 1) {
      visited.push(url);
      if (url.startsWith('harnessstore:')) {
        if (!deliver(url)) throw new Error(`The app did not take the callback ${url}`);
        return;
      }
      if (url.startsWith(`${FAKE_GITHUB_URL}/login/oauth/authorize?`)) {
        // GitHub's consent screen: the User approves, and GitHub sends the browser back to Auth.
        const consent = new URL(url);
        const back = new URL(consent.searchParams.get('redirect_uri') ?? '');
        back.searchParams.set(
          'code',
          Buffer.from(JSON.stringify(identity())).toString('base64url'),
        );
        back.searchParams.set('state', consent.searchParams.get('state') ?? '');
        url = back.toString();
        continue;
      }
      const response = await fetch(url, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || location === null) {
        throw new Error(`${url} answered ${String(response.status)}: ${await response.text()}`);
      }
      url = new URL(location, url).toString();
    }
    throw new Error(`Too many redirects from ${start}`);
  };
}
