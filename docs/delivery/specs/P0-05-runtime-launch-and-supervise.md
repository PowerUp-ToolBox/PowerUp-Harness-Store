---
spec_id: P0-05
title: "Runtime: install from folder, launch and supervise Harnesses"
phase: P0
blocked_by: [P0-02, P0-03, P0-04]
requirements: [R-0501, R-0502, R-0503, R-0504, R-0505, R-0506, R-0507, R-0508]
---

# P0-05 Runtime: install from folder, launch and supervise Harnesses

## Problem Statement

A Harness is a program; someone has to start it correctly, give it the environment the launch contract promises, open a window for it, keep exactly one instance alive, stop it when the User closes the window and clean up its Gateway Token. Publishers also need to run their own Harness locally, before the Store exists, exactly the way Users will run it, or they will publish things that do not launch.

## Solution

The Runtime's Process Supervisor and local installer: "Install from folder" validates and installs a local Harness directory like a Store package; launching resolves Entry for the platform, prepares the Data Directory and optional Workspace, issues a Gateway Token, spawns the process with the documented environment using the bundled Node or the binary directly, opens a web window once the port is ready or an embedded terminal immediately, enforces single instance, and implements the shutdown sequence, log capture and error surfacing. `docs/tech/architecture.md` §4 is normative for the launch contract.

## User Stories

1. As a Publisher, I want to install my Harness from a local folder, so that I can test it exactly as Users will before publishing.
2. As a Publisher, I want validation problems shown if my folder is not a valid Harness, so that I fix them first.
3. As a Publisher, I want locally installed Harnesses marked as "Local" in Library, so that I can tell them from Store installs.
4. As a Publisher, I want to reinstall from the same folder to pick up changes, so that iteration is quick.
5. As a User, I want to click Launch and see the Harness open as its own window, so that it feels like a separate app.
6. As a User, I want a web-UI Harness's window to appear only when it is actually ready, with a spinner meanwhile, so that I never see a connection-refused page.
7. As a User, I want a terminal-UI Harness to open in a proper terminal window with colours, resizing, scrollback, copy and paste, so that TUI Harnesses are pleasant.
8. As a User, I want a Harness that needs a Workspace to ask me for a folder, remembering my last choice, so that project-based Harnesses are quick to start.
9. As a User, I want a Harness with an optional Workspace to let me pick one or skip, so that I control access.
10. As a User, I want launching an already-running Harness to focus its window instead of starting a second copy, so that state is not duplicated.
11. As a User, I want closing the window to stop the process, so that nothing keeps running or spending in the background.
12. As a User, I want a Harness that crashes to close its window and show me the exit code and a "View logs" button, so that I can report it.
13. As a User, I want a Harness that never becomes ready to time out with a clear message and its last output, so that I am not stuck on a spinner.
14. As a User, I want a Harness to be unable to see my shell's `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, so that it cannot bypass the Gateway with my own credentials.
15. As a User, I want the Harness's private data to survive updates and be deleted on uninstall, so that state is predictable.
16. As a User, I want to open a Harness's data folder and logs folder from Library, so that I can inspect or back up.
17. As a User, I want the app to tell me when a Harness is not available for my platform instead of failing at launch, so that I am not misled.
18. As a User, I want quitting the app to stop all running Harnesses gracefully, so that nothing is orphaned.
19. As a User, I want a web-UI Harness window to have a minimal title bar with the Harness name and a "Reload" action, so that I can recover from a stuck page.
20. As a User, I want the web window to block navigation to external sites (opening them in my browser instead), so that a Harness UI cannot hijack the window.
21. As a Harness author, I want `HARNESS_PORT` to be free and reserved for me, so that I can bind without retries.
22. As a Harness author, I want my current working directory to be the Workspace when one is chosen and my Data Directory otherwise, so that relative paths are predictable.
23. As a Harness author, I want SIGTERM before SIGKILL with a few seconds' grace, so that I can flush state.
24. As a Harness author, I want stdout/stderr captured to a log file even for web-UI Harnesses, so that my own debugging output is available.
25. As a Harness author, I want my Node Harness to run on the Runtime's Node without any system Node installed, so that Users have zero prerequisites.
26. As a Harness author of a binary Harness, I want the executable bit set on macOS/Linux after unpack, so that zips created on Windows still launch.
27. As a developer, I want the Supervisor testable without a display, so that lifecycle tests run in CI.
28. As a developer, I want each launch recorded (start, end, exit code, token revoked), so that Usage and debugging can correlate.

## Implementation Decisions

