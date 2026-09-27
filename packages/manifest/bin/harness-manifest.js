#!/usr/bin/env node
// The `harness-manifest` command (package.json#bin). The CLI is src/node/cli.ts, compiled to
// dist/ by `pnpm build`. This file is checked in rather than built so that the command exists
// when pnpm links it at install time, before anything is built; pnpm skips a bin whose file
// does not exist yet.
import { existsSync } from 'node:fs';

const cli = new URL('../dist/node/cli.js', import.meta.url);
if (existsSync(cli)) {
  const { runCli } = await import(cli.href);
  await runCli();
} else {
  process.stderr.write(
    'harness-manifest: the CLI is not built yet. Run `pnpm --filter @harness-store/manifest build` first.\n',
  );
  process.exitCode = 2;
}
