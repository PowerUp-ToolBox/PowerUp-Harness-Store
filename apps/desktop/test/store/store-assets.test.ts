/**
 * Ticket P0-09.1: the Store's images reach the main window as `store-asset:` URLs, which
 * src/main/index.ts serves from the Store's public `harness-assets` bucket only.
 */
import { describe, expect, it } from 'vitest';
import { storeAssetSource, storeAssetUrl } from '../../src/main/runtime/store-assets.js';

const STORE = 'http://127.0.0.1:54321';
const BUCKET = `${STORE}/storage/v1/object/public/harness-assets`;

describe('storeAssetUrl', () => {
  it('names a bucket path under store-asset://harness-assets/', () => {
    expect(storeAssetUrl('alice/hello-web/0.1.0/icon.png')).toBe(
      'store-asset://harness-assets/alice/hello-web/0.1.0/icon.png',
    );
    expect(storeAssetUrl('alice/hello web/0.1.0/图.png')).toBe(
      'store-asset://harness-assets/alice/hello%20web/0.1.0/%E5%9B%BE.png',
    );
  });

  it.each([
    '',
    '/alice/icon.png',
    'alice//icon.png',
    'alice/../icon.png',
    'alice/./icon.png',
    'a\\b',
  ])('refuses %j', (path) => {
    expect(storeAssetUrl(path)).toBeNull();
  });
});

describe('storeAssetSource', () => {
  it('maps a store-asset URL to the public bucket of the Store at the base URL', () => {
    expect(
      storeAssetSource('store-asset://harness-assets/alice/hello-web/0.1.0/icon.png', STORE),
    ).toBe(`${BUCKET}/alice/hello-web/0.1.0/icon.png`);
    expect(
      storeAssetSource('store-asset://harness-assets/alice/x/1.0.0/screenshots/0.png', `${STORE}/`),
    ).toBe(`${BUCKET}/alice/x/1.0.0/screenshots/0.png`);
  });

  it('round-trips what storeAssetUrl makes', () => {
    const url = storeAssetUrl('alice/hello web/0.1.0/图.png') ?? '';
    expect(storeAssetSource(url, STORE)).toBe(`${BUCKET}/alice/hello%20web/0.1.0/%E5%9B%BE.png`);
  });

  it.each([
    'https://harness-assets/alice/icon.png',
    'store-asset://harness-packages/alice/hello/0.1.0.zip',
    'store-asset://harness-assets/alice/../../harness-packages/a.zip',
    'store-asset://harness-assets/alice/%2e%2e/b.png',
    'store-asset://harness-assets/alice/%2E%2E/b.png',
    'store-asset://harness-assets/alice/..%2fb.png',
    'store-asset://harness-assets/alice%2F..%2F..%2Fx',
    'store-asset://harness-assets/alice//icon.png',
    'store-asset://harness-assets/',
    'store-asset://harness-assets/alice/icon.png?download=1',
    'store-asset://harness-assets/alice/icon.png#x',
    'store-asset://user@harness-assets/alice/icon.png',
    'store-asset://harness-assets:8080/alice/icon.png',
    'store-asset://harness-assets/alice/%E0%A4%A.png',
    'not a url',
  ])('refuses %s', (url) => {
    expect(storeAssetSource(url, STORE)).toBeNull();
  });
});
