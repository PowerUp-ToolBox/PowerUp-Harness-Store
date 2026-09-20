---
spec_id: P2-02
title: Platform subscription
phase: P2
blocked_by: [P2-01]
requirements: [R-P2-02]
---

## Problem Statement

Credits (P2-01) let anyone run a Harness, but pay-as-you-go is anxious for Users and unpredictable for the platform. Users who rely on Harness Store daily want one monthly price that covers a reasonable amount of model use plus the conveniences of an account (sync, private Harnesses). The platform wants recurring revenue that funds vendor commitments and the Store's operation.

## Solution

Offer a **platform subscription** billed monthly or yearly through Stripe Billing. A subscription bundles: a monthly credit allowance (P2-01 credits, granted on each billing cycle), cloud sync (P2-03) and private Harnesses (P2-04). The app shows the plan, the remaining allowance for the cycle, and lets the User upgrade, downgrade, cancel or buy extra credits when the allowance runs out. Features gated by the subscription degrade gracefully when it lapses: sync pauses, private Harnesses stay installed but cannot be updated or newly downloaded, and model access falls back to purchased credits or the User's own Connections.

## User Stories

1. As a User, I want to see one or two clear plans with what is included, so that choosing is easy.
2. As a User, I want to subscribe with a card in the app and start using the allowance immediately, so that there is no waiting.
3. As a User, I want to see my remaining monthly allowance and the reset date, so that I can pace my usage.
4. As a User, I want the allowance to be consumed before any purchased credits, so that I do not burn paid credits while allowance remains.
5. As a User, I want to buy extra credits when my allowance runs out, so that a busy month does not stop me.
6. As a User, I want to cancel at any time and keep access until the end of the paid period, so that cancelling is safe.
7. As a User, I want to upgrade mid-cycle and have the difference prorated, so that upgrading is fair.
8. As a User, I want an email receipt and an invoice history, so that I can expense the subscription.
9. As a User, I want the app to tell me plainly what stops working if my payment fails, so that I am not surprised.
10. As a User, I want a grace period after a failed payment before features are restricted, so that an expired card does not immediately break my workflow.
11. As a User, I want my own Provider Connections to keep working regardless of subscription state, so that subscribing never takes away what P0 gave me.
12. As a User, I want yearly billing with a discount, so that I can save money if I commit.
13. As a User, I want to manage my payment method and billing details through a hosted portal, so that card changes are secure and easy.
14. As a Publisher, I want to know whether a private Harness feature requires a subscriber audience, so that I plan distribution accordingly.
15. As the maintainer, I want plan definitions (price, allowance, features) as data, so that launching a new plan is configuration.
16. As the maintainer, I want subscription state derived solely from Stripe webhooks, so that the app never invents entitlements.
17. As the maintainer, I want unused allowance to expire at cycle end (no rollover) in the first version, so that liabilities are bounded.
18. As a finance owner, I want tax handled by Stripe Tax, so that regional VAT/GST is not hand-built.

## Implementation Decisions

- **Billing:** Stripe Billing with Stripe Customer Portal for self-service and Stripe Tax enabled. Plans stored as data (`plans` table: id, Stripe price ids monthly/yearly, monthly credit allowance, feature flags `sync`, `private_harnesses`, `priority_support`).
- **Entitlement source of truth:** `subscriptions` table populated only from Stripe webhooks (`customer.subscription.*`, `invoice.*`). The desktop app reads entitlements from the Store; nothing is computed client-side beyond display.
- **Allowance mechanics:** on each successful invoice, a `grant` ledger entry (P2-01) with kind `allowance` and an expiry at the cycle end; debits consume allowance-kind credits first (oldest expiry first), then purchased credits. No rollover.
- **Lapse behaviour:** states `active`, `past_due` (grace period, decide length at implementation, default 7 days, features intact), `canceled` / `unpaid` (features gated). Gating: sync paused (local data intact), private Harness downloads/updates refused, allowance credits expired; purchased credits and own Connections unaffected.
- **Proration:** Stripe defaults (prorate on upgrade, credit on downgrade at cycle end).
- **In-app surfaces:** Settings → Plan (current plan, allowance meter, reset date, Manage billing → portal, Upgrade), first-run wizard gets a "Subscribe" option beside "Buy credits" and "Use my own keys".
- **ADR-0002 holds:** allowance is spent through the cloud Gateway on platform-owned commercial accounts.
- Two plans at launch (decide names and prices at implementation); no team plan in this spec.

## Testing Decisions

- Good tests replay Stripe webhook event sequences and assert entitlements and ledger state; UI tests assert what the User sees, not Stripe internals.
- **Store seam (architecture §8 seam 4):** with Stripe's test fixtures: subscribe → `active` + allowance grant; invoice paid next cycle → new grant, previous expired; payment failed → `past_due` with features intact; cancellation → access until period end then gated; upgrade → prorated invoice handled idempotently. Webhook idempotency on redelivery.
- **Gateway HTTP seam (seam 1):** debit ordering (allowance before purchased) verified through ledger rows after requests against the fake Provider.
- **Desktop E2E (seam 5):** plan page renders allowance and lapse messaging for each state via seeded accounts.
- Prior art: P1-01 Stripe webhook handling and P2-01 ledger tests.

## Out of Scope

- Team or organisation billing (seats); P2-04 introduces organisations but billing stays per User in this spec.
- Rollover of unused allowance, referral credits, coupons beyond Stripe's built-in promotion codes.
- Per-Harness subscriptions (explicitly deferred by the product owner in favour of one-time purchases, P1-01).
- Priority support tooling.

## Further Notes

- The product owner chose "User subscribes to the platform" over "User subscribes to a Harness" to avoid two competing subscription models; this spec keeps that boundary.

## Blocked by

- P2-01 Cloud Model Gateway and model credits