- **Install from folder**: `validatePackage(DirectorySource)` → copy into `harnesses/<publisher>/<slug>/<version>/` (overwriting if the same version exists locally) → record in `installs` with `source = 'local'` → show consent dialog (same component as P0-10) since a local Harness also runs code.
- **Launch state machine** (decision-encoding snippet):
  ```
  idle → preparing (resolve entry, data dir, workspace prompt) → spawning → [web: waiting-ready → ready] | [terminal: ready]
  ready → stopping (SIGTERM, 5 s) → stopped
  any → failed(reason) : spawn_error | ready_timeout | exit_nonzero | platform_unsupported | workspace_cancelled | slot_unbound_at_launch (warning only, does not block)
  ```
  Only one instance per Harness ID; a launch request in any non-idle/stopped state focuses the window.
- **Entry resolution**: `runtime.kind = node` → `[bundledNodePath, entryPath]`; `binary` → `[entry[platform]]`; missing platform key → `platform_unsupported` before spawn. Bundled Node ships with the app under resources (per platform/arch) and is resolved at runtime.
- **Environment**: start from `process.env`, delete keys matching `^(OPENAI|ANTHROPIC|GOOGLE_API|GEMINI|OPENROUTER)_` , then set the contract variables from architecture §4. `HARNESS_PORT` obtained by binding port 0 on loopback and releasing immediately before spawn.
- **Readiness (web)**: poll TCP connect to `127.0.0.1:port` every 250 ms until success or `ui.readyTimeoutSeconds`; then open a BrowserWindow (no preload, sandboxed, `contextIsolation`) at `http://127.0.0.1:port<path>`; `will-navigate`/`setWindowOpenHandler` send non-loopback URLs to the system browser.
- **Terminal**: node-pty spawns the Entry; renderer hosts xterm.js in a dedicated window; data flows over an IPC channel per launch; resize forwarded; copy/paste native.
- **Shutdown**: window `close` → SIGTERM (Windows: `taskkill /T` equivalent via tree kill) → after 5 s SIGKILL → revoke token → write `launches.ended_at/exit_code`. Process `exit` first → close window → if code ≠ 0 show error dialog with exit code and "View logs".
- **Logs**: `logs/<publisher>/<slug>/<launchId>.log` with stdout/stderr interleaved and timestamped; rotate: keep last 20 launches per Harness.
- **Workspace prompt**: native folder dialog; `required` + cancel → `workspace_cancelled`; store `last_workspace` per Harness.
- **Pre-launch check**: resolve all Slots via P0-03; if `default` is unbound, show a non-blocking warning with a link to Models (the Harness may still start; the Gateway will return `slot_unbound`).
- **IPC**: `installs.installFromFolder(path)`, `launch.start(harnessId)`, `launch.stop(harnessId)`, `launch.status()`, `launch.openLogs/openDataDir(harnessId)`; events `launch:state`.
- **App quit**: Supervisor `stopAll()` with the same sequence, awaited with a 10 s cap.

## Testing Decisions

- Seam: **Supervisor seam** (architecture §8, item 3). Tests use fixture Harnesses: `fixture-web` (Node script that reads `HARNESS_PORT`, serves a page and echoes env as JSON), `fixture-term` (prints and exits 0), `fixture-crash` (exits 3), `fixture-hang` (never listens), `fixture-slow-ready` (listens after 2 s). Window creation is behind an interface faked in tests; readiness polling and process lifecycle run for real.
- Good tests: "launch fixture-web → state reaches ready and the served page reports the exact env contract"; "OPENAI_API_KEY in parent env is absent in child"; "stop → SIGTERM received (fixture logs it) and token rejected by Gateway afterwards"; "fixture-hang → failed(ready_timeout) with captured output".
- Gateway integration via the **Gateway HTTP seam**: fixture-web calls the Gateway with its token against the fake Provider and gets a completion.
- Terminal path tested for spawn/exit/resize through node-pty without rendering xterm.

## Out of Scope

- Downloading from the Store, sha256 verification, update flow (P0-10); consent dialog design (P0-10, reused here); SDK and example Harnesses (P0-06, they double as manual test subjects); Python runtime (P0.5-01); background Harnesses (P1-08); sandboxing (never in P0).

## Further Notes

- Windows process-tree termination and pty behaviour are the riskiest parts; budget time for them and test on Windows CI.
- Bundled Node adds size per platform; acceptable per ADR-0003.

## Blocked by

- P0-02 Model Gateway core
- P0-03 Provider Connections and Slot Bindings
- P0-04 Desktop app shell, i18n and first-run wizard
