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

The install lifecycle of the desktop app, owned by the Library: install from the Store (download with progress and Cancel, size, sha256 and package verification, consent dialog, unpack, record) on the same install path as P0-05's local folder install, periodic update checks with a Library badge, one-click updates and an update prompt that shows the changelog and what changed when re-consent is required (Declared Permissions widen or Entry/runtime kind changes), uninstall that, after confirmation, removes the install directory, the Data Directory and the Harness's Model Overrides, and a Library page listing installed Harnesses with Launch, Update, Uninstall, Open data folder, Show logs and a shortcut to Model Overrides, plus a name filter, views and sorting. Flows F2, F4 and F9 in `docs/ux/flows.md` are normative.

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
12. As a User, I want a badge on the Library nav item and an Update button on each card with an update, so that updates are visible but not intrusive.
13. As a User, I want the update prompt to show the changelog, so that I know what changed.
14. As a User, I want the update prompt to show exactly what changed in permissions, Entry or runtime kind in diff style, so that I can spot a Harness that quietly gained shell access.
15. As a User, I want updates that add no permission and keep the same Entry and runtime kind to apply in one click, so that safe updates are frictionless.
16. As a User, I want updates that widen permissions or change Entry/runtime kind to require re-consent, so that my earlier consent is not silently extended.
17. As a User, I want to be prevented from updating a running Harness with an explanation, so that a live process is not replaced under it.
18. As a User, I want the Data Directory to survive updates, so that I do not lose the Harness's state.
19. As a User, I want an update to be atomic (the old version stays launchable until the new one is fully unpacked and verified), so that a failed update does not leave me with nothing.
20. As a User, I want an installed version that was Unpublished or taken down to remain launchable with a note, so that a Publisher's or administrator's action does not delete my working tool.
21. As a User, I want a taken-down Harness to show a stronger warning than an Unpublished one, so that I understand the difference (the stronger warning is P0-12's; P0-10 shows both with the same note).
22. As a User, I want to uninstall from the Library card menu or the detail page, so that removal is easy to find.
23. As a User, I want the uninstall confirmation to name the Harness and show the size of its Data Directory, so that I know what I am deleting.
24. As a User, I want uninstall to refuse while the Harness is running, so that files are not pulled out from under a process.
25. As a User, I want the Library to show, per card, name, icon, version, Publisher, status (Launch, Update available, Running, Exited with error, Local, No longer in Store) and last launched time, so that the Library is a real control panel.
26. As a User, I want per-card actions Launch, Update, Uninstall, Open data folder, Show logs, Model Overrides, so that every day-to-day action is one click away.
27. As a User, I want Library sorting by last launched with a name filter, so that a large Library stays navigable.
28. As a User, I want installs to survive an app crash mid-download without corrupting the Library, so that I never see a half-installed Harness.
29. As a User, I want the Library to work offline, so that I can launch installed Harnesses without a network.
30. As a Publisher, I want my local test installs to show a "Local" badge and never receive Store updates, so that they are not confused with published versions.
31. As a Store administrator, I want a taken-down Harness to be marked in every User's Library within the next update check, so that the warning reaches installed Users.


## Implementation Decisions

- **One install path, two entry points** (#74): a Store install and P0-05's "Install this folder locally" share the staging folder (`downloads/install-<uuid>`), the executable bits for binary Entries, the put-in-place step with its aside recovery, the record step on the installer's one-at-a-time queue, the Data Directory and the same consent dialog component; only where the files come from differs, and the rows differ only in `source`. "Install this folder locally" keeps its inline success message rather than a toast.
- **Install state** (migration adds `installs.state`, `NOT NULL DEFAULT 'installed'`): only a Store install is ever transient, and only these values are stored:

  ```
  downloading → verifying → awaiting_consent → unpacking → installed
  any transient state → (row deleted)    failed or cancelled; never stored
  ```

  The transient row is written only once the Store's `download` function has answered, so the Manifest, install path, Data Directory and `consented_permissions` (the Store Manifest's permissions) can be filled; the record step turns it `installed` with a fresh `installed_at`. The installs store's list and lookup see `installed` rows only, so the Library, Supervisor, Models page, Slot resolution and update check never see a half-installed Harness, and transient rows emit no `installs.changed`. Updates and uninstalls are not stored as states (no `updating` or `uninstalling`): the row stays `installed` throughout, and atomicity comes from the staging folder, put-in-place with its aside recovery and the startup cleanup. At startup, inside the existing recovery step and before the first list, install or update check, every transient row and every `downloads/download-*` file is deleted (with the `install-*` staging and `replaced-*` folders P0-05 already deletes).
- **Download** (`installs.install({ harnessId, jobId })`, the job the renderer names, a UUID): calls the Store `download` function with `version: null` (the latest), this machine's `platform` and `app_version`, so the Store counts the download and the app counts nothing (api.md). With no platform for this machine it is `platform_not_supported` without calling the Store; `download`'s 404 is `not_found` and its 422 `platform_not_supported`. An answer that is not a ticket is `store_error`; one whose Manifest names another Harness, or another version than the one asked for, is `integrity_error`. The package is streamed from the signed URL with the injected Store fetch (`net.fetch` in the app, so proxies apply) and no header of its own into `downloads/download-<jobId>.zip`, hashing SHA-256 as it streams; progress is `{ received, total }` on `progress:<jobId>`, `total` the Store's `size`. More bytes than `size` stop the transfer; nothing received for 120 s is `store_unreachable`. Concurrent downloads of different Harnesses are allowed. The main window's jobs are cancelled when its page closes, crashes or loads again, as only that page knows their IDs.
- **Checks before consent**, in order: the size, then SHA-256 (`checksum_mismatch`, also for a transfer of another size); then the zip is opened with `@harness-store/manifest`'s ArchiveSource and checked with `validatePackage` without options, so links, special files, `..` and absolute names are refused exactly as at publish (any problem is `integrity_error`); then the validated Manifest must deep-equal the `download` answer's Manifest as JSON values (the Store returns `jsonb`, so key order and whitespace differ from the file), with `id` equal to the requested Harness ID and, for an update, `version` equal to the requested one (`integrity_error`). Only then is the row `awaiting_consent` and `installs.install` answers the consent dialog's facts. There is no second comparison after unpacking: the unpacked files are the SHA-256-guarded entries that were validated.
- **Consent dialog**: the shared dialog P0-05 introduced, with the shared permission sentences and the one-second delay on Install. `installs.confirm(jobId)` unpacks and records, answering the installed version; `installs.cancel(jobId)` aborts the download (the pending call answers `download_cancelled`) or discards a download waiting for consent, deleting the file and the row. Consent is recorded as `installs.consented_permissions` from the installed Manifest; there are no `consented_entry_kind` / `consented_entry` columns, because re-consent compares with the installed row's Manifest, which is what the User consented to.
- **Unpack**: every file ArchiveSource lists is streamed to disk (`streamFile`, size and CRC-32 checked, at most about 16 MB in memory per part) into a `wx` write stream in the staging folder, then the shared executable-bit, put-in-place and record steps run as for a folder install. Corrupt content found here is `integrity_error`; the staging folder is deleted.
- **Refusals**: `installs.install` refuses a Harness with a transient row (`harness_installing`) and an installed one, local included (`invalid_input`: uninstall first); "Install this folder locally" refuses a Harness with a Store install under way (`harness_installing`). A failed confirm closes the dialog and shows the error on the detail page (main already discarded the download); Install retries, which makes a new `download` call.
- **Update check** (the Runtime's, not a method): 10 s after start and then every 6 hours (a constant; P0-11 owns the `update_check_interval` setting and "Check now"), `latest_versions` with the anon key for every installed Store Harness, never a local install, at most 1000 IDs a call. It is skipped while connectivity is known to be offline; a call that gets no answer reports the failure to connectivity and is dropped silently; there is no catch-up run when the Store comes back. A migration adds `store_status` (null = unknown or local) and `available_manifest` (JSON) beside the existing `available_version`. `not_found` is stored as `unpublished`. `available_version` and `available_manifest` are set only when the status is `available`, `latest_version` is greater (semver) than the row's version at write time and the latest Manifest declares this platform; otherwise both are cleared. An install clears them; a local install also sets `store_status` to null. Each changed row emits `installs.changed`; `installs.list` answers `storeStatus` and `availableUpdate`. As built here, no version-level Takedown is reported (P0-12.2's follow-up sends the installed version as `installed_versions` and reports a taken-down one through `installed_version_status`, api.md). Taking down or Unpublishing the latest version moves `latest_version` back, which can be lower than the installed one, so an update is offered only for a greater version, never merely a different one.
- **Re-consent rule** (#75): `diffForReconsent(installed, candidate)` in `@harness-store/manifest` is the single pure function, used by main and imported browser-safe by the renderer; it is unchanged by this spec. Re-consent is required when a permission is added or widened (`filesystem.scope` up the ladder none < workspace < home/paths; a new path or domain; `shell` false → true; named domains → `any`), `runtime.kind` changes, or the Entry changes. It flags a change of any platform's Entry, a strict superset of "this platform's Entry", so every #75 criterion holds. Narrowing never requires re-consent. The scope ladder is exported as `SCOPE_LADDER` so the renderer ranks scopes with the same order.
- **Update execution** (`installs.update({ harnessId, version, jobId, reconsented })`, one call): the target version is pinned (the Library's `available_version`, or the detail page's latest version), so the Manifest the prompt showed is the one installed. It calls `download` with that `version` and streams and checks the package exactly as an install (`progress:<jobId>`, cancelled by `installs.cancel`), then main recomputes `diffForReconsent(installed.manifest, downloaded)`: when it is required and `reconsented` is false it answers `reconsent_required` before unpacking. Otherwise it unpacks the new version beside the old one, switches the row and deletes the old folder; the Data Directory is never touched, and whatever fails, the old version stays installed and launchable. It refuses a local install or a version not greater than the installed one (`invalid_input`), a Harness not installed (`not_installed`), one being installed, updated or uninstalled (`harness_installing`), and a running one (`harness_running`): at the click, and again in the same step that marks the Harness installing before the swap, in which case the download is discarded. Launches are allowed while the download runs.
- **Update flow** (F4 and the design demo): a simple update starts the download on the first click, with progress and Cancel on the button and no dialog, then the toast "Updated {name} to {version}. See the changelog in Version history." When re-consent is required the button reads "Review update", and the update prompt opens before the download: from → to, "What changed", the changelog, the new version's trust block with the no-sandbox sentence, Not now / Update (enabled after one second). "What changed" lists only items that widen, as "New: …" in the shared permission sentences (a filesystem scope only when it ranks above the removed one); Entry and `runtime.kind` changes are shown as facts, and an Entry that only lost a platform's path is the fact line "No longer starts on {platform}". No "Removed:" lines are shown (screens.md). An update refused with `harness_running` shows "Close the Harness to update" under the button, not in a dialog; a card whose Harness runs while an update waits says the same.
- **Uninstall** (`installs.uninstall(harnessId)`, F9, on the one-at-a-time queue): refused with `harness_running` while running and with `harness_installing` while an install or update holds the Harness, deleting nothing; from that check until done the Harness counts as installing, so no launch starts. It deletes the install folder (only inside `harnesses/`), then the Data Directory (never following a link), then, in one transaction, the `installs` row and the Harness's Model Overrides (`slot_bindings` of scope `harness:<id>`); layout folders left empty go too. A web Harness's browser session (`persist:harness:<id>`: cookies, localStorage, caches, which Electron keeps outside the Data Directory) is then cleared, best effort. A folder already gone counts as deleted, so uninstalling again finishes a half-done uninstall. `launches` rows, Usage Records and launch logs are kept.
- **Log retention**: an uninstall writes its time to `uninstalled-at` in the Harness's logs folder (failing to write it does not fail the uninstall). At each start, in the recovery step, a logs folder of a Harness with no installed row whose uninstall is less than 30 days old is left alone; otherwise its `.log` files older than 30 days (modification time) are deleted, and once none is left the `uninstalled-at` file and the empty folders go too. A folder without a readable `uninstalled-at` follows the modification time alone. Installed Harnesses' folders are never pruned.
- **Data Directory size**: `installs.dataSize(harnessId)` answers the bytes of the regular files in the Data Directory, walked with `lstat` without following links, 0 when it is missing; read only when the uninstall confirmation opens and shown with the shared byte formatter.
- **Uninstall confirmation** (screens.md copy, zh-CN from the design demo): "Uninstall {name}?", "This deletes its data directory ({size}). Files in your own folders are not touched.", Cancel / Uninstall (danger), then the toast "Uninstalled {name}" with no Undo. If the Harness is running, or main refused because it started meanwhile, it says "Close the Harness first" with only Close. It opens from the Library card menu's Uninstall and from the detail page's secondary Uninstall (beside Launch, "Set up a model first" and "Not available for your platform" in the Installed state), which replaces P0-09's disabled placeholder. The dialog lives on the Library page, not inside a card, and closes by itself once the Harness is no longer installed.
- **Renderer install jobs**: an `InstallJobsProvider` in the Shell next to the publish provider holds the jobs by Harness ID, so progress survives navigation. When a download finishes it opens the consent dialog app-wide; while a job waits for consent with its dialog closed, the detail button reads "Review and install" and reopens it. Closing or cancelling the dialog calls `installs.cancel`. A Cancel that crosses a download finishing in main is cancelled again and shown as "Download cancelled", never as a dialog. The provider cancels its open jobs on unmount.
- **Primary button** (extends P0-09's state machine; a pure function evaluated on render):

  ```
  downloading (install or update)              → "Downloading n%" + Cancel
  awaiting consent, dialog closed              → "Review and install"
  installed, platform not supported            → "Not available for your platform" (disabled)
  installed Store install, store_status available, semver.lt(installed, latest),
    latest Manifest declares this platform     → "Update", or "Review update" when
                                                 diffForReconsent(installed, latest).required
                                                 (secondary: Launch)
  installed otherwise                          → "Launch" (secondary on the detail page: Uninstall)
  not installed, not in the Store              → "Removed from Store" (disabled)
  not installed, latest lacks this platform    → "Not available for your platform" (disabled)
  not installed                                → "Install"
  ```

  Requiring this platform for Update avoids a guaranteed 422. Errors show under the button, with Install or Update as Retry. Offline, Update is not hidden and a click fails inline with `store_unreachable`; Install is unreachable offline because the Store's offline panel replaces its pages.
- **Library page**: cards read `installs.list` plus live Supervisor state and subscribe to change events. A card's statuses are the primary button's states (above, with P0-05's Starting, Running, Stopping and error line), the Local badge and the note "No longer available in the Store" when `store_status` is `unpublished` or `taken_down`, which hides Update; there is no separate status label or update dot. Each card shows "Last launched {date}", nothing when never launched. Over the cards, all client-side over the loaded list with no call to main: a name filter, the views All / Updates available / Running / Local installs, the sort Recently used (default: last launched desc, then name) or Name, and "No Harnesses in this view" with Clear filters; a card left out is hidden, not unmounted. While `installs.list` has not answered (it waits for startup recovery) skeleton cards show "Loading your Library". The menu keeps P0-05's Model Overrides (the P0-03 Models page at that Harness), "Show logs" (screens.md copy for the ticket's "View logs"), Open data folder and P0-09's View in Store; this spec adds only Uninstall. Local installs never offer Update, whatever their row holds.
- **Library nav badge**: the Shell subscribes to `installs.list` and `installs.changed` and shows the number of installs with an update on the Library item, labelled "{n} updates available" / "{n} 个可用更新".
- **Taken down**: treated like Unpublished (the note, no Update, still launchable). The red warning, the stronger treatment and the launch-anyway confirmation are P0-12's; there is no link to a takedown reason, because the takedown note is never public (api.md).
- **Toasts**: a minimal app-level `aria-live="polite"` region without a landmark role (so it does not collide with the offline banner), auto-dismissed: "Installed {name}", "Updated {name} to {version}. See the changelog in Version history.", "Uninstalled {name}", "Download cancelled"; no links, no Undo.
- **Errors**: new IPC codes with `en` and `zh-CN` copy: `checksum_mismatch` (F2's "The downloaded package did not match the Store's checksum"), `integrity_error`, `download_cancelled`, `platform_not_supported`, `reconsent_required`. Existing codes reused: `store_unreachable`, `store_error`, `not_found`, `harness_running`, `harness_installing`, `not_installed`, `invalid_input`. api.md records every new call and data-model.md the new columns and the `uninstalled-at` file.
- **Offline**: install and update need the Store; the Library, Launch, Uninstall, logs and data folder work offline. Update checks silently skip when offline.

## Testing Decisions

- **Seams**: main seam tests over IPC with the real Runtime and Supervisor against a fake Store on a real HTTP port serving real zips built in the test from the desktop fixture Harnesses (fflate), so the root `pnpm test` needs no Docker. Install: the full pipeline to an `installed` row and folders; a misreported SHA-256 or size never reaches consent and leaves no row, download or install folder; Cancel during the download and while waiting for consent; a page that closes cancels its jobs; startup deletes transient rows and `download-*` files left by a stopped app; zips with path traversal, a symlink or a corrupted stored entry are refused with `integrity_error`; a Manifest that differs from the Store's; a 64 MB highly compressible entry installs; `launch.start` and `bindings.resolveAll` answer `not_installed` while the row waits for consent. Update: v1/v2 pairs (narrowed applies without re-consent, shell turned on and changed Entry answer `reconsent_required` until re-consented), a version not greater, a local install, a real running launch refused at the click and one started during the download refused before the swap, Data Directory files and content unchanged. Uninstall: both folders, the row and the Model Overrides go while the launch log, `launches` row and a file a Data Directory link points to stay; a running Harness is refused with nothing changed; a half-done uninstall finishes; `dataSize` skips links and is 0 for a missing folder. Unit tests of the update check (schedule with fake timers, local installs excluded, offline skip, no answer, 1000-ID chunks, what is stored) and of the startup log retention.
- **Pure functions**: `diffForReconsent` gains narrowing-all-at-once and widen-next-to-narrow cases beside its existing table; ArchiveSource's `streamFile` returns `readFile`'s bytes in bounded parts and refuses every malformed entry `readFile` refuses; the renderer's "What changed" mapping is tested against the diff's output in en and zh-CN (widened and narrowed scopes, the lost-platform Entry).
- **Renderer**: component tests in jsdom in en and zh-CN for the primary button table, Downloading with Cancel and the Cancel race, the consent dialog opened app-wide, the update prompt, the nav badge, card statuses with exactly their actions, the name filter and views with a spy showing no call to main, sort, last launched, the uninstall dialog's size, Cancel, Close-first and refusals, and Uninstall from the detail page.
- **Store**: no new SQL or RPC, so no Store seam test; a taken-down or Unpublished Harness is a `latest_versions` answer of the fake Store.
- **Fixtures**: v1/v2 pairs are built in the tests by zipping a desktop fixture Harness folder and overriding Manifest fields; no new fixture folders or seeded Store.
- **Not built here**: the Desktop E2E journeys (install → Library → launch → uninstall, the update journey, Open data folder and Show logs opening real OS paths) are left to P0-13; the IPC seam asserts the paths handed to the OS.
- **Prior art**: Supervisor tests from P0-05; P0-08's and P0-09's fake-Store HTTP pattern.

## Out of Scope

- Launching and window management (P0-05).
- Detail page rendering (P0-09; this spec handles the clicks and the states it adds).
- The red taken-down warning, launch-anyway confirmation and Report (P0-12).
- The `update_check_interval` setting and "Check now" (P0-11).
- Desktop E2E journeys (P0-13).
- Beta Channel opt-in (P1-02).
- Purchase entitlements at install (P1-01).
- Cloud sync of the installed list (P2-03).

## Further Notes

- `diffForReconsent` stays the one pure function of two Manifests with exhaustive tests; it is the security-relevant heart of this spec.
- Deviations from the tickets (#74, #75, #76) as built:
  - The Manifest is compared once, before consent, as JSON values on the validated zip, not byte-for-byte after unpacking.
  - No `consented_entry_kind` / `consented_entry` columns, and no `updating`, `uninstalling`, `failed` or `cancelled` states.
  - The update prompt has no "simple update" state: a simple update runs on the first click; the prompt opens only for re-consent, before the download, so consent still comes before unpacking.
  - "What changed" shows no "Removed:" lines.
  - `diffForReconsent` flags any platform's Entry change, not only this platform's.
  - A card's update badge is its Update / Review update button; there is no separate status label or dot.
  - Taken down is treated like Unpublished; the stronger warning is P0-12's, and the takedown-reason link is dropped.
  - The menu keeps "Show logs"; on the detail page Uninstall sits beside Launch only (with an update available or while running it is reached from the Library card).
  - Uninstall is also refused while an install or update holds the Harness, and it deletes the Harness's Model Overrides with the row.
  - Log retention also waits 30 days from the uninstall (`uninstalled-at`), so an uninstalled Harness's logs are kept at least 30 days after the uninstall, not only 30 days after they were written.
  - Unpacking streams entries to disk rather than buffering whole files; no size cap is set.

## Blocked by

- P0-05 Runtime: install from folder, launch and supervise Harnesses
- P0-09 Store browsing and discovery
