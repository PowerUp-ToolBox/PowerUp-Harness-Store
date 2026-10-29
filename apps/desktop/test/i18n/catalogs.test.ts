import { GATEWAY_ERROR_STATUS, type GatewayErrorCode } from '@harness-store/gateway';
import { interpolate, MESSAGES_EN } from '@harness-store/manifest';
import { describe, expect, expectTypeOf, it } from 'vitest';
import en from '../../src/shared/i18n/en.json';
import zhCN from '../../src/shared/i18n/zh-CN.json';
import { translatorFor } from '../../src/shared/i18n/translate.js';
import type { IpcErrorCode } from '../../src/shared/ipc.js';
import { argumentsOf, compareCatalogs } from './catalog-check.js';

const IPC_OWN_CODES = ['internal_error', 'invalid_input', 'not_implemented'] as const;

describe('catalog parity (CI)', () => {
  it('zh-CN.json has exactly the keys of en.json, valid ICU with the same arguments', () => {
    expect(compareCatalogs(en, zhCN, 'zh-CN')).toEqual([]);
  });

  it('fails on a zh-CN catalog with a key deleted, naming the key', () => {
    const incomplete: Record<string, string> = { ...zhCN };
    delete incomplete['settings.language'];
    expect(compareCatalogs(en, incomplete, 'zh-CN')).toEqual([
      'zh-CN.json is missing the key "settings.language"',
    ]);
  });

  it('fails on an extra key, invalid ICU, or different arguments', () => {
    const broken = {
      ...zhCN,
      'extra.key': '多余',
      'settings.diagnostics.gateway.running': '运行中，端口 {portNumber}',
      'error.slot_unbound': '槽位 {slot',
    };
    expect(compareCatalogs(en, broken, 'zh-CN')).toEqual([
      'zh-CN.json has the key "extra.key", which en.json does not',
      'zh-CN.json "settings.diagnostics.gateway.running" uses the arguments [portNumber], but en.json uses [port]',
      expect.stringMatching(/^zh-CN\.json "error\.slot_unbound" is not valid ICU: /),
    ]);
  });

  it('keys are flat literal strings: no nested objects', () => {
    for (const catalog of [en, zhCN]) {
      expect(Object.values(catalog).every((value) => typeof value === 'string')).toBe(true);
    }
  });
});

describe('Manifest problems in the catalogs', () => {
  const messageKeys = Object.keys(MESSAGES_EN) as (keyof typeof MESSAGES_EN)[];

  it('every Manifest messageKey has a manifest.<messageKey> entry in en and zh-CN', () => {
    const missing = messageKeys
      .map((key) => `manifest.${key}`)
      .filter((key) => !Object.hasOwn(en, key) || !Object.hasOwn(zhCN, key));
    expect(missing).toEqual([]);
  });

  it('the en manifest.* entries are verbatim copies of MESSAGES_EN, and nothing else', () => {
    const fromCatalog = Object.fromEntries(
      Object.entries(en)
        .filter(([key]) => key.startsWith('manifest.'))
        .map(([key, message]) => [key.slice('manifest.'.length), message]),
    );
    expect(fromCatalog).toEqual({ ...MESSAGES_EN });
  });

  it.each(messageKeys)('ICU renders %s exactly as the Manifest interpolate() does', (key) => {
    const template = MESSAGES_EN[key];
    const names = argumentsOf(template);
    if (typeof names === 'string') throw new Error(names);
    const params = Object.fromEntries(names.map((name) => [name, `<${name}>`]));
    expect(translatorFor('en').t(`manifest.${key}`, params)).toBe(interpolate(template, params));
  });
});

describe('error codes in the catalogs', () => {
  it('every Gateway code and IPC code has error.<code> in en and zh-CN', () => {
    const codes = [...Object.keys(GATEWAY_ERROR_STATUS), ...IPC_OWN_CODES];
    const missing = codes
      .map((code) => `error.${code}`)
      .filter((key) => !Object.hasOwn(en, key) || !Object.hasOwn(zhCN, key));
    expect(missing).toEqual([]);
  });

  it('IpcErrorCode is exactly the IPC codes plus the Gateway codes', () => {
    expectTypeOf<IpcErrorCode>().toEqualTypeOf<GatewayErrorCode | (typeof IPC_OWN_CODES)[number]>();
  });
});
