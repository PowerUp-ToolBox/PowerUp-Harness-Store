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

The Store tab of the desktop app: a home page (Featured, New, Most downloaded) under a filter row (search box, tag chips, "My platform only"), ranked search results with tag and platform filters, a Harness detail page that renders every Manifest-derived fact including Declared Permissions with the trust notice, Model Slots with requirements, Recommended Models and what each would use on this machine, the version history with changelogs, and a primary button whose state reflects platform support and install status. A Publisher page lists that Publisher's active Harnesses. All reads are anonymous PostgREST/RPC calls from P0-07 made by the Runtime behind new IPC methods, with the existing offline panel and an inline server-error state per `docs/ux/design-principles.md`. Home, search and the Publisher page share one card; the detail page is the listing component the Publish preview and the consent dialog already use.

## User Stories

1. As a User, I want the Store home to open on a Featured row, so that I see curated Harnesses first.
2. As a User, I want "New" and "Most downloaded" lists on the home page, so that I can discover popular and fresh Harnesses without searching.
3. As a User, I want tag chips at the top of the Store, so that I can browse by purpose in one click.
4. As a User, I want a search box at the top of the Store that searches name, summary, tags and README, so that I can find a Harness by what it does.
5. As a User, I want search to work for Chinese names, part of a Chinese name, and tags, so that Harnesses from Chinese Publishers are findable.
6. As a User, I want results to show icon, name, Publisher, summary, tags, download count and platform badges, so that I can compare at a glance.
7. As a User, I want results filtered to my platform by default with a "My platform only" toggle, so that I mostly see things I can install but can still look at everything.
8. As a User, I want to combine text, tag and platform filters, so that I can narrow results precisely.
9. As a User, I want a "Load more" button on results, so that large result sets do not stall the app.
10. As a User, I want an empty-results state that offers to clear filters, so that I am not stuck.
11. As a User, I want the detail page to show the Harness ID, name, Publisher (linked), summary, latest version, README rendered as Markdown, screenshots and tags, so that I understand what it is.
12. As a User, I want README rendering to strip scripts, iframes and remote-loading tricks, so that a listing cannot attack the app.
13. As a User, I want Declared Permissions shown with the red/yellow/green scale and concrete sentences ("Runs shell commands", "Reads and writes files in the folder you choose"), so that I understand the risk before installing.
14. As a User, I want the standing notice that Harness Store does not isolate Harnesses on every detail page, so that I am never surprised later.
15. As a User, I want to see the runtime kind (Node on the bundled runtime / native executable), UI Kind and Workspace requirement, so that I know how it will run.
16. As a User, I want to see each Model Slot with its description, requirements and Recommended Models, and which of my Connections would fill it, so that I know if it will work with my models before installing.
17. As a User, I want version history with dates, changelogs and a marker where Declared Permissions changed, so that I can see how actively the Harness is maintained and when it asked for more.
18. As a User, I want a link to the source repository and homepage when the Publisher provided them, opened in my browser, so that I can inspect the code.
19. As a User, I want the primary button to read Install, Launch, Update, Not available for your platform, or Removed from Store depending on state, so that the primary action is always correct.
20. As a User, I want a Publisher page listing that Publisher's active Harnesses with their name, bio, avatar, join date and total downloads, so that I can find more from an author I trust.
21. As a User, I want the Store to show an offline state with Retry while the rest of the app (Library, Models) keeps working, so that losing connectivity does not look like a crash.
22. As a User, I want a server error to show an inline message with Retry, so that a transient failure is recoverable.
23. As a User, I want a Report entry on the detail page, so that I can flag a harmful Harness from where I found it.
24. As a User, I want to open the detail page from a Library card ("View in Store"), so that I can read about something I already installed, even when the Store no longer offers it.
25. As a User, I want the last search and filters remembered while the app is open, so that going back from a detail or Publisher page does not lose my place.
26. As a User, I want every Publisher name to link to their Publisher page, so that I can follow an author from anywhere.
27. As a Publisher, I want my listing to render exactly what my Manifest declared, so that the preview in the Publish flow matches the live page.
28. As a Store administrator, I want Featured order to follow the rank I set, so that curation is deterministic.

## Implementation Decisions

