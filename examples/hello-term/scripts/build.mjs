// Builds the installable Harness folder, out/: the Entry bundled into one file with everything it
// imports (the SDK and the openai client included), next to manifest.json, README.md and assets/.
// The folder needs no node_modules at runtime, and nothing else of this source folder (src/, the
// pnpm node_modules links) ends up in it, so out/ is what gets validated, installed and packed.
//
// Run by `pnpm build` after `tsc --build tsconfig.build.json`, which type-checks src/.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'rolldown';

const root = join(import.meta.dirname, '..');
const out = join(root, 'out');

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

await build({
  input: join(root, 'src', 'index.ts'),
  platform: 'node',
  // The Manifest's runtime.node; the Runtime's own Node (Electron's) is newer.
  transform: { target: 'node22' },
  logLevel: 'warn',
  output: {
    // .mjs: an ES module whatever package.json sits (or does not) above the installed folder.
    file: join(out, 'dist', 'index.mjs'),
    format: 'esm',
    codeSplitting: false,
    minify: false,
    sourcemap: false,
  },
});

for (const file of ['manifest.json', 'README.md', 'assets']) {
  cpSync(join(root, file), join(out, file), { recursive: true });
}
