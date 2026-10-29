/**
 * Ticket P0-09.3: the Store detail page's primary button state machine as a table, one row per
 * scenario of the ticket plus the decisions around them: an installed Harness the Store no longer
 * offers stays Launch, a local install is never updated, and an installed version equal to or
 * newer than the Store's is Launch. P0-10.1 adds "Review and install" for a download waiting for
 * consent, which only a download in progress comes before; P0-10.2 "Review update", and Update
 * only for a latest version that declares this platform.
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
    // P0-10.1: a download waiting for consent; a download in progress still comes first.
    ['waiting for consent', { awaitingConsent: true }, 'review'],
    [
      'downloading and waiting for consent',
      { downloading: true, awaitingConsent: true },
      'downloading',
    ],
    [
      'waiting for consent, taken down meanwhile',
      { awaitingConsent: true, storeStatus: 'taken_down', latestVersion: null },
      'review',
    ],
    [
      'waiting for consent, no longer for this OS',
      { awaitingConsent: true, platform: 'win32-x64' },
      'review',
    ],
    [
      'waiting for consent, installed meanwhile',
      { awaitingConsent: true, install: installed('1.2.0') },
      'review',
    ],
    // P0-10.2: an update that needs consent again; one the Store has no package for here.
    [
      'installed, older version, the update needs consent again',
      { install: installed('1.1.9'), updateNeedsConsent: true },
      'reviewUpdate',
    ],
    [
      'installed, same version, the Store Manifest would need consent',
      { install: installed('1.2.0'), updateNeedsConsent: true },
      'launch',
    ],
    [
      'installed, older version, the latest does not declare this OS',
      { install: installed('1.1.9'), latestPlatforms: ['linux-x64'] },
      'launch',
    ],
    [
      'installed, older version, a platform no Manifest can declare',
      { install: installed('1.1.9', { platformSupported: true }), platform: null },
      'launch',
    ],
    [
      'an update needing consent, downloading',
      { install: installed('1.1.9'), updateNeedsConsent: true, downloading: true },
      'downloading',
    ],
  ])('%s → %s', (_scenario, input, expected) => {
    expect(primaryActionState({ ...AVAILABLE, ...input })).toBe(expected);
  });
});
