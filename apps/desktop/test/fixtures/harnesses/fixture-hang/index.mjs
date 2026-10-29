// fixture-hang: a web Harness for the Runtime's tests that never listens. It prints 60 numbered
// lines and one to stderr, then runs until it is stopped. With $FIXTURE_EXIT_CODE set, it exits
// with that code instead, before it ever listened.
for (let line = 1; line <= 60; line += 1) {
  process.stdout.write(`fixture-hang: line ${String(line)}\n`);
}
process.stderr.write('fixture-hang: not listening on purpose\n');
if (process.env.FIXTURE_EXIT_CODE) {
  setTimeout(() => {
    process.exit(Number(process.env.FIXTURE_EXIT_CODE));
  }, 100);
} else {
  setInterval(() => undefined, 60_000);
}
