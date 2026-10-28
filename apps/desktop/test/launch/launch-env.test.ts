import { describe, expect, it } from 'vitest';
import { launchEnvironment, type LaunchContract } from '../../src/main/runtime/launch-env.js';

/**
 * Tickets P0-05.2 and P0-05.4: the environment of the launch contract
 * (docs/tech/architecture.md §4).
 */

const CONTRACT: LaunchContract = {
  gatewayUrl: 'http://127.0.0.1:51234/v1',
  token: 'gateway-token',
  harnessId: 'acme/hello',
  version: '1.2.3',
  dataDir: '/profile/data/acme/hello',
  locale: 'en',
  platform: 'linux-x64',
};

describe('launchEnvironment', () => {
  it('sets every variable of the contract, OPENAI_* pointing at the Gateway', () => {
    expect(launchEnvironment({}, CONTRACT)).toEqual({
      HARNESS_GATEWAY_URL: 'http://127.0.0.1:51234/v1',
      HARNESS_GATEWAY_TOKEN: 'gateway-token',
      OPENAI_BASE_URL: 'http://127.0.0.1:51234/v1',
      OPENAI_API_KEY: 'gateway-token',
      HARNESS_ID: 'acme/hello',
      HARNESS_VERSION: '1.2.3',
      HARNESS_DATA_DIR: '/profile/data/acme/hello',
      HARNESS_LOCALE: 'en',
      HARNESS_PLATFORM: 'linux-x64',
    });
  });

  it("strips the User's Provider credentials and every HARNESS_ variable, ignoring case", () => {
    const env = launchEnvironment(
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        OPENAI_API_KEY: 'sk-mine',
        OPENAI_ORG_ID: 'org-mine',
        ANTHROPIC_API_KEY: 'sk-ant-mine',
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        GOOGLE_API_KEY: 'google-mine',
        GEMINI_API_KEY: 'gemini-mine',
        OpenRouter_Api_Key: 'openrouter-mine',
        harness_workspace: '/somewhere',
        HARNESS_PORT: '1234',
        GOOGLE_CLOUD_PROJECT: 'kept',
        MY_OPENAI_KEY: 'kept',
        UNSET: undefined,
      },
      CONTRACT,
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      GOOGLE_CLOUD_PROJECT: 'kept',
      MY_OPENAI_KEY: 'kept',
      ...launchEnvironment({}, CONTRACT),
    });
  });

  it('sets HARNESS_PORT for a web UI Kind, over an inherited one', () => {
    const env = launchEnvironment({ HARNESS_PORT: '1234' }, { ...CONTRACT, port: 52341 });
    expect(env).toEqual({ ...launchEnvironment({}, CONTRACT), HARNESS_PORT: '52341' });
  });

  it('sets HARNESS_WORKSPACE only when there is a Workspace, over an inherited one', () => {
    const env = launchEnvironment(
      { HARNESS_WORKSPACE: '/parent' },
      { ...CONTRACT, workspace: '/Users/me/project' },
    );
    expect(env).toEqual({
      ...launchEnvironment({}, CONTRACT),
      HARNESS_WORKSPACE: '/Users/me/project',
    });
    expect(launchEnvironment({ HARNESS_WORKSPACE: '/parent' }, CONTRACT)).not.toHaveProperty(
      'HARNESS_WORKSPACE',
    );
  });
});