- **Data access**: every read is one of `docs/tech/api.md`'s anonymous PostgREST reads or RPCs at the `store_base_url` setting, made in main (Electron-free, plain `fetch` with the anon key alone, whoever is signed in) behind four new IPC methods: `store.home`, `store.search`, `store.detail`, `store.publisher`; the renderer never talks to Supabase. Row-level security alone hides taken-down and Unpublished-only Harnesses; the client adds no visibility filter. Every answer carries this machine's platform (`<process.platform>-<process.arch>`, or null when no Manifest can declare it) for badge highlighting. Only `store.home` is cached; search, detail and Publisher reads go to the Store every time. api.md documents the four methods.
- **Errors and offline**: a network failure, abort or timeout (15 s, the body read included) is `store_unreachable` and calls `connectivity.reportFailure()`, so P0-04's Store offline panel ("Can't reach the Store", Retry) replaces the Store's pages once the check finds the Store unreachable, while Library and Models keep working. A 5xx, another refusal or a body that is not the expected shape is a new IPC code `store_error` (en and zh-CN), shown inline as "Couldn't load the Store" with Retry. Showing the last fetched lists with an offline banner is not built.
- **Store images**: the renderer's CSP allowed no Store origin, so main registers a `store-asset:` scheme that fetches only `<store_base_url>/storage/v1/object/public/harness-assets/<path>` (dot segments, other hosts, queries and the like refused), and `img-src` adds `store-asset:`. Main returns icons and screenshots as `store-asset://harness-assets/<path>`. Avatars are kept only on `https://avatars.githubusercontent.com`, the one avatar host the CSP allows; any other shows the monogram.
- **Shared card** (P0-09.1): home, search and the Publisher page use the one `HarnessCard` from P0-08, which gains tags, a name link stretched over the card to `/store/h/<id>` and a separate Publisher link to `/store/p/<login>` (no nested anchors). Cards show the Publisher's login (the Harness ID's publisher segment); no display name is fetched. Platform badges list the Harness's declared platforms with this machine's highlighted, and add one greyed "not supported" badge for this machine's platform when it is not declared; the Publish preview uses the same badges. The list reads embed `harness_versions(version,platforms)` and main takes the badges from the row whose version is `latest_version` (api.md's `<list columns>`; no migration).
- **Home** (P0-09.1): `store.home` makes api.md's three home reads in parallel and answers them together (one failure fails all): Featured (non-null `featured_rank` ascending), Most downloaded (`download_count`) and New (`latest_published_at`), 12 each. Featured comes first, then New and Most downloaded side by side (docs/ux and the design canvas). The answer is kept in memory 5 minutes per `store_base_url`; Retry (`{ refresh: true }`) bypasses it, and failures are never kept. Skeletons per section while loading; an empty row is hidden, and an empty Store says "There are no Harnesses in the Store yet." Home rows are never platform-filtered.
- **Filter row and search** (P0-09.2): the search box, the ten curated tags as chips (schema order, translated) and "My platform only" (on by default) form one filter row at the top of `/store`; there is no search box in the shell header and no `/store/search` route. Search mode is on only when the text is non-blank or a tag is selected; then the results replace the home rows, and the platform toggle alone keeps the home rows. `store.search({ q, tags, allPlatforms, offset })` (text up to 200 characters, curated tags once each, an integer offset) calls `search_harnesses` with POST, `limit` 24 and `platform` filled in by main (null when `allPlatforms` or when this machine has no platform), answering `{ platform, listings, hasMore }` in the Store's order (the client never re-sorts); `hasMore` when the page was full, which shows "Load more". Typed text is searched 300 ms after the last keystroke; Enter, a tag and the toggle search at once; emptying the box with no tag goes home at once. Text an input method is still composing is not searched until `compositionend`. Searches are numbered and stale answers dropped (Load more included), and merged pages are de-duplicated by Harness ID. Skeletons while searching, "No Harnesses match" with Clear filters (clears text and tags, keeps the toggle), and an inline error with Retry; a failed Load more keeps the loaded pages.
- **Chinese search** (P0-09.2): verified on the local stack that `写作` did not find `写作助手` (the `simple` parser keeps a CJK run as one token). A new migration redefines `search_harnesses`: when `q` (trimmed) holds a CJK character, a Harness whose `name` or `summary` contains all of `q` also matches (`ILIKE '%' || q || '%'`, with `%`, `_` and `\` taken literally), name matches first, then summary matches, then the existing order; English queries are unchanged and the README gets no substring match. Tags are a closed English list, so a Chinese tag is reached by its translated chip; free text such as "写作" is never mapped to a tag. api.md and the P0-07 spec say so.
- **Search state**: text, tags, toggle and loaded pages live in a provider in the Shell above the Store routes, in memory only (not the history entry, not persisted), so Back from a detail or Publisher page, another tab, or the sidebar's Store item restores them.
- **Detail read** (P0-09.3): `store.detail(harnessId)` makes api.md's detail read with named columns (so the `search` vector is not sent), its published `harness_versions` newest first with their `permissions`, then the Version manifest read of `latest_version` (`manifest,readme,screenshot_paths`); the Manifest must pass `validateManifest`, else `store_error`. Only when the detail read is empty does it call `latest_versions([id])`, answering `storeStatus` (`taken_down`, `unpublished`, `not_found`) and `harness: null`. A version whose `published_at` does not parse is left out of the history. A version is marked "Permissions changed" when its `permissions` are not deep-equal to the next older published version's; there is no other diff logic.
- **Detail page sections** in docs/ux order, through the shared `ListingDetail`, so the Publish preview follows the same order: Back (`navigate(-1)` with in-app history, else `/store`); header (icon, name, Publisher avatar and name linked to their page, summary, latest version, primary button, platform badges, download count, tags); screenshots (up to five, a strip; the Publish preview has none); trust block (`TrustBlock`, with How it runs inside it: runtime kind, UI Kind, Workspace, and the unchanged no-sandbox sentence); Models (each Slot's description, Model Requirements, Recommended Models and "Will use: <Connection> · <model>" or "No Connection can fill this Slot"); README; Versions (published only, newest first, with publish date, changelog, the "Permissions changed" marker and the installed version marked); footer (license, homepage, source, Report). Every Manifest field has a place except these, which are deliberately not shown: `manifestVersion`, `$schema`, `x-*`, `entry`, `ui.path`, `ui.readyTimeoutSeconds`, `ui.window`, `runtime.node`, `channel`.
- **Severity**: P0-05's `permissionItems` stays the one shared, pure function used by the trust block, the consent dialog and the Publish preview; it already matched this spec's rule (high = `shell: true`, `filesystem.scope` of `home` or `paths`, or `network.any`; medium = `workspace` or named domains; low = none or no network). Its low, medium and high are shown green, yellow and red.
- **Slot reachability**: `bindings.resolveAll` accepts installed Harnesses only, so a new `bindings.resolveManifest({ harnessId, models })` runs P0-03's `resolveHarnessSlot` over a Store Manifest that need not be installed (Model Overrides count when there are any). "Not reachable" means the resolver found no Connection; Model Requirements stay advisory and are not checked here. Its input check mirrors the Manifest schema (a Recommended Model id of any length), and an id the resolver cannot use is skipped.
- **Markdown** (README and changelogs): rendered and sanitised in the renderer inside `ListingDetail`, so the Publish preview gets it too (its README images are dropped). `marked` (GitHub-flavoured, raw HTML dropped, never passed through; an inline `<script>`, `<style>`, `<iframe>` and the like is dropped with its content), then DOMPurify with an allow-list (headings, paragraphs, lists, quotes, code, emphasis, links, images, tables; attributes `href`, `src`, `alt`, `title`, `align`, `start`). Only absolute http(s) links survive, forced to `target="_blank" rel="noopener noreferrer"` and opened by the main window's `setWindowOpenHandler` through `shell.openExternal`; fragment, relative and `mailto:` links keep their text without a target (an `#anchor` would change the hash route). Images load only from the Store's asset bucket (rewritten to `store-asset:`) or as raster `data:image/(png|jpeg|gif|webp)`. `isAllowedExternalUrl` widens from https to http and https, since `homepage` and `sourceRepo` may be `http://`.
- **Primary button state machine** (a pure function evaluated on render, with the Library's judgement for installs):

  ```
  downloading                                  → progress + Cancel (whatever else is true)
  installed, platform not supported            → "Not available for your platform" (disabled)
  installed Store install, semver.lt(installed, latest)
                                               → "Update" (secondary: Launch)
  installed otherwise (equal or newer, Local, or no longer in the Store)
                                               → "Launch" (secondary: Uninstall)
  not installed, not in the Store              → "Removed from Store" (disabled)
  not installed, latest Manifest lacks this platform
                                               → "Not available for your platform" (disabled)
  not installed                                → "Install"
  ```

  For an installed Harness the platform check is the install's own (as the Library), otherwise the latest Manifest's `platforms`. An installed Harness that is taken down, Unpublished-only or unknown keeps a page built from its installed Manifest (with its changelog as the one history entry), shows Launch and "No longer available in the Store", and never Update (flows F4). A Harness that is not installed and not in the Store shows the not-found page, "This Harness is no longer available", with the disabled "Removed from Store". Install and Update render enabled and do nothing until P0-10 wires them; Uninstall is disabled until P0-10; the downloading state is reachable only through the component's props until then.
- **Launch on the detail page**: the Library's primary button and launch logic (Workspace sheet, `slot_unbound` → "Set up a model first", Starting…, Running…, Stopping…) moved into one shared `LaunchAction` with `useLaunch`, used by the Library and by the detail page's Launch and Update's secondary Launch, so the two cannot launch differently.
- **Library entry**: every Library card's menu has "View in Store" to `/store/h/<id>`, and the card's Publisher is a link to their page.
- **Publisher page** (P0-09.4): `store.publisher(login)` (lower-case as the Store keeps it, else `invalid_input`) makes api.md's Publisher page read; row-level security already limits the nested Harnesses to active ones with a published version, so the client adds no filter. It shows the avatar (monogram fallback), display name (else the login), `@login` linked to `https://github.com/<login>`, the join date from `created_at` (null when it does not parse), the bio as plain text, total downloads summed over the Harnesses listed, and those Harnesses as Store cards in the read's order under "Harnesses by <name>". A login without a profile shows "No such Publisher"; a profile with `harnesses: []` shows "No published Harnesses"; skeleton cards while loading and the inline error with Retry. Every Publisher name in the app links here: Store cards, the detail header (also on an installed Harness's page the Store no longer offers) and Library cards.
- **Report** is a disabled "Report" button in the detail footer, for P0-12 to wire.
- **Navigation**: Store routes are `/store` (home and search), `/store/h/<publisher>/<slug>` and `/store/p/<login>`, all under P0-04's Store gate; Store home → search → detail → Publisher → detail and back keeps the search through the provider above.
- **Copy**: all strings in `en` and `zh-CN`; permission sentences come from the shared module P0-05 introduced, also used by the consent dialog (P0-05, P0-10) and Publish preview (P0-08). The no-sandbox sentence and "Not available for your platform" reuse the existing copy; no new trust copy.
- **Dependencies**: `marked` and `dompurify` are desktop devDependencies, bundled like the app's other dependencies.

## Testing Decisions

- **Seams**: main seam tests for `store.home`, `store.search`, `store.detail` and `store.publisher` against a fake Store on a real HTTP port (the exact anonymous requests, exclusions, Featured order, card mapping, the home cache and Retry, paging, three versions newest first with changelogs and markers, statuses of hidden Harnesses, invalid Manifests, unparsable dates, avatar hosts, unreachable versus error answers, a body that stalls or resets), so the root `pnpm test` needs no Docker; a runtime-level test of `store.home`'s wiring and connectivity re-check; `bindings.resolveManifest` through the real Runtime; IPC input checks; `store-asset:` URL mapping. Renderer component tests in jsdom in en and zh-CN for the four pages, the button states as a table and on the page, the sanitiser against a hostile README, #72's red/yellow/green table against `permissionItems`, and a test that walks the Manifest schema and lists the omitted fields. Store seam tests (`test:store`, run by the CI store job) only for changed SQL and reads: the CJK substring search (a Chinese name substring alone and with its tag and platform, name/summary/README order, literal `%`, `_` and `\`; the old test expecting `写作` to find nothing now expects `bob/xiezuo`), the embedded platforms of the list reads and the changed detail and Version manifest reads.
- **Good tests** check what a User sees: searching part of a seeded Chinese name returns that Harness first; a Harness whose latest version lacks the test platform renders the disabled platform button and its greyed badge; a README containing a script tag renders without it or its code; an Unpublished-only or taken-down Harness appears in no list; a stale search answer or a composing input method never replaces the results; Back restores text, tags and toggle.
- **Fixtures**: the Store's seed script is unchanged (its test pins it); the platform-limited Harness and the hostile README are desktop test fixtures, and the store seam tests seed their own rows.
- **Not built here**: the desktop E2E journey (home → search → detail → Publisher → back with filters intact) is left to P0-13, which brings the desktop E2E harness; a jsdom journey test covers it until then.
- **Prior art**: P0-04 component test setup; P0-08's fake-Store HTTP pattern; P0-07 store-test harness.

## Out of Scope

- Download, verification, consent and install execution, Update and Uninstall (P0-10); this spec renders their states only.
- Ratings and reviews (P1-04).
- Report submission dialog (P0-12; this spec only places the disabled button).
- Any personalised recommendation.
- A result count (the RPC returns no total) and search by Publisher name (not in the search vector).
- Showing the last fetched lists while offline.
- Not built from the design demo: several windows per Harness, model picking inside the install dialog, desktop shortcuts, a simulated Dock.

## Further Notes

- The permission-severity mapping is a product decision; it lives in one shared function with tests so the detail page, consent dialog and Publish preview cannot disagree.
- Deviations from the tickets as written: the detail sections follow docs/ux (screenshots before the trust block, How it runs inside it); unsupported reads "Not available for your platform", not "Not available for <platform>"; Update has a secondary Launch; reachability is the resolver's answer and does not check Model Requirements, unlike #72's AC wording; Install and Update clicks are no-ops until P0-10; the Manifest's changelog is shown as the latest entry of the version history, not a separate block; the search box is in the Store's filter row rather than the header, with no `/store/search` route and state in a provider rather than the history entry; offline is the existing Store offline panel; only `store.home` is cached.
- The CJK substring match has no index; P0's catalogue is small.

## Blocked by

- P0-04 Desktop app shell, i18n and first-run wizard
- P0-07 Store backend (Supabase schema, auth, storage, edge functions)
