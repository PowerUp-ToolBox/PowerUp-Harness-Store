// @vitest-environment jsdom
/**
 * Ticket P0-12.1: the Report dialog over the fake `window.api`, in en and zh-CN, opened from a
 * detail page's Report link and from a Library card's menu: the reasons (none preselected, Submit
 * waiting for one), the client info shown before Submit for the place it was opened from, the
 * details counter and the contact email, the confirmation, a failed submit that keeps everything
 * typed and offers Retry, and the client-side limit of 3 Reports per Harness in 24 hours, a fourth
 * blocked without a `store.report` call. test/store/store-report.test.ts covers the same calls in
 * main.
 */
import type { Manifest } from '@harness-store/manifest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledHarness, IpcResult, StoreDetail } from '../../src/shared/ipc.js';
import { FAKE_INSTALL_ID, installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: 'alice/writer',
  version: '1.2.0',
  name: 'Writer',
  summary: 'Drafts and edits long texts.',
  license: 'MIT',
  platforms: ['darwin-arm64', 'linux-x64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'index.mjs',
  ui: { kind: 'terminal' },
  models: { slots: { default: {} } },
  permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
};

/** The Store's page of `alice/writer`, whose latest version is 1.2.0. */
const DETAIL: IpcResult<StoreDetail> = {
  ok: true,
  data: {
    platform: 'darwin-arm64',
    storeStatus: 'available',
    harness: {
      harnessId: 'alice/writer',
      publisher: { login: 'alice', displayName: 'Alice', avatarUrl: null },
      iconUrl: null,
      downloadCount: 3,
      manifest: MANIFEST,
      readme: null,
      screenshotUrls: [],
      versions: [
        {
          version: '1.2.0',
          publishedAt: '2026-10-20T09:00:00.000000+00:00',
          changelog: null,
          permissionsChanged: false,
        },
      ],
    },
  },
};

/** `alice/writer` 1.0.0, installed from the Store, or `fields` says otherwise. */
function installed(fields: Partial<InstalledHarness> = {}): InstalledHarness {
  return {
    harnessId: 'alice/writer',
    version: '1.0.0',
    name: 'Writer',
    publisher: 'alice',
    source: 'store',
    manifest: { ...MANIFEST, version: '1.0.0' },
    installPath: '/profile/harnesses/alice/writer/1.0.0',
    installedAt: '2026-10-01T00:00:00.000Z',
    lastLaunchedAt: null,
    iconDataUrl: null,
    platformSupported: true,
    storeStatus: 'available',
    installedVersionTakenDown: false,
    takedownAcknowledged: false,
    availableUpdate: null,
    ...fields,
  };
}

function setup(locale: 'en' | 'zh-CN' = 'en', installs: readonly InstalledHarness[] = []) {
  const api = installFakeApi(locale);
  api.store.detail.mockResolvedValue(DETAIL);
  api.installs.list.mockResolvedValue({ ok: true, data: installs });
  return api;
}

const dialog = () => within(screen.getByRole('dialog'));

/** Opens the detail page and its Report dialog, once the client info is shown. */
async function reportFromDetail(name = 'Report', title = 'Report Writer') {
  await renderApp('#/store/h/alice/writer');
  const footer = (await screen.findByRole('heading', { name: 'Writer' }))
    .closest('.listing-detail')
    ?.querySelector('footer');
  if (!(footer instanceof HTMLElement)) throw new Error('No footer');
  fireEvent.click(within(footer).getByRole('button', { name }));
  await screen.findByRole('dialog', { name: title });
  await waitFor(() => {
    expect(dialog().queryByText(/Preparing the Report|正在准备举报/)).toBeNull();
  });
}

/** Opens a Library card's menu and picks Report. */
async function reportFromLibrary(menuItem = 'Report', card = 'Writer') {
  const view = within(await screen.findByRole('article', { name: card }));
  // The card's menu button, "More actions for <card>" in each language.
  fireEvent.click(view.getByRole('button', { name: new RegExp(card) }));
  fireEvent.click(view.getByRole('menuitem', { name: menuItem }));
  await screen.findByRole('dialog');
  await waitFor(() => {
    expect(dialog().queryByText(/Preparing the Report|正在准备举报/)).toBeNull();
  });
}

/** The client info the dialog shows, term → value. */
function shownInfo(): Record<string, string> {
  const list = screen.getByRole('dialog').querySelector('dl');
  if (list === null) throw new Error('No client info');
  const terms = [...list.querySelectorAll('dt')].map((term) => term.textContent);
  const values = [...list.querySelectorAll('dd')].map((value) => value.textContent);
  return Object.fromEntries(terms.map((term, index) => [term, values[index] ?? '']));
}

const submitButton = () => dialog().getByRole('button', { name: /^(Submit|Retry)$/ });

describe('Report dialog', () => {
  it('opens from the detail page with the six reasons, none picked, and the client info of the version shown', async () => {
    const api = setup();
    await reportFromDetail();
    expect(api.store.reportInfo).toHaveBeenCalledWith('alice/writer');
    const reasons = dialog().getAllByRole('radio');
    expect(reasons.map((radio) => radio.closest('label')?.textContent)).toEqual([
      'Malicious behaviour',
      'Bypasses the Model Gateway',
      'Broken',
      'Inappropriate content',
      'Spam',
      'Other',
    ]);
    expect(reasons.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(
      dialog().getByText(
        'Sent with this Report: Harness ID, version, platform, app version, a random install ID',
      ),
    ).toBeDefined();
    expect(shownInfo()).toEqual({
      'Harness ID': 'alice/writer',
      Version: '1.2.0',
      Platform: 'darwin-arm64',
      'App version': '4.5.6',
      'Install ID': FAKE_INSTALL_ID,
    });
    expect(
      dialog().getByText(
        'No account is needed. No IP address or account is stored with the Report.',
      ),
    ).toBeDefined();
    // A reason is required; details are not.
    expect(submitButton()).toHaveProperty('disabled', true);
    fireEvent.click(dialog().getByRole('radio', { name: 'Bypasses the Model Gateway' }));
    expect(submitButton()).toHaveProperty('disabled', false);
    await act(async () => {
      fireEvent.click(submitButton());
      await Promise.resolve();
    });
    expect(api.store.report).toHaveBeenCalledExactlyOnceWith({
      harnessId: 'alice/writer',
      version: '1.2.0',
      reason: 'bypasses_gateway',
      details: '',
      contactEmail: '',
    });
    expect(await screen.findByText('Thanks, a reviewer will look at this.')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens from a Library card’s menu for the installed version; a local install has no Report', async () => {
    const api = setup('en', [
      installed(),
      installed({
        harnessId: 'me/local',
        name: 'Mine',
        publisher: 'me',
        source: 'local',
        storeStatus: null,
        takedownAcknowledged: false,
      }),
    ]);
    await renderApp('#/library');
    const local = within(await screen.findByRole('article', { name: 'Mine' }));
    fireEvent.click(local.getByRole('button', { name: 'More actions for Mine' }));
    expect(local.queryByRole('menuitem', { name: 'Report' })).toBeNull();
    fireEvent.keyDown(local.getByRole('menu'), { key: 'Escape' });

    await reportFromLibrary();
    expect(screen.getByRole('dialog', { name: 'Report Writer' })).toBeDefined();
    expect(shownInfo()).toMatchObject({ 'Harness ID': 'alice/writer', Version: '1.0.0' });
    fireEvent.click(dialog().getByRole('radio', { name: 'Broken' }));
    fireEvent.change(dialog().getByLabelText('Details (optional)'), {
      target: { value: 'It crashes on start.' },
    });
    await act(async () => {
      fireEvent.click(submitButton());
      await Promise.resolve();
    });
    expect(api.store.report).toHaveBeenCalledExactlyOnceWith({
      harnessId: 'alice/writer',
      version: '1.0.0',
      reason: 'broken',
      details: 'It crashes on start.',
      contactEmail: '',
    });
    expect(await screen.findByText('Thanks, a reviewer will look at this.')).toBeDefined();
  });

  it('counts the characters left with the contact line, and refuses too much text or a bad email', async () => {
    const api = setup();
    await reportFromDetail();
    fireEvent.click(dialog().getByRole('radio', { name: 'Other' }));
    expect(dialog().getByText('2,000 characters left')).toBeDefined();
    const details = dialog().getByLabelText('Details (optional)');
    fireEvent.change(details, { target: { value: 'Hello' } });
    expect(dialog().getByText('1,995 characters left')).toBeDefined();
    // "Contact: me@example.com" and a blank line go first.
    const email = dialog().getByLabelText('Contact email (optional)');
    fireEvent.change(email, { target: { value: 'me@example.com' } });
    expect(dialog().getByText('1,970 characters left')).toBeDefined();

    fireEvent.change(email, { target: { value: 'not an email' } });
    expect(
      dialog().getByText('Enter an email address like name@example.com, or leave it empty.'),
    ).toBeDefined();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(submitButton()).toHaveProperty('disabled', true);
    fireEvent.change(email, { target: { value: ' me@example.com ' } });
    expect(submitButton()).toHaveProperty('disabled', false);

    fireEvent.change(details, { target: { value: 'x'.repeat(1976) } });
    expect(dialog().getByText('1 character too many')).toBeDefined();
    expect(details.getAttribute('aria-invalid')).toBe('true');
    expect(submitButton()).toHaveProperty('disabled', true);
    fireEvent.change(details, { target: { value: 'x'.repeat(1975) } });
    expect(dialog().getByText('0 characters left')).toBeDefined();
    await act(async () => {
      fireEvent.click(submitButton());
      await Promise.resolve();
    });
    expect(api.store.report).toHaveBeenCalledExactlyOnceWith({
      harnessId: 'alice/writer',
      version: '1.2.0',
      reason: 'other',
      details: 'x'.repeat(1975),
      contactEmail: 'me@example.com',
    });
  });

  it('keeps everything typed when the Store does not answer, and Retry sends it again', async () => {
    const api = setup();
    api.store.report.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'store_unreachable',
        messageKey: 'error.store_unreachable',
        message: 'The Store did not answer.',
      },
    });
    await reportFromDetail();
    fireEvent.click(dialog().getByRole('radio', { name: 'Malicious behaviour' }));
    fireEvent.change(dialog().getByLabelText('Details (optional)'), {
      target: { value: 'It uploads my files.' },
    });
    fireEvent.change(dialog().getByLabelText('Contact email (optional)'), {
      target: { value: 'me@example.com' },
    });
    await act(async () => {
      fireEvent.click(submitButton());
      await Promise.resolve();
    });

    expect(
      await dialog().findByText('The Store did not answer. Check your connection and try again.'),
    ).toBeDefined();
    expect(dialog().getByRole('radio', { name: 'Malicious behaviour' })).toHaveProperty(
      'checked',
      true,
    );
    expect(dialog().getByLabelText('Details (optional)')).toHaveProperty(
      'value',
      'It uploads my files.',
    );
    expect(dialog().getByLabelText('Contact email (optional)')).toHaveProperty(
      'value',
      'me@example.com',
    );
    expect(screen.queryByText('Thanks, a reviewer will look at this.')).toBeNull();

    // Retry, without retyping anything.
    const retry = dialog().getByRole('button', { name: 'Retry' });
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });
    expect(await screen.findByText('Thanks, a reviewer will look at this.')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.store.report).toHaveBeenCalledTimes(2);
    const sent = {
      harnessId: 'alice/writer',
      version: '1.2.0',
      reason: 'malware',
      details: 'It uploads my files.',
      contactEmail: 'me@example.com',
    };
    expect(api.store.report.mock.calls).toEqual([[sent], [sent]]);
  });

  it('blocks a 4th Report of one Harness without calling store.report', async () => {
    const api = setup('en', [installed()]);
    await renderApp('#/library');
    for (let sent = 0; sent < 3; sent++) {
      await reportFromLibrary();
      fireEvent.click(dialog().getByRole('radio', { name: 'Spam' }));
      await act(async () => {
        fireEvent.click(submitButton());
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    }
    expect(api.store.report).toHaveBeenCalledTimes(3);

    await reportFromLibrary();
    expect(dialog().getByText("You've already reported this Harness recently")).toBeDefined();
    expect(
      dialog().getByText(
        'You can report a Harness up to 3 times in 24 hours. A reviewer will look at your earlier Reports.',
      ),
    ).toBeDefined();
    expect(dialog().queryByRole('radio')).toBeNull();
    expect(dialog().queryByRole('button', { name: 'Submit' })).toBeNull();
    fireEvent.click(dialog().getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.store.reportInfo).toHaveBeenCalledTimes(4);
    expect(api.store.report).toHaveBeenCalledTimes(3);
  });

  it('shows the same gentle message when the Store’s own limit refuses the Report', async () => {
    const api = setup();
    api.store.report.mockResolvedValueOnce({
      ok: false,
      error: { code: 'rate_limited', messageKey: 'error.rate_limited', message: 'Too many.' },
    });
    await reportFromDetail();
    fireEvent.click(dialog().getByRole('radio', { name: 'Spam' }));
    await act(async () => {
      fireEvent.click(submitButton());
      await Promise.resolve();
    });
    expect(
      await dialog().findByText("You've already reported this Harness recently"),
    ).toBeDefined();
    // Not the publish limit's words, nor this install's rule, which did not refuse it.
    expect(screen.queryByText(/published too many versions/)).toBeNull();
    expect(dialog().queryByText(/up to 3 times in 24 hours/)).toBeNull();
    expect(dialog().queryByRole('button', { name: 'Retry' })).toBeNull();
    // The Submit button that had focus is gone: focus is on Close, so Escape still closes.
    const close = dialog().getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.store.report).toHaveBeenCalledTimes(1);
  });

  it('shows the error and only Close when the client info cannot be read, and sends nothing', async () => {
    const api = setup();
    api.store.reportInfo
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'internal_error',
          messageKey: 'error.internal_error',
          message: 'Something went wrong inside Harness Store.',
        },
      })
      .mockRejectedValueOnce(new Error('IPC gone'));
    for (let attempt = 0; attempt < 2; attempt++) {
      await reportFromDetail();
      expect(dialog().getByText(/Something went wrong inside Harness Store/)).toBeDefined();
      expect(dialog().queryByRole('radio')).toBeNull();
      expect(screen.getByRole('dialog').querySelector('dl')).toBeNull();
      expect(
        dialog()
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Close']);
      fireEvent.click(dialog().getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      cleanup();
    }
    expect(api.store.reportInfo).toHaveBeenCalledTimes(2);
    expect(api.store.report).not.toHaveBeenCalled();
  });

  it('offers Report on a page built from a Store install the Store no longer offers, never on a local one or the gone page', async () => {
    const gone: IpcResult<StoreDetail> = {
      ok: true,
      data: { platform: 'darwin-arm64', storeStatus: 'unpublished', harness: null },
    };
    const api = setup('en', [installed({ storeStatus: 'unpublished' })]);
    api.store.detail.mockResolvedValue(gone);
    await reportFromDetail();
    expect(shownInfo()).toMatchObject({ Version: '1.0.0' });
    cleanup();

    const local = setup('en', [installed({ source: 'local', storeStatus: null })]);
    local.store.detail.mockResolvedValue(gone);
    await renderApp('#/store/h/alice/writer');
    await screen.findByRole('heading', { name: 'Writer' });
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
    cleanup();

    const nothing = setup();
    nothing.store.detail.mockResolvedValue(gone);
    await renderApp('#/store/h/alice/writer');
    await screen.findByRole('heading', { name: 'This Harness is no longer available' });
    expect(screen.queryByRole('button', { name: 'Report' })).toBeNull();
  });

  it('speaks zh-CN', async () => {
    const api = setup('zh-CN', [installed()]);
    await reportFromDetail('举报', '举报 Writer');
    expect(
      dialog()
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['恶意行为', '绕过 Model Gateway', '无法使用', '不当内容', '垃圾信息', '其他']);
    expect(
      dialog().getByText('随举报发送：Harness ID、版本、平台、应用版本、一个随机的安装 ID'),
    ).toBeDefined();
    expect(Object.keys(shownInfo())).toEqual(['Harness ID', '版本', '平台', '应用版本', '安装 ID']);
    expect(dialog().getByText('还可输入 2000 个字符')).toBeDefined();
    fireEvent.click(dialog().getByRole('radio', { name: '其他' }));
    await act(async () => {
      fireEvent.click(dialog().getByRole('button', { name: '提交' }));
      await Promise.resolve();
    });
    expect(api.store.report).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('感谢反馈，审核人员会尽快查看。')).toBeDefined();
  });

  it('says so in zh-CN when the limit is reached', async () => {
    const api = setup('zh-CN', [installed()]);
    api.store.reportInfo.mockResolvedValue({
      ok: true,
      data: {
        installId: FAKE_INSTALL_ID,
        platform: 'darwin-arm64',
        appVersion: '4.5.6',
        rateLimited: true,
      },
    });
    await renderApp('#/library');
    await reportFromLibrary('举报');
    expect(dialog().getByText('你最近已经举报过这个 Harness')).toBeDefined();
    expect(api.store.report).not.toHaveBeenCalled();
  });
});
