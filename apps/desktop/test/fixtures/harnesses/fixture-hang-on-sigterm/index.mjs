// fixture-hang-on-sigterm: a terminal Harness for the Runtime's tests. It ignores SIGTERM, writing
// `SIGTERM` to $FIXTURE_SIGNAL_FILE when it gets one, and runs until it is killed.
import { appendFileSync } from 'node:fs';

process.on('SIGTERM', () => {
  if (process.env.FIXTURE_SIGNAL_FILE) appendFileSync(process.env.FIXTURE_SIGNAL_FILE, 'SIGTERM\n');
});
setInterval(() => undefined, 1000);
process.stdout.write('FIXTURE start {}\n');
