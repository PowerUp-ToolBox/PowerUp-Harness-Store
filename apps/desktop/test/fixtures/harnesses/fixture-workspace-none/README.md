# Fixture Workspace None

A terminal Harness for the desktop app's Runtime tests, whose Manifest's `workspace` is
`none`. On start it prints, on one line, its working directory and `HARNESS_WORKSPACE` (and
whether the variable is set at all), then waits, and exits 0 on SIGTERM.
