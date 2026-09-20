---
spec_id: P1-09
title: GitHub webhook auto-publish
phase: P1
blocked_by: [P0.5-03]
requirements: [R-P1-09]
---

## Problem Statement

With P0.5-03 a Publisher can import `owner/repo@tag` from the desktop app, but every release still requires opening the app and clicking through the Publish flow. Publishers who already manage releases through Git want a tag push to be the release. Without this, the Store lags behind the Publisher's own release cadence and Publishers maintain two processes.

## Solution

A Publisher connects a GitHub repository to a Harness from the Publisher area of the desktop app (or a web page in the Store). The Store installs a GitHub App on that repository. When a tag matching the configured pattern is pushed, GitHub calls the Store's webhook; the Store fetches the tag archive, validates it with the same package validation as every other publish (including the requirement that the Manifest `id` matches the connected Harness and that the version is greater), stores the package, and creates the Harness Version. The Publisher sees the outcome (published, or failed with the validation problems) in the app and, optionally, as a commit status / check on GitHub. Nothing changes for Users: the listing simply updates.

## User Stories

1. As a Publisher, I want to connect a GitHub repository to one of my Harnesses, so that releases flow from Git.
2. As a Publisher, I want the Store to verify I have admin rights on the repository, so that no one can connect a repo they do not control.
3. As a Publisher, I want a tag push (for example `v1.2.0`) to publish that version automatically, so that I do not need the desktop app to release.
4. As a Publisher, I want to configure the tag pattern and the subdirectory of the repo that contains the Harness, so that monorepos and custom tag styles work.
5. As a Publisher, I want a failed auto-publish to tell me exactly which validation problems occurred, so that I can fix and re-tag.
6. As a Publisher, I want auto-publish to refuse a version that is not greater than what is already published, so that I cannot accidentally regress.
7. As a Publisher, I want a GitHub check run on the tag commit showing success or failure, so that the result is visible where I work.
8. As a Publisher, I want to disconnect the repository at any time, so that a compromised or transferred repo stops publishing under my name.
9. As a Publisher, I want the Harness `sourceRepo` field to be set automatically to the connected repository, so that Users can find the source.
10. As a Publisher, I want to publish to the `beta` Channel from a tag pattern such as `v*-beta*`, so that pre-releases go to opted-in Users only (when P1-02 is available).
11. As a Publisher, I want a history of webhook deliveries with their outcomes, so that I can debug a missed release.
12. As a Publisher, I want to manually re-trigger processing of a tag from the history view, so that a transient failure does not require re-tagging.
13. As a Publisher, I want auto-publish to reuse my existing Store identity (GitHub login), so that the Harness ID `publisher/slug` rule is unchanged.
14. As a User, I want auto-published versions to look and behave exactly like manually published ones, so that provenance does not affect trust or install flow.
15. As an admin, I want auto-published packages to go through the same scanning (P1-07) and to respect Takedowns (a taken-down Harness cannot be revived by a tag), so that automation does not bypass moderation.
16. As the maintainer, I want webhook processing to be idempotent per (repo, tag, commit), so that GitHub redeliveries do not create duplicates.
17. As the maintainer, I want the fetch step to reject archives above the package size limit before downloading them fully, so that a huge repository cannot exhaust the function.

## Implementation Decisions

- **GitHub App, not OAuth scopes:** the Store registers a GitHub App with `contents: read`, `metadata: read`, `checks: write` and the `push` (tags) event. The Publisher installs it on selected repositories. Connection requires the installing GitHub user to match the Publisher's login and to have admin permission on the repo, checked via the App's installation API.
- **Connection record:** `repo_connections` table (harness id, repo full name, installation id, tag pattern default `v*`, subdirectory default repo root, channel mapping, enabled, created by). One connection per Harness; a repo may back several Harnesses only via different subdirectories.
- **Processing:** webhook → verify signature → look up connection → check tag matches → enqueue job keyed by (repo, tag, commit sha) → job downloads the tag archive via the App token (streaming with size check), extracts the subdirectory, runs the shared package validation, enforces `id` match with the connected Harness, enforces version greater, stores the package, creates the Harness Version. Exactly the P0.5-03 import path executed server-side; no second validation code path.
- **Version source of truth:** the Manifest `version` inside the archive, not the tag. A mismatch between tag and Manifest version is a validation problem (so `v1.2.0` with Manifest `1.1.9` fails), keeping both honest.
- **Outcome reporting:** a check run on the commit (`Harness Store publish: success/failure`) with problems listed; a `publish_runs` history (connection, tag, sha, status, problems, started/finished) shown in the app.
- **Channel mapping:** when P1-02 exists, tags matching a configurable pre-release pattern publish to `beta`; otherwise all to `stable`.
- **Moderation:** taken-down Harnesses reject webhook publishes; scanning (P1-07) runs as for any publish.
- **Idempotency:** unique constraint on (connection, sha); redelivery returns the existing run.
- Decide at implementation: whether the job runner is a Supabase queue/cron pattern or an external worker; the interface (a `publish_runs` row moving through states) is fixed either way.

## Testing Decisions

- Good tests replay real-shaped webhook payloads and assert Store state and reported outcome, not internal steps.
- **Store seam (architecture §8 seam 4):** with a fake GitHub API (archive download, installation lookup, check-run endpoint): valid tag → version created identical to a manual publish of the same archive; invalid Manifest → run failed with problems and failing check; non-greater version → failed; redelivery → no duplicate; disconnected repo → ignored; taken-down Harness → refused.
- **Signature verification tests** with bad and missing signatures.
- **Manifest seam (seam 2):** subdirectory extraction fixtures (repo root vs nested) reuse P0.5-03 fixtures.
- Prior art: P0-07 Edge Function tests and P0.5-03 import tests.

## Out of Scope

- Building Harness Packages from source (running `npm run build` on the Store). The tag must contain the ready-to-run package contents, as with folder publishing.
- GitLab or other forges.
- Pull-request preview publishes.
- Repository connection from the Store website only if a Publisher web UI exists; otherwise the desktop app is the only surface.

## Further Notes

- This spec makes the earlier decision (round two) to defer server-side repository fetching until after P0 concrete: it arrives only once the client-side import path (P0.5-03) has proven the validation and packaging rules.

## Blocked by

- P0.5-03 GitHub import for publishing
