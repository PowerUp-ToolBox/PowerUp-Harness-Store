---
spec_id: P2-01
title: Cloud Model Gateway and model credits
phase: P2
blocked_by: [P0-02, P1-01]
requirements: [R-P2-01]
---

## Problem Statement

P0 serves technical Users who bring their own Provider accounts. Everyone else hits a wall on the first-run wizard: no API key, no Ollama, no way to run anything. Publishers also lose potential Users who would happily pay a little to try a Harness without signing up with three model vendors. Meanwhile the local Model Gateway already sits on the path of every token, so the platform knows exactly how to meter usage, but only on the User's machine.

## Solution

Run the Model Gateway as a hosted service. A signed-in User buys or is granted **credits**; the desktop app shows the cloud Gateway as one more Provider (`harness-store-cloud`) that any Model Slot can be bound to. The local Gateway forwards requests for that Provider to the cloud Gateway with the User's session, the cloud Gateway forwards to the vendor with platform-owned keys, meters tokens, converts them to credits at published rates, and debits the ledger. Harnesses are unaware: they still speak the same protocol to `127.0.0.1`. Consumer subscriptions (Claude Pro, ChatGPT Plus) are still not used (ADR-0002); the cloud Gateway uses commercial API accounts owned by the platform.

## User Stories

1. As a User without any Provider account, I want to complete first run by choosing "Use Harness Store credits", so that I can run a Harness within minutes.
2. As a User, I want to see the cloud Gateway as a Provider in the Models page with a list of offered models, so that I bind Slots to it like any other Provider.
3. As a User, I want my credit balance visible in the app and before each purchase, so that I am never surprised by a zero balance mid-task.
4. As a User, I want a clear price per model (credits per million input and output tokens) before binding, so that I can choose cheaper models for cheap Slots.
5. As a User, I want to buy credit packs with a card, so that topping up is a one-minute action.
6. As a User, I want a low-balance warning and a hard stop at zero with a helpful `provider_error` message, so that I understand why a Harness stopped.
7. As a User, I want per-Harness credit spend visible on the Usage page alongside local token counts, so that I know which Harness costs what.
8. As a User, I want to keep using my own Provider Connections for some Slots and credits for others, so that I mix and match.
9. As a User, I want the same streaming, tool calling and image support through the cloud Gateway as locally, so that Harnesses behave identically.
10. As a User, I want my prompts and completions not to be stored by the cloud Gateway beyond transient processing, so that using credits does not mean handing over my conversations.
11. As a User in a region where some vendors are unreachable, I want the cloud Gateway to offer models from vendors reachable to the platform, so that geography does not lock me out.
12. As a Publisher, I want to recommend `harness-store-cloud/<model>` in Recommended Models, so that Users without accounts get a working default.
13. As a Publisher, I want to grant a small trial credit to first-time installers of my Harness (funded by me or the platform, decide later), so that trying my Harness is frictionless.
14. As the maintainer, I want an immutable credit ledger with every debit tied to a request id, so that disputes and reconciliation are possible.
15. As the maintainer, I want per-User rate limits and concurrency limits on the cloud Gateway, so that one User cannot exhaust shared vendor quotas.
16. As the maintainer, I want the vendor-facing keys never to leave the cloud Gateway, so that a compromised client cannot use them.
17. As the maintainer, I want the price table to be data with an effective date, so that vendor price changes are a config change.
18. As the maintainer, I want the cloud Gateway to be the same code as the local Gateway with a different Provider configuration and an added billing hook, so that protocol behaviour cannot drift.
19. As a finance owner, I want credits to be non-refundable except by policy and to have an expiry, so that liabilities are bounded.

## Implementation Decisions

