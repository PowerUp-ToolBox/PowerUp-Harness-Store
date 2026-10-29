# Fixture Web

A web Harness for the desktop app's Runtime tests. It listens on `127.0.0.1:$HARNESS_PORT` at once
and serves a page with a link to an external site and what its script can reach (`/`), the
environment it was started with as JSON (`/env`), and one chat completion from the Model Gateway
for its `default` Model Slot (`/complete`). `/exit/<code>` makes it exit with that code;
`/handoff/<code>` makes it exit with that code once a helper process it started listens on its
port instead, leaving the helper running. On SIGTERM it writes `SIGTERM` to `$FIXTURE_SIGNAL_FILE`
and exits 0.
