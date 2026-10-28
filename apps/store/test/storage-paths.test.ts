import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArchiveSource, PACKAGE_LIMITS } from '@harness-store/manifest';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  assetUploads,
  fileSizes,
  iconPath,
  MAX_ASSET_BYTES,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS,
  packagePath,
  screenshotUploads,
} from '../supabase/functions/_shared/storage-paths.ts';

/** Every file of `files` with a small size. */
const small = (files: string[]) => new Map(files.map((file) => [file, 100]));

describe('storage paths', () => {
  it('are relative to their bucket, under <publisher>/<slug>/<version>', () => {
    expect(packagePath('alice/hello-web', '1.2.0-beta.1')).toBe('alice/hello-web/1.2.0-beta.1.zip');
    expect(iconPath('alice/hello-web', '1.2.0')).toBe('alice/hello-web/1.2.0/icon.png');
  });

  it('number screenshots from 0 in package path order and keep their extension, lower-cased', () => {
    const files = [
      'manifest.json',
      'assets/icon.png',
      'assets/b.JPEG',
      'assets/a.png',
      'assets/c.jpg',
      'assets/.DS_Store',
      'assets/nested/d.png',
      'README.md',
    ];
    expect(screenshotUploads('alice/x', '1.0.0', small(files))).toEqual([
      { file: 'assets/a.png', path: 'alice/x/1.0.0/screenshots/0.png', contentType: 'image/png' },
      {
        file: 'assets/b.JPEG',
        path: 'alice/x/1.0.0/screenshots/1.jpeg',
        contentType: 'image/jpeg',
      },
      { file: 'assets/c.jpg', path: 'alice/x/1.0.0/screenshots/2.jpg', contentType: 'image/jpeg' },
    ]);
  });

  it('keep at most five screenshots, the first in package path order', () => {
    expect(MAX_SCREENSHOTS).toBe(PACKAGE_LIMITS.maxScreenshots);
    const files = Array.from(
      { length: 20_000 },
      (_, index) => `assets/${String(index).padStart(5, '0')}.png`,
    ).reverse();
    expect(
      screenshotUploads('alice/x', '1.0.0', small(files)).map((upload) => upload.file),
    ).toEqual([
      'assets/00000.png',
      'assets/00001.png',
      'assets/00002.png',
      'assets/00003.png',
      'assets/00004.png',
    ]);
  });

  it('skip a screenshot over 2 MB, which does not count towards the five', () => {
    expect(MAX_SCREENSHOT_BYTES).toBe(PACKAGE_LIMITS.maxScreenshotBytes);
    const sizes = small([
      'assets/1.png',
      'assets/3.png',
      'assets/4.png',
      'assets/5.png',
      'assets/6.png',
    ]);
    sizes.set('assets/0.png', MAX_SCREENSHOT_BYTES);
    sizes.set('assets/2.png', MAX_SCREENSHOT_BYTES + 1);
    expect(screenshotUploads('alice/x', '1.0.0', sizes).map((upload) => upload.path)).toEqual([
      'alice/x/1.0.0/screenshots/0.png',
      'alice/x/1.0.0/screenshots/1.png',
      'alice/x/1.0.0/screenshots/2.png',
      'alice/x/1.0.0/screenshots/3.png',
      'alice/x/1.0.0/screenshots/4.png',
    ]);
    expect(screenshotUploads('alice/x', '1.0.0', sizes).map((upload) => upload.file)).toEqual([
      'assets/0.png',
      'assets/1.png',
      'assets/3.png',
      'assets/4.png',
      'assets/5.png',
    ]);
  });

  it('upload the icon first, then the screenshots', () => {
    expect(assetUploads('alice/x', '1.0.0', small(['assets/icon.png', 'assets/s.png']))).toEqual([
      { file: 'assets/icon.png', path: 'alice/x/1.0.0/icon.png', contentType: 'image/png' },
      { file: 'assets/s.png', path: 'alice/x/1.0.0/screenshots/0.png', contentType: 'image/png' },
    ]);
  });
});

describe('fileSizes', () => {
  it("gives each file's declared size by the path ArchiveSource.listFiles() gives it", async () => {
    const zip = zipSync({
      './assets/icon.png': new Uint8Array(3),
      'assets//a.png': new Uint8Array(5),
      'assets/': new Uint8Array(),
      'README.md': new Uint8Array(7),
    });
    const source = await ArchiveSource.open(zip);
    const sizes = fileSizes(source.listEntries().entries);
    expect([...sizes.keys()].sort()).toEqual(source.listFiles().sort());
    expect(Object.fromEntries(sizes)).toEqual({
      'assets/icon.png': 3,
      'assets/a.png': 5,
      'README.md': 7,
    });
  });
});

describe('the harness-assets bucket', () => {
  it('accepts objects of at most MAX_ASSET_BYTES, and a kept screenshot is never larger', () => {
    const dir = join(import.meta.dirname, '..', 'supabase', 'migrations');
    const sql = readdirSync(dir)
      .sort()
      .map((file) => readFileSync(join(dir, file), 'utf8'))
      .join('\n');
    const limits = [
      ...sql.matchAll(/set file_size_limit = (\d+)\s+where id = 'harness-assets'/g),
    ].map((match) => Number(match[1]));
    expect(limits.at(-1)).toBe(MAX_ASSET_BYTES);
    expect(MAX_SCREENSHOT_BYTES).toBeLessThan(MAX_ASSET_BYTES);
  });
});
