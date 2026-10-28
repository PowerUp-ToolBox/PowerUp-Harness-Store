/**
 * What a Harness's Declared Permissions and launch facts mean, in the words the User reads: the
 * consent dialog's list and facts row (P0-05 local installs; P0-10 Store installs, and the update
 * prompt's "What changed"; P0-09's trust block on the detail page). Pure, so every screen and its
 * tests share one answer.
 *
 * The severity scale follows docs/ux/design-principles.md §4: low (green) for no access or the
 * Data Directory only, medium (yellow) for the Workspace or listed domains, high (red) for the
 * home folder, listed paths, shell commands or any site. High items carry a one-line consequence.
 */
import {
  SCOPE_LADDER,
  type DeclaredPermissions,
  type Manifest,
  type ReconsentDiff,
} from '@harness-store/manifest';
import type { MessageKey } from './i18n/catalogs.js';
import type { ManifestSummary } from './ipc.js';

export type PermissionSeverity = 'low' | 'medium' | 'high';

/** What the trust block shows of a Harness: its Declared Permissions and how it runs. */
export type TrustFacts = Pick<
  ManifestSummary,
  'permissions' | 'runtimeKind' | 'uiKind' | 'workspace'
>;

/** The trust facts of a Manifest; a Manifest without `workspace` asks for none. */
export function trustFactsOf(manifest: Manifest): TrustFacts {
  return {
    permissions: manifest.permissions,
    runtimeKind: manifest.runtime.kind,
    uiKind: manifest.ui.kind,
    workspace: manifest.workspace ?? 'none',
  };
}

/** One line of the permission list: a catalog key with its arguments, and how serious it is. */
export interface PermissionItem {
  readonly severity: PermissionSeverity;
  readonly messageKey: MessageKey;
  readonly params?: Readonly<Record<string, string>>;
  /** What a high-severity permission lets the Harness do, for the line under it. */
  readonly consequenceKey?: MessageKey;
}

/** The catalog key of each severity's label (Low, Medium, High). */
export const SEVERITY_LABEL: Readonly<Record<PermissionSeverity, MessageKey>> = {
  low: 'permission.severity.low',
  medium: 'permission.severity.medium',
  high: 'permission.severity.high',
};

/**
 * The permission list, in a fixed order: files, then shell, then network. File access is always
 * listed (its scope is required), shell only when the Harness runs commands, network always.
 * Explicit paths are high, like the home folder: a path may be `~`, a disk root or any folder
 * outside the Workspace, and the Manifest's re-consent ladder ranks `paths` above `home` too.
 */
export function permissionItems(permissions: DeclaredPermissions): PermissionItem[] {
  const items: PermissionItem[] = [];
  const { filesystem, shell, network } = permissions;
  switch (filesystem.scope) {
    case 'none':
      items.push({ severity: 'low', messageKey: 'permission.filesystem.none' });
      break;
    case 'workspace':
      items.push({ severity: 'medium', messageKey: 'permission.filesystem.workspace' });
      break;
    case 'home':
      items.push({
        severity: 'high',
        messageKey: 'permission.filesystem.home',
        consequenceKey: 'permission.filesystem.home.consequence',
      });
      break;
    case 'paths':
      items.push({
        severity: 'high',
        messageKey: 'permission.filesystem.paths',
        params: { paths: (filesystem.paths ?? []).join(', ') },
        consequenceKey: 'permission.filesystem.paths.consequence',
      });
      break;
  }
  if (shell) {
    items.push({
      severity: 'high',
      messageKey: 'permission.shell',
      consequenceKey: 'permission.shell.consequence',
    });
  }
  if (network.any === true) {
    items.push({
      severity: 'high',
      messageKey: 'permission.network.any',
      consequenceKey: 'permission.network.any.consequence',
    });
  } else if (network.domains !== undefined && network.domains.length > 0) {
    items.push({
      severity: 'medium',
      messageKey: 'permission.network.domains',
      params: { domains: network.domains.join(', ') },
    });
  } else {
    items.push({ severity: 'low', messageKey: 'permission.network.none' });
  }
  return items;
}

/**
 * The facts row: how the Harness runs (bundled Node or a native executable), how it opens (a
 * window or a terminal) and whether it asks for a Workspace.
 */
export function harnessFacts(summary: Omit<TrustFacts, 'permissions'>): MessageKey[] {
  return [
    summary.runtimeKind === 'node' ? 'harness.runtime.node' : 'harness.runtime.binary',
    summary.uiKind === 'web' ? 'harness.ui.web' : 'harness.ui.terminal',
    summary.workspace === 'required'
      ? 'harness.workspace.required'
      : summary.workspace === 'optional'
        ? 'harness.workspace.optional'
        : 'harness.workspace.none',
  ];
}

