/**
 * What a Harness's Declared Permissions and launch facts mean, in the words the User reads: the
 * consent dialog's list and facts row (P0-05 local installs; P0-10 Store installs and re-consent;
 * P0-09's trust block on the detail page). Pure, so every screen and its tests share one answer.
 *
 * The severity scale follows docs/ux/design-principles.md §4: low (green) for no access or the
 * Data Directory only, medium (yellow) for the Workspace or listed domains, high (red) for the
 * home folder, shell commands or any site. High items carry a one-line consequence.
 */
import type { DeclaredPermissions } from '@harness-store/manifest';
import type { MessageKey } from './i18n/catalogs.js';
import type { ManifestSummary } from './ipc.js';

export type PermissionSeverity = 'low' | 'medium' | 'high';

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
 * Explicit paths are listed like domains (medium): the Publisher named exactly what they reach.
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
        severity: 'medium',
        messageKey: 'permission.filesystem.paths',
        params: { paths: (filesystem.paths ?? []).join(', ') },
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
export function harnessFacts(
  summary: Pick<ManifestSummary, 'runtimeKind' | 'uiKind' | 'workspace'>,
): MessageKey[] {
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
