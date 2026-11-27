---
name: money-path-test
description: Prove payments work end to end with an automated test that signs up, buys Pro with a test card, checks Pro unlocks, cancels and checks it locks again (Playwright on web, Maestro on mobile). Used by the purchase flow test step and by go-live.
---

# Purchase flow test

A broken checkout or a webhook that never updates the plan is the most common silent launch failure. This step proves the whole money path works.

## Web (Playwright)
1. `liftoff scaffold money-test` writes `e2e/liftoff-money-path.spec.ts` and `playwright.liftoff.config.ts`.
2. Add the test ids it expects to the app: `signup-email`, `signup-password`, `signup-submit`, `upgrade-button`, and `pro-active` on something only Pro users see. If sign-up isn't on `/`, change the first `goto`. If the app uses a pricing page before Checkout, add the click.
3. Install Playwright if missing (`<pm> add -D @playwright/test`, then `npx playwright install chromium`).
4. Run it against a **preview deploy with Stripe test keys**: `liftoff exec --only stripe -- env LIFTOFF_BASE_URL=<preview url> npx playwright test -c playwright.liftoff.config.ts`. Never against production with live keys.
5. If it fails, the trace (`npx playwright show-trace`) usually shows which part broke: Checkout never opened (route error), Pro never unlocked (webhook URL, signature secret, or the plan isn't read server-side), or Pro never locked (subscription.deleted not handled).
6. Add it to CI on pull requests against the preview URL (Vercel exposes it to GitHub Actions through the deployment status event), with `STRIPE_SECRET_KEY` (test) as a CI secret.

## Mobile (Maestro)
1. `liftoff scaffold money-test-mobile` writes `.maestro/liftoff-money-path.yaml`. Set `appId`, add the testIDs, and on iOS attach a StoreKit configuration file to the scheme so purchases run locally.
2. Run `maestro test .maestro/liftoff-money-path.yaml` on a simulator. It also covers Restore Purchases.

Record: `liftoff step money-test done --note "<web|mobile> passing"`, tick `pay-e2e`, and `pay-restore` when the mobile flow passes. Don't tick on a skipped run.
