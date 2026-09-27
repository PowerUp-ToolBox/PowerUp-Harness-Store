import type { DeclaredPermissions, Entry, Manifest } from './manifest.generated.js';

/** Why an update needs the User's consent again. */
export type ReconsentReason = 'permissions_widened' | 'entry_changed' | 'runtime_kind_changed';

/**
 * What changed between two Harness Versions that the User consented to: the Declared
 * Permissions, the Entry and the runtime kind.
 */
export interface ReconsentDiff {
  /** True exactly when `reasons` is not empty. */
  required: boolean;
  /** In this order, each at most once: `permissions_widened`, `entry_changed`, `runtime_kind_changed`. */
  reasons: ReconsentReason[];
  /**
   * What the next version declares that the previous one did not, as `<Manifest path>` or
   * `<Manifest path>:<value>` items (see {@link diffForReconsent}), in Manifest order.
   */
  added: string[];
  /** What the previous version declared that the next one does not, in the same form. */
  removed: string[];
}

/** Filesystem scopes from narrowest to widest (manifest-spec §6; the P0-01 spec's ladder). */
const SCOPE_LADDER = ['none', 'workspace', 'home', 'paths'] as const;

const REASON_ORDER: readonly ReconsentReason[] = [
  'permissions_widened',
  'entry_changed',
  'runtime_kind_changed',
];

/**
 * Compares two valid Manifests (the `manifest` of an ok ValidationResult) of the same Harness and
 * says whether updating from `previous` to `next` needs the User's consent again. The update
 * flow and the Store share this one definition of "widened".
 *
 * Re-consent is required when:
 * - `permissions_widened`: `filesystem.scope` moves up the ladder none < workspace < home <
 *   paths, or the scope stays `paths` and a path is added; `shell` goes from false to true;
 *   `network` adds a domain to its list, or moves from a list to `any: true`.
 * - `entry_changed`: the value of `entry` changes in any way (a path, or the per-platform map).
 * - `runtime_kind_changed`: `runtime.kind` differs.
 *
 * Narrowing (a lower scope, a removed path or domain, `shell` turned off, `any` replaced by a
 * list) never requires re-consent.
 *
 * `added` and `removed` list the differences for the update prompt ("New:" and "Removed:"
 * lines), each item a Manifest path, with the value after the first `:` when there is one:
 * `permissions.filesystem.scope:home`, `permissions.filesystem.paths:~/notes`,
 * `permissions.shell`, `permissions.network.any`, `permissions.network.domains:api.github.com`,
 * `entry:dist/index.js`, `entry.linux-x64:bin/tool`, `runtime.kind:binary`. Only what takes
 * effect counts: `paths` outside scope `paths` and `domains` next to `any: true` are ignored by
 * the Runtime, so they are neither added nor removed, and a domain is not "removed" when `any`
 * now allows it (nor "added" when `any` allowed it before). So `removed` may list a narrowing
 * and `added` a change that is not a widening, such as the new scope after a narrowing.
 */
export function diffForReconsent(previous: Manifest, next: Manifest): ReconsentDiff {
  const before = effectivePermissions(previous.permissions);
  const after = effectivePermissions(next.permissions);
  const added: string[] = [];
  const removed: string[] = [];
  const reasons = new Set<ReconsentReason>();

  const scopeRank = (scope: string) => SCOPE_LADDER.indexOf(scope as (typeof SCOPE_LADDER)[number]);
  if (before.scope !== after.scope) {
    added.push(`permissions.filesystem.scope:${after.scope}`);
    removed.push(`permissions.filesystem.scope:${before.scope}`);
    if (scopeRank(after.scope) > scopeRank(before.scope)) reasons.add('permissions_widened');
  }
  const newPaths = difference(after.paths, before.paths);
  added.push(...newPaths.map((path) => `permissions.filesystem.paths:${path}`));
  removed.push(
    ...difference(before.paths, after.paths).map((path) => `permissions.filesystem.paths:${path}`),
  );
  if (before.scope === 'paths' && after.scope === 'paths' && newPaths.length > 0) {
    reasons.add('permissions_widened');
  }

  if (before.shell !== after.shell) {
    (after.shell ? added : removed).push('permissions.shell');
    if (after.shell) reasons.add('permissions_widened');
  }

  if (before.anyNetwork !== after.anyNetwork) {
    (after.anyNetwork ? added : removed).push('permissions.network.any');
    if (after.anyNetwork) reasons.add('permissions_widened');
  }
  // A domain `any` allows is neither new (when `any` allowed it before) nor gone (when it does now).
  const newDomains = before.anyNetwork ? [] : difference(after.domains, before.domains);
  const goneDomains = after.anyNetwork ? [] : difference(before.domains, after.domains);
  added.push(...newDomains.map((domain) => `permissions.network.domains:${domain}`));
  removed.push(...goneDomains.map((domain) => `permissions.network.domains:${domain}`));
  if (newDomains.length > 0) reasons.add('permissions_widened');

  const entryBefore = entryItems(previous.entry);
  const entryAfter = entryItems(next.entry);
  const newEntries = difference(entryAfter, entryBefore);
  const goneEntries = difference(entryBefore, entryAfter);
  added.push(...newEntries);
  removed.push(...goneEntries);
  if (newEntries.length > 0 || goneEntries.length > 0) reasons.add('entry_changed');

  if (previous.runtime.kind !== next.runtime.kind) {
    added.push(`runtime.kind:${next.runtime.kind}`);
    removed.push(`runtime.kind:${previous.runtime.kind}`);
    reasons.add('runtime_kind_changed');
  }

  const ordered = REASON_ORDER.filter((reason) => reasons.has(reason));
  return { required: ordered.length > 0, reasons: ordered, added, removed };
}

interface EffectivePermissions {
  scope: string;
  /** Only for scope `paths`: other scopes ignore the list. */
  paths: readonly string[];
  shell: boolean;
  anyNetwork: boolean;
  /** Only without `any`: `any: true` ignores the list. */
  domains: readonly string[];
}

/** The Declared Permissions as the Runtime reads them, ignoring keys that have no effect. */
function effectivePermissions(permissions: DeclaredPermissions): EffectivePermissions {
  const { filesystem, shell, network } = permissions;
  const anyNetwork = network.any === true;
  return {
    scope: filesystem.scope,
    paths: filesystem.scope === 'paths' ? (filesystem.paths ?? []) : [],
    shell,
    anyNetwork,
    domains: anyNetwork ? [] : (network.domains ?? []),
  };
}

/** `entry:<path>`, or `entry.<platform>:<path>` for each platform of a per-platform Entry. */
function entryItems(entry: Entry): string[] {
  if (typeof entry === 'string') return [`entry:${entry}`];
  return Object.entries(entry).map(([platform, path]) => `entry.${platform}:${path}`);
}

/** The items of `list` not in `other`, in `list`'s order, without repeats. */
function difference(list: readonly string[], other: readonly string[]): string[] {
  const exclude = new Set(other);
  return [...new Set(list)].filter((item) => !exclude.has(item));
}
