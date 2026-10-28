/**
 * What the Publish flow (P0-08) leaves out of a Harness Package it builds from a folder: the one
 * home of these rules. Two kinds:
 *
 * - The fixed rules: `.git` at any depth (a folder, or the file a Git worktree has),
 *   `node_modules/.cache/` at any depth, and the files operating systems and editors drop next to
 *   others (`.DS_Store`, `Thumbs.db`, `*.swp`). `examples/<name>/scripts/excluded.mjs` copies them
 *   for the reference Harnesses' build and pack scripts, which stay standalone; a test keeps the
 *   copies in step with {@link isAlwaysExcluded}.
 * - An optional `.harnessignore` at the folder root, in gitignore syntax, relative to that root.
 *   Its `!` patterns cannot bring back what a fixed rule leaves out, and the file itself is left
 *   out too.
 *
 * The `harness-manifest validate` CLI and "Install this folder locally" take the folder as it is:
 * they apply none of these rules.
 */
import ignore from 'ignore';

/** The Publisher's own exclusions, at the folder root. */
export const HARNESS_IGNORE_FILE = '.harnessignore';

/** Whether a fixed rule leaves out the file at `path` (relative, `/`-separated). */
export function isAlwaysExcluded(path: string): boolean {
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  return (
    segments.includes('.git') ||
    path.startsWith('node_modules/.cache/') ||
    path.includes('/node_modules/.cache/') ||
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name.endsWith('.swp')
  );
}

/** The rules for one folder: the fixed ones plus its `.harnessignore`. */
export interface ExclusionRules {
  /** Whether the file (or link) at `path`, relative and `/`-separated, is left out. */
  excludesFile(path: string): boolean;
  /** Whether the folder at `path` (no trailing slash) is left out, with everything in it. */
  excludesFolder(path: string): boolean;
}

/** The rules of a folder whose `.harnessignore` holds `harnessIgnore` (null: it has none). */
export function exclusionRules(harnessIgnore: string | null): ExclusionRules {
  const own = harnessIgnore === null ? null : ignore().add(harnessIgnore);
  return {
    excludesFile: (path) =>
      path === HARNESS_IGNORE_FILE || isAlwaysExcluded(path) || (own?.ignores(path) ?? false),
    // Every path inside such a folder is left out, so the folder is never entered.
    excludesFolder: (path) => isAlwaysExcluded(`${path}/`) || (own?.ignores(`${path}/`) ?? false),
  };
}
