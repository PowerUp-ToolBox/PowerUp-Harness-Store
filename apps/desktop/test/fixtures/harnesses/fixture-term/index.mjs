// fixture-term: a terminal Harness for the Runtime's tests. On start it prints, on one line, the
// environment it got, its working directory and its terminal size; it reports each line typed and
// each resize, and on SIGTERM writes `SIGTERM` to $FIXTURE_SIGNAL_FILE and exits 0.
import { appendFileSync } from 'node:fs';

const report = (kind, value) => {
  process.stdout.write(`FIXTURE ${kind} ${JSON.stringify(value)}\n`);
};

process.stderr.write('fixture-term: started\n');
report('start', {
  env: process.env,
  cwd: process.cwd(),
  size: [process.stdout.columns, process.stdout.rows],
});
process.stdout.on('resize', () => {
  report('resize', [process.stdout.columns, process.stdout.rows]);
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (line) => {
  report('input', line);
});
process.on('SIGTERM', () => {
  if (process.env.FIXTURE_SIGNAL_FILE) appendFileSync(process.env.FIXTURE_SIGNAL_FILE, 'SIGTERM\n');
  process.exit(0);
});
