---
spec_id: P0-13
title: End-to-end acceptance, CI and unsigned builds
phase: P0
blocked_by: [P0-06, P0-08, P0-10, P0-11, P0-12]
requirements: [R-1301, R-1302, R-1303]
---

# P0-13 End-to-end acceptance, CI and unsigned builds

## Problem Statement

Each P0 spec is tested at its own seam, but nothing proves the product promise as a whole: that a new User can go from a fresh install to running a Store Harness on their own model in under ten minutes, and that a Publisher's upload really reaches a User's machine and runs. There is also no continuous integration that runs every seam's tests on each push, and no installable artifact for the three platforms. Without this, "P0 done" cannot be demonstrated.

## Solution

A CI pipeline that runs unit, Gateway conformance, Supervisor, Store (Supabase local) and Playwright-for-Electron smoke tests on every push and pull request; a single end-to-end acceptance journey that exercises publish → discover → install → launch → model call through the Gateway → usage visible, with Providers faked and a wall-clock budget; and unsigned distributable builds (macOS dmg, Windows nsis, Linux AppImage) produced as CI artifacts on the main branch and on tags. Code signing and notarisation are explicitly deferred.

## User Stories

1. As a maintainer, I want every push to run the full test suite across seams, so that regressions are caught before merge.
2. As a maintainer, I want the CI matrix to include macOS, Windows and Linux runners for the desktop tests, so that platform-specific breakage (paths, pty, executable bits) is caught.
3. As a maintainer, I want the Store tests to run against a Supabase local stack started in CI, so that Edge Functions and RLS are tested for real, not mocked.
4. As a maintainer, I want the Gateway conformance suite to run against the fake Provider on every push and against real Providers on a nightly schedule using secrets, so that adapter drift is caught without making every PR depend on external APIs.
5. As a maintainer, I want one acceptance journey that proves the ten-minute promise, so that the P0 definition of done is a test, not an opinion.
6. As a maintainer, I want the acceptance journey to publish a reference Harness through the real Publish path, so that the Publisher side is covered end to end.
7. As a maintainer, I want the acceptance journey to run with a fake Ollama so it never needs a real model, so that CI is deterministic.
8. As a maintainer, I want the acceptance journey to assert a Usage Record exists after the Harness's model call, so that the Gateway attribution is proven.
9. As a maintainer, I want the acceptance journey to fail if it exceeds the wall-clock budget, so that performance regressions in install or launch are visible.
10. As a maintainer, I want unsigned builds for all three platforms as downloadable CI artifacts, so that I can hand a build to an early tester today.
11. As a maintainer, I want builds on tags to attach artifacts to a GitHub release draft, so that versioned builds are easy to find.
12. As a maintainer, I want the bundled Node runtime included in each build and verified by a smoke launch of the terminal reference Harness, so that "Node Harnesses just run" is true on every platform.
13. As a maintainer, I want CI to fail if `en` and `zh-CN` catalogs have missing keys, so that translations never silently regress.
14. As a maintainer, I want lint and type checks to run before tests, so that cheap failures fail fast.
15. As a maintainer, I want flaky-test detection (retry once, report flakiness), so that intermittent failures are visible without blocking.
16. As a maintainer, I want a documented local command that runs the same suite as CI, so that contributors can reproduce failures.
17. As an early tester on macOS, I want a note in the release describing how to open an unsigned app, so that Gatekeeper does not look like a broken build.
18. As a Publisher, I want the acceptance journey to double as a living example of the launch contract, so that I can read a real end-to-end script.

## Implementation Decisions

- **CI provider**: GitHub Actions. Workflows: `ci` (on push and PR), `nightly` (real-Provider conformance with repository secrets), `build` (on main and tags).
- **`ci` jobs**: lint+typecheck (ubuntu) → unit tests for all packages (ubuntu) → Gateway conformance vs fake Provider (ubuntu) → Store tests with Supabase CLI local stack (ubuntu) → Supervisor tests (matrix: macos, windows, ubuntu) → Playwright-for-Electron smoke (matrix: macos, windows, ubuntu, with a virtual display on Linux) → acceptance journey (macos and ubuntu). Jobs share a pnpm cache; failing lint skips the rest.
- **Acceptance journey** (single Playwright script, budget 10 minutes wall-clock in CI, target under 5): start Supabase local with the seed → start fake Ollama (the fake Provider from P0-02 configured on port 11434 with a model named `qwen3:8b`) → launch a fresh Electron profile → wizard detects Ollama and binds `default` → Publish `examples/hello-web` via the Publish screen using a stubbed OAuth session → Store search finds it → Install → consent → Launch → wait for the Harness window → drive its page to send one message → assert the response text came from the fake Provider script → open Usage and assert one record for `hello-web` on `ollama/qwen3:8b` → uninstall. Every step logs a timestamp so regressions are attributable.
- **Catalog check**: a script compares message keys across `en` and `zh-CN` and fails on any difference.
- **Builds**: electron-builder targets dmg (arm64 and x64), nsis (x64), AppImage (x64) with the bundled Node LTS for each platform; `CSC_IDENTITY_AUTO_DISCOVERY=false` and no notarisation. Artifacts uploaded per platform; on tags a draft GitHub release is created with the artifacts and release notes containing the unsigned-app instructions (macOS: right-click Open or remove the quarantine attribute; Windows: SmartScreen "More info → Run anyway").
- **Post-build smoke**: each built app is launched headlessly with a flag that installs and runs `examples/hello-term` for one turn against the fake Provider and exits 0; failure fails the build job.
- **Flakiness**: Playwright retries 1 in CI; a summary step lists tests that passed only on retry.
- **Local parity**: a single root script runs the same sequence locally, skipping platform matrices.

## Testing Decisions

- **Seams**: this spec sits at the Desktop E2E seam (architecture §8, item 5) and orchestrates all lower seams in CI; it adds no new seams.
- **Good tests** here are journeys phrased entirely in User-visible terms (screens, buttons, text) with assertions on observable outcomes (window opened, text shown, Usage row visible); no reaching into internal state.
- **Fixtures**: seeded Store, fake Provider scripts, reference Harnesses from P0-06, stub OAuth server from P0-08.
- **Prior art**: the smoke tests introduced by P0-04, P0-08 and P0-10.

## Out of Scope

- Code signing, notarisation, auto-update of the desktop app itself, and store submission (deferred by the product owner; tracked on the roadmap under "before public launch").
- Performance benchmarking beyond the wall-clock budget.
- Real-Provider tests on PRs.

## Further Notes

- The acceptance journey is the P0 definition of done from `docs/product/prd.md`; keep it green and keep it honest (no shortcuts that bypass real screens).

## Blocked by

- P0-06 Harness SDK and reference Harnesses
- P0-08 Publish flow
- P0-10 Install, update and uninstall from the Store (Library)
- P0-11 Usage page and Settings
- P0-12 Report and Takedown
