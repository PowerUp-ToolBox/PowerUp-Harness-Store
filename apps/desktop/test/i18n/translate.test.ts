import { describe, expect, it } from 'vitest';
import { fail } from '../../src/main/runtime/ipc-result.js';
import { createTranslator, translatorFor } from '../../src/shared/i18n/translate.js';
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
    const port = { port: 51234 };
    expect(translatorFor('en').t('settings.diagnostics.gateway.running', port)).toBe(
      'Running on port 51234',
    );
    expect(translatorFor('zh-CN').t('settings.diagnostics.gateway.running', port)).toBe(
      '运行中，端口 51234',
    );
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

  it('falls back to the en catalog when the zh-CN catalog lacks the key', () => {
    const translator = createTranslator('zh-CN', {
      en: { 'error.slot_unbound': 'Slot "{slot}" is unbound (en catalog).' },
      'zh-CN': {},
    });
    expect(translator.errorText(SLOT_UNBOUND)).toBe('Slot "default" is unbound (en catalog).');
    expect(translator.t('error.slot_unbound', { slot: 'default' })).toBe(
      'Slot "default" is unbound (en catalog).',
    );
  });

  it('falls back to the en catalog when the zh-CN message cannot be formatted', () => {
    const translator = createTranslator('zh-CN', {
      en: {
        'error.slot_unbound': 'Slot "{slot}" is unbound (en catalog).',
        'section.library': 'Library',
      },
      // Broken ICU, and a template that needs a param the caller does not pass.
      'zh-CN': { 'error.slot_unbound': '模型槽位“{slot”', 'section.library': '{missing}' },
    });
    expect(translator.errorText(SLOT_UNBOUND)).toBe('Slot "default" is unbound (en catalog).');
    expect(translator.t('section.library')).toBe('Library');
  });

  it('falls back to the English message when no catalog can format it', () => {
    // No `slot` param: neither catalog can render it, so the error's own message is shown.
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
