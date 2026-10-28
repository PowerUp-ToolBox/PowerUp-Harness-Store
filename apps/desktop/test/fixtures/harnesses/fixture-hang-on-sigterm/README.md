# Fixture Hang On Sigterm

A terminal Harness for the desktop app's Runtime tests: it ignores SIGTERM (writing `SIGTERM` to
`$FIXTURE_SIGNAL_FILE` when it gets one) and runs until it is killed.
