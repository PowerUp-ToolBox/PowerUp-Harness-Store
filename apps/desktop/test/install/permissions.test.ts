import type { DeclaredPermissions } from '@harness-store/manifest';
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../../src/shared/i18n/translate.js';
import { harnessFacts, permissionItems } from '../../src/shared/permissions.js';

/**
 * The consent dialog's sentences for Declared Permissions and launch facts
 * (docs/ux/design-principles.md §4): severity per item and the copy of the design demo.
 */

const en = translatorFor('en');

/** Each item as "<severity> <sentence> [— consequence]" in English. */
function describePermissions(permissions: DeclaredPermissions): string[] {
  return permissionItems(permissions).map(
    (item) =>
      `${item.severity} ${en.t(item.messageKey, item.params)}` +
      (item.consequenceKey === undefined ? '' : ` — ${en.t(item.consequenceKey)}`),
  );
}

describe('permissionItems', () => {
  it.each<[string, DeclaredPermissions, string[]]>([
    [
      'nothing beyond its Data Directory',
      { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
      ['low Uses only its own data directory', 'low No network access besides the Model Gateway'],
    ],
    [
      'the Workspace and listed domains',
      {
        filesystem: { scope: 'workspace' },
        shell: false,
        network: { domains: ['api.github.com', '*.example.com'] },
      },
      [
        'medium Reads and writes files in the folder you choose',
        'medium Connects to: api.github.com, *.example.com',
      ],
    ],
    [
      'the home folder, shell commands and any site',
      { filesystem: { scope: 'home' }, shell: true, network: { any: true } },
      [
        'high Accesses your home folder — It can read and change any of your files.',
        'high Runs shell commands — It can run any program on your machine as you.',
        'high Connects to the internet (any site) — It can send data to any server.',
      ],
    ],
    [
      // A listed path can be as wide as the home folder or wider, so it is never shown milder.
      'listed paths',
      {
        filesystem: { scope: 'paths', paths: ['~/notes', '/tmp/out'] },
        shell: false,
        network: { domains: [] },
      },
      [
        'high Reads and writes these paths: ~/notes, /tmp/out — It can read and change any file under these paths.',
        'low No network access besides the Model Gateway',
      ],
    ],
    [
      'the home folder or a disk root as a listed path',
      {
        filesystem: { scope: 'paths', paths: ['~', '/'] },
        shell: false,
        network: { domains: [] },
      },
      [
        'high Reads and writes these paths: ~, / — It can read and change any file under these paths.',
        'low No network access besides the Model Gateway',
      ],
    ],
  ])('%s', (_name, permissions, expected) => {
    expect(describePermissions(permissions)).toEqual(expected);
  });

  it('renders every sentence in zh-CN too', () => {
    const zh = translatorFor('zh-CN');
    const items = permissionItems({
      filesystem: { scope: 'home' },
      shell: true,
      network: { domains: ['api.github.com'] },
    });
    expect(items.map((item) => zh.t(item.messageKey, item.params))).toEqual([
      '访问你的用户主目录',
      '会执行命令行命令',
      '访问以下网站：api.github.com',
    ]);
  });
});

describe('harnessFacts', () => {
  it('names the runtime kind, the UI Kind and the Workspace', () => {
    expect(
      harnessFacts({ runtimeKind: 'node', uiKind: 'web', workspace: 'none' }).map((key) =>
        en.t(key),
      ),
    ).toEqual(['Runs on the bundled Node runtime', 'Opens as a window', 'No Workspace']);
    expect(
      harnessFacts({ runtimeKind: 'binary', uiKind: 'terminal', workspace: 'required' }).map(
        (key) => en.t(key),
      ),
    ).toEqual(['Native executable', 'Opens in a terminal', 'Needs a folder to work in']);
    expect(
      harnessFacts({ runtimeKind: 'node', uiKind: 'web', workspace: 'optional' }).map((key) =>
        en.t(key),
      ),
    ).toContain('Can use a folder you choose');
  });
});
