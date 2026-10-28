// fixture-leaves-helper: a terminal Harness for the Runtime's tests. It starts a helper process,
// in the Harness's process group, that ignores SIGTERM and SIGHUP, and prints `FIXTURE start`
// with the helper's pid once the helper ignores both. On SIGTERM it exits 0 at once, leaving the
// helper running: only SIGKILL to the group stops it.
import { spawn } from 'node:child_process';

process.on('SIGTERM', () => {
  process.exit(0);
});

const helper = spawn(
  process.execPath,
  [
    '-e',
    "process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {});" +
      "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
  ],
  { stdio: ['ignore', 'pipe', 'ignore'] },
);
helper.stdout.once('data', () => {
  process.stdout.write(`FIXTURE start ${JSON.stringify({ helperPid: helper.pid })}\n`);
});
