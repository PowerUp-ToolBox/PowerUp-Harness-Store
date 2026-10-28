import type { Platform } from '@harness-store/manifest';
import semver from 'semver';
import type { HarnessStoreStatus, InstalledHarness } from '../../../shared/ipc.js';

/**
 * The primary button of a Store detail page (P0-09.3; docs/ux/design-principles.md §3): "Removed
 * from Store" (disabled), "Not available for your platform" (disabled), Install, Launch
 * (secondary: Uninstall), Update (secondary: Launch), "Review update" for an update that needs
 * the User's consent again (secondary: Launch), a download's progress with Cancel, and "Review
 * and install" for a download that waits for the User's consent (P0-10).
 */
export type PrimaryActionState =
  | 'removed'
  | 'unsupported'
  | 'install'
  | 'launch'
  | 'update'
  | 'reviewUpdate'
  | 'downloading'
  | 'review';

export interface PrimaryActionInput {
  /** The Harness's status in the Store. */
  readonly storeStatus: HarnessStoreStatus;
  /** The Store's latest published version; null when it has none. */
  readonly latestVersion: string | null;
  /** The platforms that version's Manifest declares. */
  readonly latestPlatforms: readonly Platform[];
  /** This machine's platform; null when no Manifest can declare it. */
  readonly platform: Platform | null;
  /** The installed Harness, if any. */
  readonly install: Pick<InstalledHarness, 'version' | 'source' | 'platformSupported'> | null;
  /** A download of it is in progress (P0-10). */
  readonly downloading: boolean;
  /** Its download is done and waits for the User's consent (P0-10). */
  readonly awaitingConsent?: boolean;
  /**
   * Updating to the latest version needs the User's consent again: `diffForReconsent` of the
   * installed and the latest Manifest is `required` (P0-10.2).
   */
  readonly updateNeedsConsent?: boolean;
}

/**
 * Which state the primary button is in, evaluated on every render:
 *
 * - A download in progress shows its progress, whatever else is true; one that waits for consent
 *   shows "Review and install", which opens the consent dialog again.
 * - An installed Harness is judged by its install, as the Library judges it: not runnable here
 *   ("Not available for your platform"), else Update (or "Review update" when it needs consent
 *   again) when the Store's latest version is greater (semver) than the installed one of a Store
 *   install and declares this machine's platform (the Store has no package for another), else
 *   Launch. A Harness the Store no longer
 *   offers (taken down, Unpublished-only, unknown) stays launchable and is never updated
 *   (docs/ux/flows.md F4 step 4); a local install is never updated from the Store.
 * - A Harness that is not installed is "Removed from Store" when the Store does not offer it,
 *   "Not available for your platform" when its latest Manifest does not declare this machine's
 *   platform, else Install.
 */
export function primaryActionState(input: PrimaryActionInput): PrimaryActionState {
  const { install } = input;
  if (input.downloading) return 'downloading';
  if (input.awaitingConsent === true) return 'review';
  if (install !== null) {
    if (!install.platformSupported) return 'unsupported';
    if (
      input.storeStatus === 'available' &&
      install.source === 'store' &&
      input.latestVersion !== null &&
      semver.lt(install.version, input.latestVersion) &&
      input.platform !== null &&
      input.latestPlatforms.includes(input.platform)
    ) {
      return input.updateNeedsConsent === true ? 'reviewUpdate' : 'update';
    }
    return 'launch';
  }
  if (input.storeStatus !== 'available') return 'removed';
  if (input.platform === null || !input.latestPlatforms.includes(input.platform)) {
    return 'unsupported';
  }
  return 'install';
}