/** One line of the update prompt's "What changed": a catalog key with its arguments. */
export interface ReconsentChange {
  /** The `diffForReconsent` item it shows, such as `permissions.shell` or `entry:dist/main.js`. */
  readonly item: string;
  /** True for what the new version adds, shown as "New: …"; false for a fact line on its own. */
  readonly markedNew: boolean;
  /** How serious a permission is; null for the Entry and the runtime kind, which are facts. */
  readonly severity: PermissionSeverity | null;
  readonly messageKey: MessageKey;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * The "What changed" list of the update prompt (docs/ux/screens.md, "Update prompt"): one "New:"
 * line per item `diffForReconsent` lists as `added`, in its order, in the words of the permission
 * list and the facts row. What was removed or narrowed is not shown, with two consequences:
 * - A new filesystem scope is shown only when it is wider than the previous one; a narrowed scope
 *   is in `added` too, but it is not new access.
 * - When the Entry changed only by losing a platform's path (a binary Harness that drops a
 *   platform), nothing in `added` explains the re-consent, so each lost path is a fact line of
 *   its own ("No longer starts on linux-x64"), never an empty list.
 */
export function reconsentChanges(
  diff: Pick<ReconsentDiff, 'reasons' | 'added' | 'removed'>,
): ReconsentChange[] {
  const rank = (scope: string) => SCOPE_LADDER.indexOf(scope as (typeof SCOPE_LADDER)[number]);
  const scopePrefix = 'permissions.filesystem.scope:';
  const previousScope = diff.removed.find((item) => item.startsWith(scopePrefix));
  const added = diff.added.filter(
    (item) =>
      !item.startsWith(scopePrefix) ||
      previousScope === undefined ||
      rank(item.slice(scopePrefix.length)) > rank(previousScope.slice(scopePrefix.length)),
  );
  const isEntry = (item: string) => item.startsWith('entry:') || item.startsWith('entry.');
  const lostEntries =
    diff.reasons.includes('entry_changed') && !added.some(isEntry)
      ? diff.removed.filter(isEntry).map((item): ReconsentChange => ({
          item,
          markedNew: false,
          severity: null,
          messageKey: 'update.change.entryGone',
          // `entry.<platform>:<path>`: only a per-platform Entry can lose a path alone.
          params: { platform: item.slice('entry.'.length, item.indexOf(':')) },
        }))
      : [];
  return [...added.map(newChange), ...lostEntries];
}

/** The "New:" line of one `added` item. */
function newChange(item: string): ReconsentChange {
  return { ...newChangeMessage(item), markedNew: true };
}

function newChangeMessage(item: string): Omit<ReconsentChange, 'markedNew'> {
  const colon = item.indexOf(':');
  const path = colon < 0 ? item : item.slice(0, colon);
  const value = colon < 0 ? '' : item.slice(colon + 1);
  switch (path) {
    case 'permissions.filesystem.scope':
      switch (value) {
        case 'none':
          return { item, severity: 'low', messageKey: 'permission.filesystem.none' };
        case 'workspace':
          return { item, severity: 'medium', messageKey: 'permission.filesystem.workspace' };
        case 'home':
          return { item, severity: 'high', messageKey: 'permission.filesystem.home' };
        default:
          return { item, severity: 'high', messageKey: 'update.change.pathsScope' };
      }
    case 'permissions.filesystem.paths':
      return {
        item,
        severity: 'high',
        messageKey: 'permission.filesystem.paths',
        params: { paths: value },
      };
    case 'permissions.shell':
      return { item, severity: 'high', messageKey: 'permission.shell' };
    case 'permissions.network.any':
      return { item, severity: 'high', messageKey: 'permission.network.any' };
    case 'permissions.network.domains':
      return {
        item,
        severity: 'medium',
        messageKey: 'permission.network.domains',
        params: { domains: value },
      };
    case 'runtime.kind':
      return {
        item,
        severity: null,
        messageKey: value === 'binary' ? 'harness.runtime.binary' : 'harness.runtime.node',
      };
    case 'entry':
      return {
        item,
        severity: null,
        messageKey: 'update.change.entry',
        params: { entry: value },
      };
    default: {
      // `entry.<platform>`, the Entry of one platform of a binary Harness.
      const platform = path.slice('entry.'.length);
      return {
        item,
        severity: null,
        messageKey: 'update.change.platformEntry',
        params: { entry: value, platform },
      };
    }
  }
}
