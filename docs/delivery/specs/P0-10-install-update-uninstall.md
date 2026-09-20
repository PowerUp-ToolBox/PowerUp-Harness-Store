---
spec_id: P0-10
title: Install, update and uninstall from the Store (Library)
phase: P0
blocked_by: [P0-05, P0-09]
requirements: [R-1001, R-1002, R-1003, R-1004, R-1005]
---

# P0-10 Install, update and uninstall from the Store (Library)

## Problem Statement

A User can find a Harness in the Store and the Runtime can launch a Harness that is already on disk, but nothing connects the two: there is no download, no integrity check, no moment where the User consents to what the Harness declares, no way to learn that a newer version exists, and no way to remove a Harness cleanly. Without this the Store is a catalogue you can only read.

## Solution

The install lifecycle of the desktop app, owned by the Library: install from the Store (download with progress, sha256 verification, unpack, consent dialog, record), periodic update checks with a badge and an update prompt that shows the changelog and a diff of what changed (re-consent required when Declared Permissions widen or Entry/runtime kind changes), uninstall that removes the install directory and, after confirmation, the Data Directory, and a Library page listing installed Harnesses with Launch, Update, Uninstall, Open data folder, View logs and a shortcut to Model Overrides. Flows F2, F4 and F9 in `docs/ux/flows.md` are normative.

## User Stories

1. As a User, I want to click Install on a detail page and watch download progress on the button, so that I know something is happening.
2. As a User, I want to cancel a download, so that a mistaken click on a large package does not cost me bandwidth.
3. As a User, I want the app to verify the package checksum against what the Store reported, so that a corrupted or tampered download is never unpacked.
4. As a User, I want a failed checksum to show a clear error with Retry, so that I understand it was an integrity problem, not my mistake.
5. As a User, I want a consent dialog before anything is installed, showing Declared Permissions with the red/yellow/green scale, so that I decide with the facts in front of me.
6. As a User, I want the consent dialog to also show runtime kind, Entry, UI Kind, Workspace requirement and platforms, so that I know how the Harness will run.
7. As a User, I want the standing sentence that Harness Store does not isolate Harnesses in the consent dialog, so that the trust model is explicit at the moment it matters.
8. As a User, I want the Install button in the dialog to enable only after a short delay, so that I cannot click through by accident.
9. As a User, I want Cancel in the consent dialog to discard the download, so that nothing lingers on disk.
10. As a User, I want the installed Harness to appear in the Library immediately with a Launch button and a toast, so that I can start using it.
11. As a User, I want the app to check for updates on start and every few hours, so that I learn about new versions without doing anything.
12. As a User, I want a badge on the Library nav item and on each card with an update, so that updates are visible but not intrusive.
13. As a User, I want the update prompt to show the changelog, so that I know what changed.
14. As a User, I want the update prompt to show exactly what changed in permissions, Entry or runtime kind in diff style, so that I can spot a Harness that quietly gained shell access.
15. As a User, I want updates that add no permission and keep the same Entry and runtime kind to apply in one click, so that safe updates are frictionless.
16. As a User, I want updates that widen permissions or change Entry/runtime kind to require re-consent, so that my earlier consent is not silently extended.
17. As a User, I want to be prevented from updating a running Harness with an explanation, so that a live process is not replaced under it.
18. As a User, I want the Data Directory to survive updates, so that I do not lose the Harness's state.
19. As a User, I want an update to be atomic (the old version stays launchable until the new one is fully unpacked and verified), so that a failed update does not leave me with nothing.
20. As a User, I want an installed version that was Unpublished or taken down to remain launchable with a note, so that a Publisher's or administrator's action does not delete my working tool.
21. As a User, I want a taken-down Harness to show a stronger warning than an Unpublished one, so that I understand the difference.
22. As a User, I want to uninstall from the Library card menu or the detail page, so that removal is easy to find.
23. As a User, I want the uninstall confirmation to name the Harness and show the size of its Data Directory, so that I know what I am deleting.
24. As a User, I want uninstall to refuse while the Harness is running, so that files are not pulled out from under a process.
25. As a User, I want the Library to show, per card, name, icon, version, Publisher, status (Installed, Update available, Running, Exited with error, Local, No longer in Store) and last launched time, so that the Library is a real control panel.
26. As a User, I want per-card actions Launch, Update, Uninstall, Open data folder, View logs, Model Overrides, so that every day-to-day action is one click away.
27. As a User, I want Library sorting by last launched with a name filter, so that a large Library stays navigable.
28. As a User, I want installs to survive an app crash mid-download without corrupting the Library, so that I never see a half-installed Harness.
29. As a User, I want the Library to work offline, so that I can launch installed Harnesses without a network.
30. As a Publisher, I want my local test installs to show a "Local" badge and never receive Store updates, so that they are not confused with published versions.
31. As a Store administrator, I want a taken-down Harness to be marked in every User's Library within the next update check, so that the warning reaches installed Users.

