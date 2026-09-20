---
spec_id: P0-09
title: Store browsing and discovery
phase: P0
blocked_by: [P0-04, P0-07]
requirements: [R-0901, R-0902, R-0903, R-0904, R-0905]
---

# P0-09 Store browsing and discovery

## Problem Statement

A User who opens the app has no way to discover what Harnesses exist, judge whether one is trustworthy and useful, or find one by name or purpose. The Store backend holds the catalogue, but there is no in-app surface that presents Featured items, search results, a detail page with everything the Manifest declares, or a Publisher's page.

## Solution

The Store tab of the desktop app: a home page (Featured, tag chips, Most downloaded, New), search with tag and platform filters, a Harness detail page that renders every Manifest-derived fact including Declared Permissions with the trust notice, Model Slots with requirements and Recommended Models, version history with changelogs, and an install button whose state reflects platform support and install status. A Publisher page lists that Publisher's active Harnesses. All reads are anonymous PostgREST/RPC calls from P0-07 via the Runtime's IPC layer, with offline and error states per `docs/ux/design-principles.md`.

## User Stories

1. As a User, I want the Store home to open on a Featured row, so that I see curated Harnesses first.
2. As a User, I want "Most downloaded" and "New" lists on the home page, so that I can discover popular and fresh Harnesses without searching.
3. As a User, I want tag chips on the home page, so that I can browse by purpose in one click.
4. As a User, I want a search box in the header that searches name, summary, tags and README, so that I can find a Harness by what it does.
5. As a User, I want search to work for Chinese names and tags, so that Harnesses from Chinese Publishers are findable.
6. As a User, I want results to show icon, name, Publisher, summary, tags, download count and platform badges, so that I can compare at a glance.
7. As a User, I want results filtered to my platform by default with a toggle to show all, so that I mostly see things I can install but can still look at everything.
8. As a User, I want to combine text, tag and platform filters, so that I can narrow results precisely.
9. As a User, I want paging or infinite scroll on results, so that large result sets do not stall the app.
10. As a User, I want an empty-results state that suggests clearing filters, so that I am not stuck.
11. As a User, I want the detail page to show the Harness ID, name, Publisher (linked), summary, README rendered as Markdown, screenshots and tags, so that I understand what it is.
12. As a User, I want README rendering to strip scripts, iframes and remote-loading tricks, so that a listing cannot attack the app.
13. As a User, I want Declared Permissions shown with the red/yellow/green scale and concrete sentences ("Runs shell commands", "Reads and writes files in the folder you choose"), so that I understand the risk before installing.
14. As a User, I want the standing notice that Harness Store does not isolate Harnesses on every detail page, so that I am never surprised later.
15. As a User, I want to see the runtime kind (Node on the bundled runtime / native executable), UI Kind and Workspace requirement, so that I know how it will run.
16. As a User, I want to see each Model Slot with its description, requirements and Recommended Models, and whether my current Connections can fill it, so that I know if it will work with my models before installing.
17. As a User, I want version history with dates and changelogs, so that I can see how actively the Harness is maintained.
18. As a User, I want a link to the source repository when the Publisher provided one, so that I can inspect the code.
19. As a User, I want the install button to read Install, Installed (Launch), Update available, Not available for your platform, or Removed from Store depending on state, so that the primary action is always correct.
20. As a User, I want a Publisher page listing that Publisher's active Harnesses with their bio and avatar, so that I can find more from an author I trust.
21. As a User, I want the Store to show an offline state with what I can still do (Library, Models), so that losing connectivity does not look like a crash.
22. As a User, I want a server error to show an inline message with Retry, so that a transient failure is recoverable.
23. As a User, I want a Report link on the detail page, so that I can flag a harmful Harness from where I found it.
24. As a User, I want the detail page to open from a Library card too, so that I can read about something I already installed.
25. As a User, I want the last search and filters remembered while the app is open, so that going back from a detail page does not lose my place.
26. As a Publisher, I want my listing to render exactly what my Manifest declared, so that the preview in the Publish flow matches the live page.
27. As a Store administrator, I want Featured order to follow the rank I set, so that curation is deterministic.

