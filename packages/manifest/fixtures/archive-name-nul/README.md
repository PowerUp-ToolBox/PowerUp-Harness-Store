# Fixture: archive-name-nul

A clean folder; its archive adds a second entry named "manifest.json\0" (a NUL after the name). Unpackers that cut a name off at the NUL write it over the checked manifest.json, installing a Manifest that was never validated.

Test data for `@harness-store/manifest`: a Harness Package that is never installed or run.
