import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isAllowedExternalUrl,
  mainWindowOptions,
  terminalWindowOptions,
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
