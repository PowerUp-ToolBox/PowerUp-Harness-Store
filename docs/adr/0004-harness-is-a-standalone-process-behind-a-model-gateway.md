---
status: accepted
date: 2026-09-19
supersedes: ADR-0001
---

# A Harness is a standalone process that launches as its own app and reaches models only through the Model Gateway

ADR-0001 chose declarative packages run by a first-party agent loop. On reflection the product owner wants each Harness to be a concrete, self-contained app (Steam / App Store model): authors control their own agent architecture, and each Harness opens in its own window. We therefore decided a Harness is an executable program packaged with a Manifest, launched and supervised by the Runtime. The platform's defining feature is the **Model Gateway**: a local service speaking one canonical protocol that every onboarded Harness must use for model access. Because the inbound protocol is fixed, any Harness runs on any Provider the User configures, and real credentials never enter a Harness process.

## Considered Options

- Declarative packages on a first-party runtime (ADR-0001). Rejected: constrains authors to one agent architecture and requires us to build a competitive agent loop.
- Both kinds in P0. Rejected for scope; a declarative "chat runtime" can later ship as an ordinary first-party Harness without changing the architecture.

## Consequences

- Installing a Harness is running third-party code. Declared Permissions inform the User but are not enforced in P0; this is stated plainly in the UI.
- The Runtime must provide language runtimes (at least Node) and per-platform packaging rules.
- The Store cannot technically force Gateway-only model access; it is a listing policy backed by automated checks and Reports, and by the fact that no credentials are ever handed to a Harness.
- The Gateway sits on the path of every token, which makes local usage accounting (P0), paid model credits and platform subscriptions (P2) straightforward.
