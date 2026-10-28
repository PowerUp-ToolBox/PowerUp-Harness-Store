// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../src/renderer/src/i18n/I18nProvider.js';
import type { IpcError } from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

function sidebarLabels(name: string) {
  return within(screen.getByRole('navigation', { name }))
    .getAllByRole('link')
    .map((link) => link.textContent);
}

const EN_SECTIONS = ['Library', 'Store', 'Models', 'Publish', 'Usage', 'Settings'];
const ZH_SECTIONS = ['资源库', '商店', '模型', '发布', '用量', '设置'];

describe('UI language', () => {
  it('renders in Chinese when the Runtime resolves zh-CN (OS locale zh-*)', async () => {
    installFakeApi('zh-CN');
    await renderApp('#/library');
    expect(sidebarLabels('主导航')).toEqual(ZH_SECTIONS);
    expect(screen.getByRole('heading', { level: 1, name: '资源库' })).toBeDefined();
    expect(screen.getByText('你安装的 Harness 会显示在这里。')).toBeDefined();
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('renders in English for any other OS locale', async () => {
    installFakeApi('en');
    await renderApp('#/library');
    expect(sidebarLabels('Main')).toEqual(EN_SECTIONS);
    expect(document.documentElement.lang).toBe('en');
  });

  it('renders nothing until the Runtime has answered settings.get', () => {
    const api = installFakeApi('zh-CN');
    api.settings.get.mockReturnValue(new Promise(() => undefined));
    const { container } = render(
      <I18nProvider>
        <p>{'x'}</p>
      </I18nProvider>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('switching the language in Settings updates every visible string at once', async () => {
    const api = installFakeApi('en');
    await renderApp('#/settings');
    expect(await screen.findByText('Version 4.5.6')).toBeDefined();

    const select = screen.getByLabelText<HTMLSelectElement>('Language');
    expect(select.value).toBe('system');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'zh-CN' } });
      await Promise.resolve();
    });

    expect(api.settings.set).toHaveBeenCalledWith({ locale: 'zh-CN' });
    expect(sidebarLabels('主导航')).toEqual(ZH_SECTIONS);
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeDefined();
    expect(screen.getByText('版本 4.5.6')).toBeDefined();
    const zhSelect = screen.getByLabelText<HTMLSelectElement>('语言');
    expect(zhSelect.value).toBe('zh-CN');
    expect([...zhSelect.options].map((option) => option.text)).toEqual([
      '跟随系统',
      'English',
      '简体中文',
    ]);

    await act(async () => {
      fireEvent.change(zhSelect, { target: { value: 'system' } });
      await Promise.resolve();
    });
    expect(api.settings.set).toHaveBeenLastCalledWith({ locale: null });
    expect(sidebarLabels('Main')).toEqual(EN_SECTIONS);
  });

  it('shows a Runtime error (slot_unbound) in the selected language', async () => {
    const slotUnbound: IpcError = {
      code: 'slot_unbound',
      messageKey: 'error.slot_unbound',
      params: { slot: 'default' },
      message: 'No model is bound to the Model Slot "default". Choose one on the Models page.',
    };
    const api = installFakeApi('en', 'zh-CN');
    api.settings.set.mockResolvedValue({ ok: false, error: slotUnbound });
    await renderApp('#/settings');

    await act(async () => {
      fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toBe(
      '模型槽位“default”还没有绑定模型。请在模型页选择一个。',
    );
  });
});
