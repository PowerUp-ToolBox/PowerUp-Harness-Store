# Fixture Leaves Helper

A terminal Harness for the desktop app's Runtime tests: it starts a helper process, in the
Harness's process group, that ignores SIGTERM and SIGHUP, reports the helper's pid on its
`FIXTURE start` line, and exits 0 on SIGTERM, leaving the helper running.
