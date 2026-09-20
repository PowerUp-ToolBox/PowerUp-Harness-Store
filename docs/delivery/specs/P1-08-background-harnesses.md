---
spec_id: P1-08
title: Background Harnesses
phase: P1
blocked_by: [P0-05]
requirements: [R-P1-08]
---

## Problem Statement

In P0 a Harness lives exactly as long as its window: closing the window kills the process. That rules out an entire class of useful Harnesses (inbox triage every 15 minutes, a file watcher that summarises new documents, a local webhook receiver, a scheduled report). Users of such Harnesses would have to keep a window open all day, and the Runtime has no way to tell the difference between "the User closed the window" and "the User wants it to keep working".

## Solution

A Harness may declare `background: true` in its Manifest. For such a Harness, closing its window hides it instead of terminating the process; the process keeps running until the User explicitly stops it or quits the app. Running background Harnesses appear in the system tray / menu bar menu and in Library with a "Running" state, with controls to open the window, stop, or restart. The Runtime keeps the Gateway Token alive for the lifetime of the process, records background launches like any other launch, and applies the same single-instance rule. On app quit the User is told which background Harnesses will stop.

## User Stories

1. As a User, I want a background-capable Harness to keep running when I close its window, so that scheduled or watching tasks continue.
2. As a User, I want to see which Harnesses are running in the background from the tray menu, so that I always know what is active on my machine.
3. As a User, I want to reopen a background Harness's window from the tray or Library, so that I can check on it.
4. As a User, I want to stop a background Harness from the tray or Library, so that I can end it without hunting for a window.
5. As a User, I want the install consent dialog to tell me a Harness can run in the background, so that I agree to it knowingly.
6. As a User, I want an update that adds `background: true` to require re-consent, so that a Harness cannot silently gain persistence.
7. As a User, I want the app to warn me on quit that background Harnesses will stop, so that I do not lose work by accident.
8. As a User, I want the option to start background Harnesses automatically when the app starts (per Harness, default off), so that my daily automation resumes after a reboot.
9. As a User, I want a background Harness that crashes to show a notification with a link to its logs, so that silent failure does not go unnoticed.
10. As a User, I want the Usage page to attribute background launches like any other, so that I can see what a background Harness costs.
11. As a User, I want background Harnesses to be limited to one instance, so that reopening never spawns duplicates.
12. As a User, I want to see uptime and last activity (last Gateway request time) for each background Harness, so that I can tell if it is stuck.
13. As a Publisher, I want to declare that my Harness is meant to run in the background, so that the Runtime and the Store present it correctly.
14. As a Publisher, I want the Harness to receive a signal before being stopped, so that it can flush state.
15. As a Publisher, I want a terminal-kind background Harness to keep its scrollback available when the window is reopened, so that Users can see what happened while hidden.
16. As the maintainer, I want the tray integration to degrade gracefully on Linux desktops without a tray, so that the feature does not break the app there.

## Implementation Decisions

- **Manifest:** new optional top-level field `background: boolean` (default `false`), added to the schema as manifestVersion 1 remains compatible (absent means false). Recommended Models, Slots and everything else unchanged. Reserved-field policy: unknown keys still rejected. (R-P1-08)
- **Lifecycle:** for `background: true`, window close → hide; the process continues. Explicit Stop → SIGTERM, 5 s grace, SIGKILL (same as P0). App quit → confirmation dialog listing running background Harnesses, then the same stop sequence for each. The Supervisor's state machine gains a `running-hidden` state:

  ```
  idle → starting → running-visible ⇄ running-hidden → stopping → idle
                                   └────────────────→ crashed → idle
  ```
  (Snippet describes the decided states; transitions from prototype discussion.)
- **Single instance** unchanged: Launch on a running-hidden Harness shows its window.
- **Tray / menu bar:** the app gets a tray icon when at least one background Harness is running (or always, decide at implementation); the menu lists running background Harnesses with Open / Stop, plus "Open Harness Store" and "Quit".
- **Library:** shows Running badge, uptime, last Gateway request time, and per-Harness "Start on app launch" toggle (default off). Autostart applies only to Harnesses the User has already run at least once.
- **Consent:** the install consent dialog and the update permission diff treat `background` as a consent-relevant change (like widening Declared Permissions).
- **Crash handling:** non-zero exit or signal while hidden → desktop notification with "View logs"; no automatic restart in this version (decide later; a restart storm is worse than a stopped job).
- **Terminal kind:** the pty and scrollback buffer persist while hidden, capped at a fixed number of lines.
- **Web kind:** the Harness's local HTTP server keeps running; the BrowserWindow is hidden, not destroyed, so reopen is instant. Decide at implementation whether to destroy and recreate the window after a long idle to save memory.
- **Gateway:** Gateway Token lifetime equals process lifetime, unchanged. Usage Records unchanged.
- **Store:** detail page shows a "Runs in background" indicator derived from the Manifest.

## Testing Decisions

- Good tests observe process liveness, window visibility state and Gateway Token validity, not Supervisor internals.
- **Supervisor seam (architecture §8 seam 3):** fixture Harness with `background: true`: close window → process still alive, token still valid, state `running-hidden`; Stop → process ends, token revoked; launch while hidden → same pid, window shown; crash while hidden → notification hook invoked. Fixture with `background: false` behaves exactly as P0.
- **Manifest seam (seam 2):** schema accepts `background: true/false`, rejects non-boolean; consent-diff function reports `background` gained as a re-consent change.
- **Desktop E2E (seam 5):** one smoke journey: install background fixture → launch → close window → tray menu lists it → Stop from tray → Library shows not running. Tray interaction may be driven through an IPC test hook where the OS tray cannot be automated.
- Prior art: P0-05 Supervisor tests.

## Out of Scope

- Scheduling primitives provided by the platform (cron-like triggers); the Harness owns its own timing.
- Running Harnesses while the app is closed (a separate daemon); the app must be running.
- Automatic restart policies.
- Sandboxing or resource limits for long-running processes.

## Further Notes

- Because Declared Permissions are still not enforced (ADR-0004), a background Harness has the same trust level as any other; the consent copy should say that a background Harness "keeps running with your user permissions until you stop it".

## Blocked by

- P0-05 Runtime: install from folder, launch and supervise Harnesses
