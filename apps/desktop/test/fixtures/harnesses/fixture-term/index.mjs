// fixture-term: a terminal Harness for the Runtime's tests. On start it writes the environment it
// got to $FIXTURE_ENV_FILE, when set, then prints, on one line, its working directory and its
// terminal size; it reports each line typed and each resize, and on SIGTERM writes `SIGTERM` to
// $FIXTURE_SIGNAL_FILE and exits 0. Its listeners are in place before it prints anything, so a
// test may signal it as soon as it reads `start`. The environment goes to a file, not the pty: it
// can be longer than the whole screen, which Windows' ConPTY draws again rather than passing on.
import { appendFileSync, writeFileSync } from 'node:fs';

const report = (kind, value) => {
  process.stdout.write(`FIXTURE ${kind} ${JSON.stringify(value)}\n`);
};

process.on('SIGTERM', () => {
  if (process.env.FIXTURE_SIGNAL_FILE) appendFileSync(process.env.FIXTURE_SIGNAL_FILE, 'SIGTERM\n');
  process.exit(0);
});
process.stdout.on('resize', () => {
  report('resize', [process.stdout.columns, process.stdout.rows]);
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (line) => {
  report('input', line);
});

process.stderr.write('fixture-term: started\n');
if (process.env.FIXTURE_ENV_FILE) {
  writeFileSync(process.env.FIXTURE_ENV_FILE, JSON.stringify(process.env));
}
report('start', {
  cwd: process.cwd(),
  size: [process.stdout.columns, process.stdout.rows],
});
