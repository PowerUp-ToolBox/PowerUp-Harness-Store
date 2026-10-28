import { describe, expect, it } from 'vitest';
import { fail } from '../../src/main/runtime/ipc-result.js';
import { translatorFor } from '../../src/shared/i18n/translate.js';
import type { IpcError } from '../../src/shared/ipc.js';

const SLOT_UNBOUND: IpcError = {
  code: 'slot_unbound',
  messageKey: 'error.slot_unbound',
  params: { slot: 'default' },
  message: 'No model is bound to the Model Slot "default". Choose one on the Models page.',
};

describe('t(key, params)', () => {
  it('renders a UI string in each locale', () => {
    expect(translatorFor('en').t('section.library')).toBe('Library');
    expect(translatorFor('zh-CN').t('section.library')).toBe('资源库');
  });

  it('fills ICU arguments from params', () => {
    expect(translatorFor('en').t('settings.version', { version: '1.2.3' })).toBe('Version 1.2.3');
    expect(translatorFor('zh-CN').t('settings.version', { version: '1.2.3' })).toBe('版本 1.2.3');
  });

  it('accepts number params', () => {
    const message = translatorFor('en').problemText({
      messageKey: 'archive_too_many_files',
      params: { actual: 25000, limit: 20000 },
      message: '',
    });
    expect(message).toBe('The Harness Package holds 25000 files; the limit is 20000.');
  });
});

describe('IPC errors', () => {
  it('given IPC error slot_unbound, shows the zh-CN message when the locale is zh-CN', () => {
    expect(translatorFor('zh-CN').errorText(SLOT_UNBOUND)).toBe(
      '模型槽位“default”还没有绑定模型。请在模型页选择一个。',
    );
    expect(translatorFor('en').errorText(SLOT_UNBOUND)).toBe(SLOT_UNBOUND.message);
  });

  it('falls back to en when the locale cannot format the message', () => {
    // No `slot` param: neither catalog can render it, so the English message is shown.
    const withoutParams = { messageKey: SLOT_UNBOUND.messageKey, message: SLOT_UNBOUND.message };
    expect(translatorFor('zh-CN').errorText(withoutParams)).toBe(SLOT_UNBOUND.message);
  });

  it('falls back to the English message for a key no catalog has', () => {
    const unknown = { messageKey: 'error.from_the_future', message: 'Something new failed.' };
    expect(translatorFor('zh-CN').errorText(unknown)).toBe('Something new failed.');
  });

  it("main builds an error's English message from the en catalog", () => {
    expect(fail('slot_unbound', { slot: 'default' })).toEqual({ ok: false, error: SLOT_UNBOUND });
    expect(fail('not_implemented').error).toEqual({
      code: 'not_implemented',
      messageKey: 'error.not_implemented',
      message: translatorFor('en').t('error.not_implemented'),
    });
  });
});

describe('Manifest problems', () => {
  const problem = {
    messageKey: 'schema_required',
    params: { key: 'name' },
    message: 'Required key "name" is missing.',
  };

  it('are looked up by messageKey under manifest.', () => {
    expect(translatorFor('en').problemText(problem)).toBe('Required key "name" is missing.');
    expect(translatorFor('zh-CN').problemText(problem)).toBe('缺少必需的键 "name"。');
  });

  it('use the variant key when the problem has one', () => {
    expect(
      translatorFor('zh-CN').problemText({
        messageKey: 'unknown_key.nested',
        params: { key: 'colour' },
        message: '',
      }),
    ).toBe('未知的键 "colour"。');
  });
});
