---
spec_id: P1-01
title: Paid Harnesses (one-time purchase, Stripe Connect)
phase: P1
blocked_by: [P0-13]
requirements: [R-P1-01]
---

## Problem Statement

Publishers who put real work into a Harness have no way to be paid for it on the Store, so the best authors either keep their work private or distribute it elsewhere. Users who would happily pay for a polished tool cannot. The product decision (grill session) is to follow the App Store / Steam model: a Publisher sets a one-time price, the User buys once, and the platform keeps a commission. A Harness Package is plain files and therefore copyable; the decision is to **not** attempt copy protection, to be honest about that with Publishers, and to reserve room in the Manifest for encryption later.

## Solution

Publishers with a completed Stripe Connect Express account can mark a Harness as paid and set a price in USD. The Store detail page shows the price and a Buy button; purchase happens in Stripe Checkout in the system browser; on success the Store records a purchase and an entitlement for the signed-in User; the desktop app then allows the download. Stripe transfers the Publisher's share automatically with a platform commission (10% placeholder). Updates to a purchased Harness are free. Refunds follow a simple published policy handled by the platform.

## User Stories

1. As a Publisher, I want to connect a Stripe account from the Publish page, so that I can receive payouts.
2. As a Publisher, I want to be told clearly which countries Stripe Connect Express supports before I start, so that I do not waste time on onboarding that cannot complete.
3. As a Publisher, I want to set a one-time price for a Harness from a fixed price ladder, so that pricing is simple and consistent with the Store.
4. As a Publisher, I want to change the price for future purchases without affecting existing buyers, so that I can run promotions.
5. As a Publisher, I want to switch a Harness from paid to free (never the reverse for existing installers without a new Harness ID), so that I can open-source a project later.
6. As a Publisher, I want to see the platform commission and my net amount when setting a price, so that there are no surprises.
7. As a Publisher, I want a plain statement in the UI that paid packages are not copy-protected, so that I make an informed decision.
8. As a Publisher, I want a purchases summary (count, gross, net, refunds) on my Publisher page, so that I can track income.
9. As a User, I want to see the price before installing, so that I am never surprised by a paywall.
10. As a User, I want to buy with a card in Stripe Checkout in my browser, so that the desktop app never handles my card details.
11. As a User, I want to sign in with GitHub to buy, so that my purchase is tied to an identity I can recover.
12. As a User, I want the app to detect the completed purchase and unlock the download without me doing anything else, so that the flow feels seamless.
13. As a User, I want to reinstall a purchased Harness on another machine after signing in, so that a purchase is not tied to one device.
14. As a User, I want a "Purchases" list in Settings, so that I can see what I own.
15. As a User, I want updates to a Harness I bought to be free, so that buying does not feel like renting.
16. As a User, I want a receipt by email from Stripe, so that I have a record.
17. As a User, I want to request a refund within 14 days if the Harness does not work for me, so that buying is low risk.
18. As a User, I want a Harness that is taken down after purchase to remain launchable from my Library, so that I keep what I paid for.
19. As a Store administrator, I want to see purchases, refunds and disputes in an admin view, so that support requests can be handled.
20. As a Store administrator, I want a Takedown of a paid Harness to pause new sales immediately, so that a bad actor cannot keep collecting money.
21. As a Store administrator, I want the commission rate to be a configuration value with an effective date, so that changing it later does not require a code change.
22. As a platform developer, I want all money-related state to be driven by Stripe webhooks, never by client callbacks alone, so that entitlements cannot be forged.

## Implementation Decisions

- **Pricing**: one-time purchase only, USD, from a fixed ladder (decide the exact ladder at implementation; suggested $1.99–$99.99 tiers). Price stored per Harness with a history. Regional pricing, VAT handling beyond Stripe Tax, and discounts are not in scope.
- **Payments**: Stripe Checkout (hosted page) opened in the system browser via a deep link back to the app on completion. Stripe Connect **Express** accounts for Publishers; destination charges with an application fee equal to the commission. Commission placeholder **10%**, stored as configuration with an effective date.
- **Store tables** (reserved in `data-model.md`): `purchases` (id, user_id, harness_id, version_at_purchase, stripe_checkout_session_id, stripe_payment_intent_id, amount, currency, commission_amount, status: pending | paid | refunded | disputed, created_at), `entitlements` (user_id, harness_id, source: purchase | grant, created_at, revoked_at null; unique per user+harness), `payouts` (mirror of Stripe transfer/payout events for the Publisher summary), plus `harness_prices` (harness_id, amount, currency, effective_from). `profiles` gains `stripe_account_id` and `stripe_onboarding_complete`.
- **Entitlement check**: the `download` Edge Function requires a User JWT for paid Harnesses and verifies an active entitlement; free Harnesses remain anonymous. Local installs cache the entitlement so launching never requires network.
- **Webhooks**: `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`, `account.updated` drive all state. The client only polls its own purchases list after returning from Checkout.
- **Refunds**: platform-initiated via Stripe within 14 days on request, reversing the transfer; entitlement revoked on refund. Policy text is published in the Store.
- **Manifest**: reserve `distribution: { encrypted?: boolean }` (must be absent or `false` in P1; the Store rejects `true` with "not yet supported"). This is the only Manifest change.
- **Detail page states**: Buy $X · Purchased (Install) · Purchased (Installed) · Sales paused (taken down) · Sign in to buy.
- **Paid-to-free** allowed; **free-to-paid** allowed only for Harnesses with zero downloads (decide at implementation whether to relax this).
- Publisher onboarding, KYC and tax forms are entirely Stripe-hosted; the app only shows status.

## Testing Decisions

- Tests observe entitlements and download authorisation as external behaviour, driven by synthetic Stripe webhook events; never test Stripe's UI.
- Primary seam: **Store seam** (architecture §8, item 4): webhook handler and `download` function under Supabase local, with Stripe replaced by signed fixture events (Stripe CLI fixtures acceptable in CI).
- **Desktop E2E**: Buy button → deep-link return → download unlocked, with the Checkout step short-circuited by a test hook that injects the webhook.
- Prior art: P0-07 Edge Function tests and P0-10 install tests.

## Out of Scope

- Per-Harness subscriptions, bundles, trials, promo codes.
- Copy protection or encrypted packages (flag reserved only).
- Platform subscription and model credits (P2-01, P2-02).
- Seller-side tax advice; Stripe Tax configuration is an operational task.
- Ratings tied to purchases (P1-04 handles "verified installer").

## Further Notes

Legal prerequisites before launch: platform terms for sellers, refund policy page, and a Stripe platform account with Connect enabled. These are operational, not engineering, but P1-01 cannot ship without them.

## Blocked by

- P0-13 End-to-end acceptance, CI and unsigned builds
