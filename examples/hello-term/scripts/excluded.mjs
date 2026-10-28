// What the Publish flow (P0-08) leaves out of a Harness Package: .git/, node_modules/.cache/ and
// the files operating systems and editors drop next to others (.DS_Store, Thumbs.db, *.swp). The
// build keeps these out of out/ and the pack script out of the zip, so the two always agree. The
// rules' home is apps/desktop/src/main/runtime/package-exclusions.ts; a desktop test keeps this
// standalone copy in step with it.

/** Whether `path` (relative, `/`-separated) is left out of the Harness Package. */
export function excluded(path) {
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
