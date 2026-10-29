# Fixture Term

A terminal Harness for the desktop app's Runtime tests. On start it prints, on one line, the
environment it got, its working directory and its terminal size; it reports each line typed and
each resize, and on SIGTERM writes `SIGTERM` to `$FIXTURE_SIGNAL_FILE` and exits 0.
