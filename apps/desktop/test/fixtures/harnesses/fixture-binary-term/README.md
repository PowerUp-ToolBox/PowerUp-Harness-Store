# Fixture Binary Term

A terminal Harness with the binary runtime kind, for the desktop app's Runtime tests. Its Entry for
each macOS and Linux platform is `bin/fixture-binary-term`, a POSIX `sh` script standing in for a
native executable: it `exec`s `$FIXTURE_NODE` on `$FIXTURE_HARNESSES/fixture-term/index.mjs`, so it
behaves exactly like [fixture-term](../fixture-term/README.md). The script is checked in without
the executable bit, as a package zipped on Windows would be; the installer sets it.