## Implementation Decisions

- **Data access**: all reads use the RPCs and PostgREST queries listed in `docs/tech/api.md` through IPC methods `store.home`, `store.search`, `store.detail`, `store.publisher`; the renderer never talks to Supabase directly. Responses are cached in memory for the app session with a 5-minute staleness window; detail pages refetch on open.
- **Home composition**: Featured = active Harnesses with non-null rank ordered ascending (max 12); Most downloaded = top 12 by `download_count`; New = 12 most recent `published_at` of latest versions. All three exclude Harnesses with no published version.
- **Search** calls `search_harnesses(q, tags, platform, limit, offset)`; the platform argument is the current OS/arch unless "Show all platforms" is on. Page size 24, "Load more" appends. Debounce typed input by 300 ms; Enter searches immediately.
- **Platform badges** derive from the latest version's `platforms`; the current platform is highlighted, unsupported ones greyed.
- **Detail page sections** in order: header (icon, name, Publisher, summary, install button, platform badges, download count), trust block (Declared Permissions with severity: red = `shell: true` or `filesystem.scope` of `home`/`paths`, or `network.any`; yellow = `filesystem.scope = workspace` or named domains; green = `none`/no network; plus the no-sandbox sentence), How it runs (runtime kind, UI Kind, Workspace), Models (Slots, requirements, Recommended Models, reachability computed from the User's Connections via the P0-03 IPC), Screenshots, README, Versions (published only, newest first, with changelog and permission-change markers), Footer (license, homepage, source, Report link).
- **README rendering**: Markdown to sanitised HTML with an allowlist (headings, paragraphs, lists, code, links, images from the asset bucket or data URIs only, tables); external links open in the system browser; no raw HTML passthrough.
- **Install button state machine** (evaluated on render):

  ```
  taken_down            → "Removed from Store" (disabled)
  no version for OS     → "Not available for <platform>" (disabled)
  not installed         → "Install"
  installed, same ver   → "Launch" (secondary: Uninstall)
  installed, older ver  → "Update"
  downloading           → progress + Cancel
  ```

  Install/Update/Launch actions are delegated to P0-10 and P0-05; this spec only renders state and routes the click.
- **Publisher page** reads `profiles` with nested `harnesses` and filters to `status = active` with a latest version.
- **Copy**: all strings in `en` and `zh-CN`; permission sentences are generated from Manifest fields by a shared function also used by the consent dialog (P0-10) and Publish preview (P0-08).
- **Navigation**: Store routes are `/store`, `/store/search`, `/store/h/<publisher>/<slug>`, `/store/p/<login>`; the router preserves search state in the history entry.

## Testing Decisions

- **Seams**: Store seam for RPC behaviour (ranking, filters, exclusion of Unpublished/taken-down), renderer component tests for the detail page state machine and the permission-severity mapping (pure function), Desktop E2E for one journey: home → search → detail → Publisher page → back with filters intact.
- **Good tests** check what a User sees: searching a seeded Chinese name returns that Harness first; a Harness whose latest version lacks the test platform renders the disabled platform button; a README containing a script tag renders without it; an Unpublished-only Harness does not appear anywhere.
- **Fixtures**: seeded local Store from P0-07 including one Featured, one taken-down, one platform-limited Harness and one README with hostile HTML.
- **Prior art**: P0-04 component test setup; P0-07 store-test harness.

## Out of Scope

- Download, verification, consent and install execution (P0-10).
- Launch (P0-05).
- Ratings and reviews (P1-04).
- Report submission dialog (P0-12; this spec only places the link).
- Any personalised recommendation.

## Further Notes

- The permission-severity mapping is a product decision; keep it in one shared function with tests so the detail page, consent dialog and Publish preview cannot disagree.

## Blocked by

- P0-04 Desktop app shell, i18n and first-run wizard
- P0-07 Store backend (Supabase schema, auth, storage, edge functions)
