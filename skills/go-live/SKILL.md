---
name: go-live
description: Switch payments from test to live safely - live products and prices, live keys, live webhook, verify, and one real purchase and refund with the user's approval. Used by /liftoff:go-live.
---

# Go live

Going live is the riskiest moment of a launch. Do every step, in order, and stop at each money step for a yes.

## 0. Preconditions (stop if any fails)
- `liftoff verify` has no failures on `host-deploy`, `host-https`, `pay-webhook`, `sec-keys`, `sec-rls`.
- The purchase flow test (`pay-e2e`) passed in test mode.
- No open release-blocking tasks except "Switch payments to live keys" and store submission.
- Stripe account activated (`liftoff verify --only pay-live` tells you if charges/payouts are enabled once a live key exists). For mobile: the Paid Apps Agreement task is done.

## 1. Live key
Ask the user to create a **restricted** live key in Stripe with only what the app needs (Checkout, Customers, Subscriptions, Billing Portal, Webhook endpoints, Prices/Products read) and store it themselves:
`! node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs accounts connect stripe` (it replaces the test key; keep the test key in preview env vars).

## 2. Products, prices, portal
Run the idempotent product script from the payments step against live mode (`liftoff exec --only stripe -- node scripts/create-stripe-products.mjs`). Configure the live Billing Portal. Record `liftoff record payments --resource stripe:live-price:<id>` for each.

## 3. Webhook and env vars
Create the live webhook endpoint at the production URL with `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Put the live `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and price ids in the host's **production** env only, redeploy production. Mobile: switch RevenueCat to production keys and make sure the products are approved/attached.

## 4. Verify
`liftoff verify` again. All payment checks must pass.

## 5. One real purchase (ask first)
Ask: "Make one real purchase with your own card and refund it right away?" On yes, the user buys Pro on production; check Pro unlocks; refund it in Stripe (`refunds.create`) and cancel the subscription; check Pro locks. This is the only way to know live mode works end to end.

## 6. Record
`liftoff check pay-live` only after step 5 passes (or verify passes and the user declined the real purchase, noted in `--note`), mark the "Switch payments to live keys" task done, and `liftoff step payments done --note "live"`.

Never switch live keys into preview environments, and never delete test-mode data.
