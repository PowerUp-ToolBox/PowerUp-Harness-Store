import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  harnessFrameNavigation,
  harnessNavigation,
  harnessPartition,
  isAllowedExternalUrl,
  mainWindowOptions,
  terminalWindowOptions,
  webContentPreferences,
  webWindowOptions,
} from '../src/main/runtime/main-window.js';

describe('mainWindowOptions', () => {
  const options = mainWindowOptions(
    { x: 10, y: 20, width: 1200, height: 760, isMaximized: true },
    '/app/out/preload/index.cjs',
  );

  it('sandboxes the renderer: context isolation, sandbox, no Node integration', () => {
    expect(options.webPreferences).toEqual({
      preload: '/app/out/preload/index.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
    });
  });

  it('uses the restored bounds, a 960×640 minimum, and shows the window only when ready', () => {
    expect(options).toMatchObject({
      x: 10,
      y: 20,
      width: 1200,
      height: 760,
      minWidth: 960,
      minHeight: 640,
      show: false,
    });
  });
});

describe('terminalWindowOptions', () => {
  const options = terminalWindowOptions('Hello Term', '/app/out/preload/harness.cjs');

  it('sandboxes the Harness window page as the main window is, with its own preload', () => {
    expect(options.webPreferences).toEqual({
      preload: '/app/out/preload/harness.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
    });
  });

  it('is 960×640, titled with the Harness name, and shown only when ready', () => {
    expect(options).toMatchObject({
      width: 960,
      height: 640,
      title: 'Hello Term — Harness Store',
      show: false,
    });
  });
});

describe('isAllowedExternalUrl', () => {
  it.each([
    ['https://ollama.com/download', true],
    ['http://example.com', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('%s → %s', (url, allowed) => {
    expect(isAllowedExternalUrl(url)).toBe(allowed);
  });
});

describe('renderer Content Security Policy', () => {
  // index.html: the main window; harness.html: a Harness window's own page.
  it.each(['index.html', 'harness.html'])('%s ships the strict production policy', (page) => {
    const html = readFileSync(new URL(`../src/renderer/${page}`, import.meta.url), 'utf8');
    const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(policy?.split('; ')).toEqual([
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
  });
});

describe('web Harness windows (P0-05.3)', () => {
  it("open at the Manifest's size hints for the page, plus the top bar, sandboxed", () => {
    const options = webWindowOptions('Hello Web', '/app/out/preload/harness.cjs', {
      width: 900,
      height: 600,
    });
    expect(options).toMatchObject({
      title: 'Hello Web — Harness Store',
      width: 900,
      height: 644,
      useContentSize: true,
      show: false,
      webPreferences: {
        preload: '/app/out/preload/harness.cjs',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    expect(webWindowOptions('Hello Web', '/p.cjs')).toMatchObject({ width: 1100, height: 804 });
  });

  it("load the Harness's page with no preload, sandboxed, isolated, in its own session", () => {
    const preferences = webContentPreferences('acme/hello-web');
    // No preload at all: page script reaches neither Node nor Electron IPC.
    expect(preferences).not.toHaveProperty('preload');
    expect(preferences).toEqual({
      partition: 'persist:harness:acme/hello-web',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      safeDialogs: true,
    });
    expect(harnessPartition('acme/other')).toBe('persist:harness:acme/other');
  });

  it.each([
    ['http://127.0.0.1:52341/', 'inside'],
    ['http://127.0.0.1:52341/chat?id=1#end', 'inside'],
    ['http://127.0.0.1:52342/', 'external'],
    ['http://localhost:52341/', 'external'],
    ['https://127.0.0.1:52341/', 'external'],
    ['https://example.com/', 'external'],
    ['http://example.com/', 'external'],
    ['file:///etc/passwd', 'blocked'],
    ['javascript:alert(1)', 'blocked'],
    ['data:text/html,hi', 'blocked'],
    ['harnessstore://auth-callback', 'blocked'],
    ['about:blank', 'blocked'],
    ['not a url', 'blocked'],
  ])('keep %s %s', (url, where) => {
    expect(harnessNavigation(url, 'http://127.0.0.1:52341')).toBe(where);
  });

  it('guards main-frame navigations and redirects by the same rule', () => {
    const origin = 'http://127.0.0.1:52341';
    expect(harnessFrameNavigation({ url: `${origin}/next`, isMainFrame: true }, origin)).toBe(
      'inside',
    );
    expect(harnessFrameNavigation({ url: 'https://example.com/', isMainFrame: true }, origin)).toBe(
      'external',
    );
    expect(harnessFrameNavigation({ url: 'file:///etc/passwd', isMainFrame: true }, origin)).toBe(
      'blocked',
    );
  });

  it('leaves an iframe redirect alone: neither cancelled nor opened in the browser', () => {
    // An embedded widget whose server redirects http to https, as `will-redirect` reports it.
    expect(
      harnessFrameNavigation(
        { url: 'https://example.com/widget', isMainFrame: false },
        'http://127.0.0.1:52341',
      ),
    ).toBe('inside');
  });
});
