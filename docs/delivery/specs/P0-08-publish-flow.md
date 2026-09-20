---
spec_id: P0-08
title: Publish flow
phase: P0
blocked_by: [P0-04, P0-07]
requirements: [R-0801, R-0802, R-0803, R-0804]
---

# P0-08 Publish flow

## Problem Statement

A Publisher who has built a Harness has no way to get it into the Store short of hand-crafting API calls. They need to know before uploading whether their package is valid, see what the listing will look like, upload with feedback, and later manage the versions they published. The Store side (P0-07) already validates and stores; what is missing is the in-app path from a folder on disk to a live listing, and back to withdraw a version.

## Solution

A Publish screen in the desktop app implementing flow F5 in `docs/ux/flows.md`: GitHub sign-in (only here), pick a folder, immediate local validation with the shared Manifest package, a read-only preview of the listing derived from the Manifest, upload with progress through the Store's `publish` function, and a success state linking to the listing. The same screen lists the signed-in Publisher's Harnesses and versions with Unpublish, and offers "Install this folder locally" so a Publisher can test before publishing.

## User Stories

1. As a Publisher, I want to sign in with GitHub from the Publish screen, so that I only create an account when I actually want to publish.
2. As a Publisher, I want sign-in to happen in my system browser and return me to the app, so that I never type my GitHub password into a desktop app.
3. As a Publisher, I want to see which GitHub account I am signed in as and sign out, so that I can switch accounts if I maintain more than one.
4. As a Publisher, I want to choose a folder by button or drag-and-drop, so that publishing starts from where my code already is.
5. As a Publisher, I want validation to run the moment I pick a folder, so that I find problems before I have filled in anything.
6. As a Publisher, I want each problem shown with the Manifest field path, a stable code and a plain-language message in my UI language, so that I can fix it quickly.
7. As a Publisher, I want validation to re-run when I press Re-check or when files in the folder change, so that I can iterate without re-picking the folder.
8. As a Publisher, I want the Continue button disabled until there are zero problems, so that I cannot upload something the Store will reject anyway.
9. As a Publisher, I want to see the Harness ID prefix the Store expects from me (my login plus a slash), so that a mismatch is explained before I upload.
10. As a Publisher, I want the app to check the Store for my last published version of this Harness before upload and tell me if my version is not greater, so that I do not wait for a full upload to learn that.
11. As a Publisher, I want a preview of my listing (icon, name, summary, tags, permissions with the trust block, Slots, platforms, README), so that I see what Users will see.
12. As a Publisher, I want the changelog from my Manifest shown in the preview, so that I remember to write one.
13. As a Publisher, I want the app to build the zip for me from the folder, so that I do not have to worry about archive layout.
14. As a Publisher, I want the app to exclude obvious junk (`.git`, `.DS_Store`, editor swap files) from the archive and tell me what it excluded, so that packages stay clean.
15. As a Publisher, I want to see the archive size before upload and be warned when it is over 100 MB, so that I can trim it.
16. As a Publisher, I want an upload progress bar and a Cancel button, so that a large upload is not a black box.
17. As a Publisher, I want server errors shown verbatim with their code and a Retry button, so that a transient failure does not make me start over.
18. As a Publisher, I want a success screen with a link that opens my listing in the Store tab, so that I can check it immediately.
19. As a Publisher, I want to be reminded on the success screen that published versions are immutable, so that I understand I must publish a new version to change anything.
20. As a Publisher, I want a "My Harnesses" section listing each Harness with its versions, status and download counts, so that I can manage what I have published.
21. As a Publisher, I want to Unpublish a version after a confirmation that names the version and says existing installs keep working, so that I can withdraw a release safely.
22. As a Publisher, I want to install the folder locally and launch it without publishing, so that I can test the real launch contract on my machine.
23. As a Publisher, I want locally installed Harnesses marked "Local" in the Library and excluded from Store update checks, so that they are not confused with Store installs.
24. As a Publisher, I want re-installing the same folder locally to replace the previous local install and keep its Data Directory, so that iterating is fast.
25. As a Publisher, I want to publish while offline to fail early with a clear offline banner, so that I do not fill in a form that cannot be submitted.
26. As a Publisher, I want an expired session to prompt me to sign in again without losing my chosen folder, so that a long editing session does not cost me work.
27. As a User who never publishes, I want the Publish screen to explain in one paragraph that only Publishers need an account, so that I am not confused about why sign-in exists.

