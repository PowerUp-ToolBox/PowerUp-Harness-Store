import { describe, expect, it } from 'vitest';
import { resolveLocale } from '../../src/shared/i18n/locale.js';

describe('resolveLocale', () => {
  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['zh_CN', 'zh-CN'],
    ['ZH-hk', 'zh-CN'],
    ['zh-Hant-TW', 'zh-CN'],
    ['en-US', 'en'],
    ['en', 'en'],
    ['de-DE', 'en'],
    ['ja', 'en'],
    ['zu', 'en'],
    ['', 'en'],
  ] as const)('given OS locale %j and no override, the app locale is %s', (os, expected) => {
    expect(resolveLocale(undefined, os)).toBe(expected);
  });

  it('the User override wins over the OS locale', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
  });
});
