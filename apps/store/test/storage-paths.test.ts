import { describe, expect, it } from 'vitest';
import {
  assetUploads,
  iconPath,
  packagePath,
  screenshotUploads,
} from '../supabase/functions/_shared/storage-paths.ts';

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
    expect(screenshotUploads('alice/x', '1.0.0', files)).toEqual([
      { file: 'assets/a.png', path: 'alice/x/1.0.0/screenshots/0.png', contentType: 'image/png' },
      {
        file: 'assets/b.JPEG',
        path: 'alice/x/1.0.0/screenshots/1.jpeg',
        contentType: 'image/jpeg',
      },
      { file: 'assets/c.jpg', path: 'alice/x/1.0.0/screenshots/2.jpg', contentType: 'image/jpeg' },
    ]);
  });

  it('upload the icon first, then the screenshots', () => {
    expect(assetUploads('alice/x', '1.0.0', ['assets/icon.png', 'assets/s.png'])).toEqual([
      { file: 'assets/icon.png', path: 'alice/x/1.0.0/icon.png', contentType: 'image/png' },
      { file: 'assets/s.png', path: 'alice/x/1.0.0/screenshots/0.png', contentType: 'image/png' },
    ]);
  });
});