## Implementation Decisions

- **Auth**: Supabase Auth GitHub OAuth with a PKCE flow opened in the system browser; the app registers a custom URL scheme to receive the callback. Session tokens are stored via the encrypted secrets mechanism from P0-03 (same `safeStorage` path), never in plain files. Signed-in state is shown only on the Publish screen.
- **Folder validation** uses `validatePackage()` from the Manifest package against the folder (treating it as the archive root), including file existence checks. A file watcher re-validates with a 500 ms debounce; the Re-check button forces it. Problems render as a list ordered by path; messages are looked up by code in the message catalogs with a fallback to the validator's English text.
- **Pre-flight version check** calls `latest_versions` for the Manifest `id` when signed in; if the Harness exists and the version is not greater, a problem with code `version_not_greater` is added to the list so the same disabled-Continue logic applies. If the Harness does not exist yet, the preview says "New Harness".
- **Publisher mismatch** is checked locally against the signed-in login before upload with code `publisher_mismatch`, in addition to the server check.
- **Archive build**: deterministic zip (stable ordering, no timestamps) from the folder, excluding `.git/`, `node_modules/.cache/`, `.DS_Store`, `Thumbs.db`, `*.swp`, and anything matched by an optional `.harnessignore` file at the folder root using gitignore syntax. The exclusion summary is shown before upload. Symlinks are refused with a problem rather than followed.
- **Upload** goes to the `publish` Edge Function as multipart with progress events surfaced over IPC. Cancel aborts the request; a cancelled or failed upload leaves no server state (guaranteed by P0-07).
- **Screen state machine** (from the flow design):

  ```
  signed_out → signing_in → idle
  idle → validating → invalid | valid
  valid → uploading → success | failed
  failed → uploading (retry) | valid (edit)
  any → idle (choose another folder)
  ```

- **My Harnesses** reads the Publisher's Harnesses through PostgREST with the session JWT (RLS lets them see their own Unpublished versions in addition to published ones via a Publisher-only policy added in this spec's migration). Unpublish calls the function and refreshes the list.
- **Local install** reuses the Runtime's "install from folder" from P0-05; the Publish screen only triggers it and shows the result.
- **Copy**: every user-facing string exists in `en` and `zh-CN`; the trust block in the preview uses the same component as the Store detail page (P0-09) so wording never diverges.

## Testing Decisions

- **Seams**: Manifest validation seam (pure functions with fixture folders) for problem lists; Store seam (Supabase local) for pre-flight version check, publish success/failure paths and Unpublish; Desktop E2E seam (Playwright for Electron) for one smoke journey: sign in with a stubbed OAuth provider → pick fixture folder → see zero problems → publish → success link opens the listing.
- **Good tests** assert what the Publisher sees and what the Store contains afterwards: a folder with a bad icon yields exactly one problem at `assets/icon.png`; a version equal to the last published shows `version_not_greater` before any network upload is attempted (assert no `publish` call); cancelling mid-upload leaves no version in the local Store.
- **Fixtures**: fixture packages from P0-01 (as folders), a stub OAuth server for E2E, seeded Store from P0-07.
- **Prior art**: Store tests from P0-07; renderer component tests from P0-04.

## Out of Scope

- GitHub repository import (`owner/repo@tag`) and webhook auto-publish (P0.5-03, P1-09).
- Editing listing metadata independently of the Manifest (everything comes from the Manifest in P0).
- Beta Channel selection (P1-02).
- Publisher analytics beyond raw counts (P1-05).
- Automated content scanning at publish time (P1-07).

## Further Notes

- The Publisher-only RLS policy for reading own Unpublished versions is the only schema change this spec introduces; keep it in its own migration.
- A CLI publish path is deliberately not in P0; the folder picker is the single supported path.

## Blocked by

- P0-04 Desktop app shell, i18n and first-run wizard
- P0-07 Store backend (Supabase schema, auth, storage, edge functions)
