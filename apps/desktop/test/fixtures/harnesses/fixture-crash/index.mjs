// fixture-crash: a terminal Harness for the Runtime's tests. It prints why it fails, then exits
// with code 3.
process.stderr.write('fixture-crash: failing on purpose\n');
setTimeout(() => {
  process.exit(3);
}, 100);
