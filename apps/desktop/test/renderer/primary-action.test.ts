/**
 * Ticket P0-09.3: the Store detail page's primary button state machine as a table, one row per
 * scenario of the ticket plus the decisions around them: an installed Harness the Store no longer
 * offers stays Launch, a local install is never updated, and an installed version equal to or
 * newer than the Store's is Launch.
 */
import { describe, expect, it } from 'vitest';
import {
  primaryActionState,
  type PrimaryActionInput,
  type PrimaryActionState,
} from '../../src/renderer/src/store/primary-action.js';

const AVAILABLE: PrimaryActionInput = {
  storeStatus: 'available',
  latestVersion: '1.2.0',
  latestPlatforms: ['darwin-arm64', 'linux-x64'],
  platform: 'darwin-arm64',
  install: null,
  downloading: false,
};

const installed = (
  version: string,
  fields: Partial<NonNullable<PrimaryActionInput['install']>> = {},
) => ({
  version,
  source: 'store' as const,
  platformSupported: true,
  ...fields,
});

describe('primaryActionState', () => {
  it.each<[string, Partial<PrimaryActionInput>, PrimaryActionState]>([
    // The ticket's six scenarios.
    ['taken down', { storeStatus: 'taken_down', latestVersion: null }, 'removed'],
    ['no version for this OS', { platform: 'win32-x64' }, 'unsupported'],
    ['not installed', {}, 'install'],
    ['installed, same version', { install: installed('1.2.0') }, 'launch'],
    ['installed, older version', { install: installed('1.1.9') }, 'update'],
    ['downloading', { downloading: true }, 'downloading'],
    // Around them.
    [
      'Unpublished-only, not installed',
      { storeStatus: 'unpublished', latestVersion: null },
      'removed',
    ],
    ['unknown, not installed', { storeStatus: 'not_found', latestVersion: null }, 'removed'],
    ['a platform no Manifest can declare', { platform: null }, 'unsupported'],
    ['installed, newer than the Store', { install: installed('1.3.0') }, 'launch'],
    ['installed pre-release of the latest', { install: installed('1.2.0-beta.1') }, 'update'],
    [
      'a local install with an older version',
      { install: installed('1.0.0', { source: 'local' }) },
      'launch',
    ],
    [
      'installed, taken down',
      { storeStatus: 'taken_down', latestVersion: null, install: installed('1.0.0') },
      'launch',
    ],
    [
      'installed, Unpublished-only',
      { storeStatus: 'unpublished', latestVersion: null, install: installed('1.0.0') },
      'launch',
    ],
    [
      'installed, not runnable here',
      { install: installed('1.0.0', { platformSupported: false }) },
      'unsupported',
    ],
    ['an update downloading', { install: installed('1.0.0'), downloading: true }, 'downloading'],
  ])('%s → %s', (_scenario, input, expected) => {
    expect(primaryActionState({ ...AVAILABLE, ...input })).toBe(expected);
  });
});
