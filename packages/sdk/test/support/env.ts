/** A launch environment for tests, matching the launch contract of docs/tech/architecture.md §4. */
import { vi } from 'vitest';

/** The variables the Runtime sets on a launch of `alice/hello` 1.2.3 with UI Kind `web`. */
export const LAUNCH_ENV = {
  HARNESS_GATEWAY_URL: 'http://127.0.0.1:43123/v1',
  HARNESS_GATEWAY_TOKEN: 'test-token',
  OPENAI_BASE_URL: 'http://127.0.0.1:43123/v1',
  OPENAI_API_KEY: 'test-token',
  HARNESS_ID: 'alice/hello',
  HARNESS_VERSION: '1.2.3',
  HARNESS_DATA_DIR: '/data/harnesses/alice/hello',
  HARNESS_WORKSPACE: '/Users/alice/project',
  HARNESS_PORT: '51234',
  HARNESS_LOCALE: 'zh-CN',
  HARNESS_PLATFORM: 'darwin-arm64',
} as const;

/** Every variable of the launch contract, cleared, so no stray value from the shell leaks in. */
const CONTRACT_NAMES = [...Object.keys(LAUNCH_ENV), 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'];

/**
 * Replaces the launch contract variables with `env` (an `undefined` value leaves one unset) for
 * the current test; `unstubEnvs` in vitest.config.ts restores them afterwards.
 */
export function stubLaunchEnv(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of CONTRACT_NAMES) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}
