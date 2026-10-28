// Zips the built Harness folder, out/, into dist/<slug>-<version>.zip with the layout of
// docs/tech/manifest-spec.md §1: manifest.json, README.md and assets/ at the archive root. The zip
// is deterministic (entries sorted, every timestamp 1980-01-01), so the same out/ always gives the
// same bytes. It leaves out what the Publish flow leaves out (P0-08): .git/, node_modules/.cache/,
// .DS_Store, Thumbs.db and *.swp.
//
// Run it as `pnpm run pack` (plain `pnpm pack` is pnpm's own tarball command) after `pnpm build`.
// `node scripts/pack.mjs [<folder> [<output directory>]]` packs another folder, or writes elsewhere.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { zipSync } from 'fflate';

const root = join(import.meta.dirname, '..');
const [from, to] = process.argv.slice(2);
const out = from === undefined ? join(root, 'out') : resolve(from);
const target = to === undefined ? join(root, 'dist') : resolve(to);

if (!existsSync(join(out, 'manifest.json'))) {
  process.stderr.write(`pack: ${out} has no manifest.json. Run \`pnpm build\` first.\n`);
  process.exit(1);
}

/** Whether the Publish flow leaves `path` (relative, `/`-separated) out of the archive. */
function excluded(path) {
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

/** Every regular file under `dir`, as archive paths. */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(out, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !excluded(path))
    .sort();
}

const { id, version } = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
const slug = id.split('/')[1];
const mtime = new Date(1980, 0, 1);
const files = Object.fromEntries(
  listFiles(out).map((path) => [path, [readFileSync(join(out, path)), { mtime }]]),
);
const zip = zipSync(files, { level: 9 });

mkdirSync(target, { recursive: true });
const file = join(target, `${slug}-${version}.zip`);
writeFileSync(file, zip);
process.stdout.write(`${relative(process.cwd(), file)}\n`);
