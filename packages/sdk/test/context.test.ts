import { describe, expect, it } from 'vitest';
import { getContext, NotInHarnessStoreError } from '../src/index.js';
import { LAUNCH_ENV, stubLaunchEnv } from './support/env.js';

describe('getContext', () => {
  it('reads every launch contract variable as a typed value', () => {
    stubLaunchEnv(LAUNCH_ENV);
    expect(getContext()).toStrictEqual({
      harnessId: 'alice/hello',
      harnessVersion: '1.2.3',
      dataDir: '/data/harnesses/alice/hello',
      workspace: '/Users/alice/project',
      locale: 'zh-CN',
      platform: 'darwin-arm64',
      port: 51234,
    });
  });

  it('has no Workspace or port when the launch has none (UI Kind terminal, no folder)', () => {
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_WORKSPACE: undefined, HARNESS_PORT: undefined });
    const context = getContext();
    expect(context.workspace).toBeUndefined();
    expect(context.port).toBeUndefined();
  });

  it('treats an empty variable as unset', () => {
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_WORKSPACE: '' });
    expect(getContext().workspace).toBeUndefined();
  });

  it('reads the environment at call time, not at module load', () => {
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_LOCALE: 'en' });
    expect(getContext().locale).toBe('en');
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_LOCALE: 'zh-CN' });
    expect(getContext().locale).toBe('zh-CN');
  });

  it.each(['fr', 'zh', 'zh-cn', 'EN'])(
    'falls back to en for the unrecognised locale %s',
    (locale) => {
      stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_LOCALE: locale });
      expect(getContext().locale).toBe('en');
    },
  );

  it('keeps any platform string', () => {
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_PLATFORM: 'linux-riscv64' });
    expect(getContext().platform).toBe('linux-riscv64');
  });

  it.each(['1', '65535'])('accepts the port %s', (port) => {
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_PORT: port });
    expect(getContext().port).toBe(Number(port));
  });

  it.each(['0', '65536', '-1', '80.5', 'http', ' 80', '0x50', '1e3'])(
    'throws on the HARNESS_PORT %j',
    (port) => {
      stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_PORT: port });
      expect(() => getContext()).toThrow(/HARNESS_PORT must be an integer from 1 to 65535/);
    },
  );

  it('throws NotInHarnessStoreError when the Gateway variables are absent', () => {
    stubLaunchEnv({
      ...LAUNCH_ENV,
      HARNESS_GATEWAY_URL: undefined,
      HARNESS_GATEWAY_TOKEN: undefined,
    });
    const error = catchError(() => getContext());
    expect(error).toBeInstanceOf(NotInHarnessStoreError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'NotInHarnessStoreError',
      missing: ['HARNESS_GATEWAY_URL', 'HARNESS_GATEWAY_TOKEN'],
    });
    expect((error as Error).message).toContain('HARNESS_GATEWAY_URL, HARNESS_GATEWAY_TOKEN');
    expect((error as Error).message).toContain('Install this folder locally');
  });

  it.each([
    'HARNESS_GATEWAY_URL',
    'HARNESS_GATEWAY_TOKEN',
    'HARNESS_ID',
    'HARNESS_VERSION',
    'HARNESS_DATA_DIR',
    'HARNESS_LOCALE',
    'HARNESS_PLATFORM',
  ])('throws NotInHarnessStoreError naming %s when only it is missing', (name) => {
    stubLaunchEnv({ ...LAUNCH_ENV, [name]: undefined });
    const error = catchError(() => getContext());
    expect(error).toBeInstanceOf(NotInHarnessStoreError);
    expect(error).toMatchObject({ missing: [name] });
    expect((error as Error).message).toContain(`${name} is not set`);
  });

  it('names every missing variable outside Harness Store', () => {
    stubLaunchEnv({});
    expect(catchError(() => getContext())).toMatchObject({
      missing: [
        'HARNESS_GATEWAY_URL',
        'HARNESS_GATEWAY_TOKEN',
        'HARNESS_ID',
        'HARNESS_VERSION',
        'HARNESS_DATA_DIR',
        'HARNESS_LOCALE',
        'HARNESS_PLATFORM',
      ],
    });
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}
