# Roadmap and Build Order

Each row is one spec, published as a GitHub issue with the same ID. "Blocked by" lists the specs that must be complete before this one can start. Vocabulary follows `CONTEXT.md`.

## Phase P0 — Core (milestone "P0 — Core")

| ID | Spec | Blocked by | Delivers |
|---|---|---|---|
| P0-01 | Monorepo scaffold and Manifest package | — | Repository layout, shared tooling, Manifest schema and validators used by every later spec |
| P0-02 | Model Gateway core | P0-01 | Local OpenAI-compatible Gateway with Slot resolution, Gateway Tokens, Provider adapters, Usage Records |
| P0-03 | Provider Connections and Slot Bindings | P0-01, P0-02 | Stored Connections, presets, local detection, model listing, Default Models and Model Overrides, Models page |
| P0-04 | Desktop app shell, i18n and first-run wizard | P0-01 | Electron + React shell, navigation, en/zh-CN, first-run flow |
| P0-05 | Runtime: install from folder, launch and supervise Harnesses | P0-01, P0-02, P0-04 | Local install, launch with injected environment, web and terminal windows, lifecycle, Data Directory, Workspace |
| P0-06 | Harness SDK and reference Harnesses | P0-02, P0-05 | Node SDK and two reference Harnesses used by tests and as first listings |
| P0-07 | Store backend | P0-01 | Supabase schema, RLS, GitHub OAuth, storage buckets, publish/download/report functions |
| P0-08 | Publish flow | P0-04, P0-07 | In-app publish from a folder, validation problems, metadata form, Unpublish |
| P0-09 | Store browsing and discovery | P0-04, P0-07 | Store home, search, tags, detail page, Publisher page, Featured |
| P0-10 | Install, update and uninstall from the Store (Library) | P0-05, P0-09 | Download with integrity check, consent, Library, update prompts with re-consent, uninstall |
| P0-11 | Usage page and Settings | P0-02, P0-03, P0-04 | Usage Records view, language, detection, data location |
| P0-12 | Report and Takedown | P0-07, P0-09 | Report button, administrator Takedown, hidden listings |
| P0-13 | End-to-end acceptance, CI and unsigned builds | all P0 | Playwright journeys, CI matrix, unsigned installers for three platforms, 10-minute path verified |

## Phase P0.5 — Python and GitHub import (milestone "P0.5 — Python & GitHub import")

| ID | Spec | Blocked by | Delivers |
|---|---|---|---|
| P0.5-01 | Python Harness runtime | P0-05, P0-10 | Bundled `uv`, Python Manifest kind, dependency install UX |
| P0.5-02 | Python SDK | P0-06, P0.5-01 | Python equivalent of the Node SDK |
| P0.5-03 | GitHub import for publishing | P0-08 | Publish from `owner/repo@tag` through the normal path |

## Phase P1 — Paid Harnesses and store maturity (milestone "P1 — Paid harnesses")

| ID | Spec | Blocked by | Delivers |
|---|---|---|---|
| P1-01 | Paid Harnesses (one-time purchase, Stripe Connect) | P0-13 | Pricing, Publisher payouts, checkout, entitlements at install |
| P1-02 | Beta Channel | P0-10 | `beta` Channel publishing and per-Harness opt-in |
| P1-03 | Anthropic Messages inbound compatibility | P0-02 | Second inbound protocol on the Gateway |
| P1-04 | Ratings and reviews | P1-01 | Verified-install ratings, reviews, abuse controls |
| P1-05 | Publisher analytics and admin dashboard | P0-13 | Download trends per Harness, Store-wide admin view, Reports queue |
| P1-06 | Opt-in telemetry | P0-13 | Anonymous, opt-in client events |
| P1-07 | Publish-time automated scanning | P0-08 | Credential-pattern and vendor-domain checks that flag for review |
| P1-08 | Background Harnesses | P0-05 | Harnesses that run without a window |
| P1-09 | GitHub webhook auto-publish | P0.5-03 | Tag push publishes a new Harness Version |

## Phase P2 — Platform subscription (milestone "P2 — Platform subscription")

| ID | Spec | Blocked by | Delivers |
|---|---|---|---|
| P2-01 | Cloud Model Gateway and model credits | P1-01, P1-06 | Hosted Gateway, credit ledger, metering |
| P2-02 | Platform subscription | P2-01 | Monthly plan with bundled credits and premium features |
| P2-03 | Accounts for all Users and cloud sync | P2-02 | Sign-in for everyone, Library and settings sync |
| P2-04 | Private Harnesses | P2-03 | Unlisted, access-controlled Harnesses for teams |

## External prerequisites

| Item | Needed by | Status |
|---|---|---|
| Supabase project (Auth with GitHub OAuth app, Postgres, Storage) | P0-07 | To be created |
| GitHub OAuth application for the Store | P0-07 | To be created |
| Apple Developer signing and notarisation; Windows code signing | Public distribution, after P0-13 | Deferred by decision; account exists |
| Stripe account with Connect Express enabled | P1-01 | Not started |
| Cloud hosting for the hosted Gateway and billing services | P2-01 | Not started |

## Sequencing notes

- P0-01 is a prefactor: it exists so every later spec lands in a shared structure. Nothing else starts before it.
- P0-02, P0-04 and P0-07 are independent after P0-01 and can proceed in parallel.
- P0-06 exists early so P0-10 and P0-13 have real Harnesses to install and launch.
- P0-13 is the acceptance gate; no P0.5 or P1 work is considered started until it is green.