## Implementation Decisions

- **Install state machine** (persisted in the local `installs` table with a `state` column so a crash leaves a recoverable record):

  ```
  idle → downloading → verifying → awaiting_consent → unpacking → installed
  downloading → cancelled | failed
  verifying → failed(checksum)
  awaiting_consent → cancelled
  unpacking → failed
  installed → updating(downloading → verifying → awaiting_consent? → unpacking) → installed
  installed → uninstalling → (row deleted)
  ```

  On app start any row in a transient state is reset: downloads and temp files are deleted; `installed` rows are untouched.
- **Download**: call the Store `download` function to get URL, sha256, size and Manifest; stream to the downloads temp area with progress events; verify sha256 of the complete file; only then show consent. Consent uses the Manifest from the function response, and after unpacking the app re-validates that the unpacked `manifest.json` matches it byte-for-byte, otherwise the install fails with an integrity error.
- **Consent dialog** content and severity mapping come from the shared permission-sentence function introduced in P0-09. The primary button is enabled after 1 second. Consent is recorded in `installs.consented_permissions` (the permissions object) plus `consented_entry_kind` and `consented_entry` for later diffing.
- **Unpack** into `harnesses/<publisher>/<slug>/<version>/` after rejecting entries with absolute paths, `..`, or symlinks. Set executable bits for binary-kind Entries. On success write the install row, create the Data Directory if absent, then delete the temp file.
- **Update check** runs on app start (after a 10 s delay) and every 6 hours, calling `latest_versions` with all Store-installed Harness IDs (local installs excluded). The response is stored as `available_version` plus the new `permissions` and Entry kind. A Harness whose latest version is null or whose status is taken down is marked accordingly (`store_status`: `available` | `unpublished` | `taken_down`).
- **Re-consent rule**: re-consent is required if any of these hold between installed and available versions: a permission is added or widened (`filesystem.scope` moves up the order none < workspace < home/paths; new path or domain added; `shell` false→true; `network.domains`→`any`), `runtime.kind` changes, or the platform's Entry path changes. Narrowing never requires re-consent. The diff shown lists added/widened items as "New:" lines and removed ones as "Removed:" lines.
- **Update execution**: download and verify the new version into a new version directory; if re-consent is required, prompt before unpacking; switch the install row to the new version only after unpack succeeds; then delete the old version directory. Data Directory untouched. Refuse when a launch for that Harness is active.
- **Uninstall**: refuse while running; confirmation shows the Data Directory size computed lazily; delete install directory, then Data Directory, then the row; log files for that Harness are kept in the logs folder for 30 days.
- **Library page** reads the `installs` table plus live Supervisor state (running, exit code) over IPC and subscribes to change events. Sorting default: last launched desc, then name. "No longer in Store" state hides Update; taken-down state shows a red note and a link to the Store's takedown reason if provided.
- **Offline**: install and update require the Store; the Library, Launch, Uninstall, logs and data folder work offline. Update checks silently skip when offline.
- **Copy** in `en` and `zh-CN`; all error codes map to translated messages.

## Testing Decisions

- **Seams**: Supervisor/Installer seam (architecture §8, item 3) driving the install state machine against a local Store (Store seam) with fixture packages, asserting on filesystem outcome and `installs` rows; renderer component tests for the consent dialog and the re-consent diff (pure function over two Manifests); Desktop E2E for install → Library → launch → uninstall.
- **Good tests**: a package whose sha256 differs from the Store's value never reaches consent and leaves no files; cancelling consent deletes the temp file; an update whose only change is narrowing a permission applies without a prompt; an update that flips `shell` to true blocks until re-consent; killing the app process during download leaves a row that is cleaned up on next start; uninstalling removes the Data Directory but keeps logs.
- **Fixtures**: fixture packages from P0-01 in pairs (v1/v2 with widened permissions, v1/v2 with narrowed permissions, v1/v2 with changed Entry); seeded local Store from P0-07 with a taken-down Harness.
- **Prior art**: Supervisor tests from P0-05; Store tests from P0-07.

## Out of Scope

- Launching and window management (P0-05).
- Detail page rendering and install button state display (P0-09; this spec handles the click).
- Beta Channel opt-in (P1-02).
- Purchase entitlements at install (P1-01).
- Cloud sync of the installed list (P2-03).

## Further Notes

- Keep the re-consent diff as a pure function of two Manifests with exhaustive tests; it is the security-relevant heart of this spec.

## Blocked by

- P0-05 Runtime: install from folder, launch and supervise Harnesses
- P0-09 Store browsing and discovery
