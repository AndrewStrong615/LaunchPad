---
name: payments
description: Add payments and a paywall to an app. Stripe Checkout + Billing Portal for web, RevenueCat for iOS/Android subscriptions. Used by the payments and paywall launch steps.
---

# Payments and paywall

Goal: a user can upgrade to the app's paid tier, the app knows they're paid, and they can manage or cancel. Stay in **test mode** until the user explicitly says go live.

## Decide the offer
From reading the app, propose the paid tier (name it "<App> Pro"), what it unlocks, and prices (default: monthly + yearly, yearly ≈ 2 months free). Confirm with the user in one line before creating products.

## Web (Stripe)
1. Install `stripe` (server) and, if the client needs it, `@stripe/stripe-js`.
2. Create the product and prices via the API, keys injected: `liftoff exec --only stripe -- node scripts/create-stripe-products.mjs` (write the script; idempotent by `lookup_key`). Or `liftoff exec --only stripe -- stripe products create ...` if the Stripe CLI exists.
3. Server routes:
   - `POST /api/checkout` → Checkout Session (`mode: 'subscription'`, `client_reference_id` = user id, success/cancel URLs).
   - `POST /api/portal` → Billing Portal session.
   - `POST /api/stripe/webhook` → verify with `stripe.webhooks.constructEvent` and the raw body; on `checkout.session.completed`, `customer.subscription.updated|deleted` update the user's `plan` in the database (Supabase table `subscriptions` if Supabase is used); on `invoice.payment_failed` send the failed-payment email if the email step is done.
   - Register the webhook endpoint in Stripe at the **deployed** URL (`<live url>/api/stripe/webhook`). Hosting runs before payments for this reason; for local work use `stripe listen --forward-to`. Record it: `liftoff record payments --resource stripe:webhook:<id>`.
4. Paywall UI: an upgrade screen listing Pro features with yearly preselected, plus a gate component/hook (`usePro()`) that reads the server-side entitlement. Never trust a client flag.
5. Put `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and price ids in the host's env vars, not the repo.

## iOS / Android (RevenueCat)
1. Expo/React Native: `react-native-purchases` (+ `react-native-purchases-ui` for a ready paywall). Flutter: `purchases_flutter`. Native: the RevenueCat SPM / Gradle package.
2. Configure at app start with the public SDK key per platform; call `logIn(userId)` after auth.
3. Entitlement `pro`; offering `default` with monthly + yearly packages. Products must also exist in App Store Connect / Play Console: add a **blocking task** for the user if you can't create them via API.
4. Paywall screen with Restore Purchases, gate with `customerInfo.entitlements.active.pro`.
5. Web part of a mobile app (if any) uses Stripe as above; RevenueCat can sync Stripe subscriptions.

## Record
- Each file you add or change: `liftoff record payments --file <path>`; each product/price: `liftoff record payments --resource stripe:price:<id>`.
- Check with `liftoff verify --only pay-products,pay-webhook` before marking done.
- `liftoff step payments done --provider stripe` / `liftoff step paywall done --provider revenuecat`
- Tick: `pay-sdk`, `pay-webhook`, `pay-entitlement`, `pay-portal`, `pay-restore` (mobile), `pay-products` (once products exist).
- Task (blocks release): "Switch payments to live keys" unless the user already went live. `/liftoff:go-live` does that switch.
- If `liftoff init` found Lemon Squeezy or Paddle (`payments:` in `liftoff status --json`), keep it: they are merchants of record that handle sales tax, and replacing them is the user's call.