- **Same code, hosted:** the `packages/gateway` server runs server-side behind authentication. Inbound protocol identical (`docs/tech/gateway-protocol.md`). Differences are configuration: Providers are platform-owned Connections; a **billing hook** runs after usage is known; tokens are User sessions rather than per-launch Gateway Tokens.
- **Local integration:** new Provider id `harness-store-cloud` in the preset table, credential = the User's session (from P2-03 accounts). The local Gateway treats it as an OpenAI-compatible Provider whose base URL is the cloud Gateway; Slot resolution and Usage Records unchanged. Model ids: `harness-store-cloud/<offered-model-id>`, where offered ids are the platform's own catalogue names (for example `claude-sonnet`, `gpt-5`, `deepseek-chat`) decoupled from vendor names so the platform can swap backends.
- **Metering:** vendor-reported token counts; when a vendor omits usage the request is charged by a conservative estimate and flagged (only case where estimation is allowed, because money is involved). Price table: credits per million input, output and cached-input tokens per offered model, with effective-from timestamps. 1 credit = a fixed fiat amount decided at implementation.
- **Ledger:** `credit_ledger` (User id, amount signed, kind `purchase` / `grant` / `debit` / `adjustment` / `expiry`, request id, offered model, tokens, created at), append-only; balance is a materialised sum. Debit is written after response completion; streaming requests reserve a small hold at start and settle at end. Insufficient balance → `402` with code `insufficient_credits` (a new error code documented alongside the P0 table).
- **Purchases:** Stripe Checkout for credit packs, reusing the Stripe account and webhook plumbing from P1-01. Credits expire after 12 months (decide at implementation; must be stated at purchase).
- **Privacy:** no prompt or completion storage; request logs keep ids, model, tokens, latency and error codes only. Stated in the security doc and in the app when enabling the Provider.
- **Limits:** per-User requests per minute and concurrent streams; per-model global concurrency to protect vendor quotas. Exceeding returns `429` with `rate_limited`.
- **ADR-0002 holds:** the cloud Gateway uses commercial API accounts; no consumer subscription credentials are involved.
- **Trial credits:** mechanism is a `grant` ledger entry; who funds Publisher-initiated grants is decided at implementation (default: platform-funded, capped).
- **Hosting:** decide at implementation (the Gateway is a plain Node HTTP server; any container host works). Ledger and catalogue live in the Store Postgres.

## Testing Decisions

- Good tests exercise the HTTP protocol and the ledger, never internal billing helpers.
- **Gateway HTTP seam (architecture §8 seam 1), hosted configuration:** run the Gateway with the billing hook against the fake Provider; assert identical responses to the local configuration (the P0 conformance suite must pass unchanged), correct ledger debits for streaming and non-streaming, holds settled or released, `insufficient_credits` at zero, `rate_limited` above limits.
- **Store seam (seam 4):** purchase webhook → ledger `purchase` row; balance materialisation; expiry job.
- **Local Gateway seam (seam 1):** a Slot bound to `harness-store-cloud` forwards to a fake cloud Gateway with the session credential and records a local Usage Record with the resolved model.
- **Desktop E2E (seam 5):** first run choosing credits → install `hello-web` → chat completes → Usage shows credit spend.
- Prior art: P0-02 conformance suite; P1-01 Stripe webhook tests.

## Out of Scope

- Subscription plans that include credits: P2-02.
- Accounts and sign-in for all Users: P2-03 (this spec depends on it in practice; the dependency graph lists P1-01 for the payment plumbing and P0-02 for the Gateway; implementation should schedule after P2-03 where possible).
- Selling model access to Harness authors for server-side use.
- Fine-tuning, embeddings or other non-chat endpoints.
- Consumer subscription passthrough (ADR-0002).

## Further Notes

- This spec realises the round-one option "sell model credits" that the product owner deferred behind paid Harnesses; the P0 decision to put the Gateway on every token path exists largely to make this spec cheap.
- Regulatory and tax handling of prepaid credits differs by jurisdiction; get advice before launch. Not a software decision.

## Blocked by

- P0-02 Model Gateway core
- P1-01 Paid Harnesses (one-time purchase, Stripe Connect)
