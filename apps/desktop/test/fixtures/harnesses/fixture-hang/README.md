# Fixture Hang

A web Harness for the desktop app's Runtime tests that never listens: it prints 60 numbered lines
and one to stderr, then runs until it is stopped, or exits with `$FIXTURE_EXIT_CODE` when that is
set. Its `ui.readyTimeoutSeconds` is 5, the least the Manifest allows.
