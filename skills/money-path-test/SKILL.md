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
4. Run it against a **preview deploy with Stripe test keys**: `liftoff exec --only stripe -- env LIFTOFF_BASE_URL=<preview url> npx playwright test -c playwright.liftoff.config.ts`. Never against production with live keys. If that URL isn't the live URL, save it with `liftoff set preview.url <preview url>` so verify can tell the purchase belongs to this app.
5. If it fails, the trace (`npx playwright show-trace`) usually shows which part broke: Checkout never opened (route error), Pro never unlocked (webhook URL, signature secret, or the plan isn't read server-side), or Pro never locked (subscription.deleted not handled).
6. Add it to CI on pull requests against the preview URL (Vercel exposes it to GitHub Actions through the deployment status event), with `STRIPE_SECRET_KEY` (test) as a CI secret.

## Mobile (Maestro)
1. `liftoff scaffold money-test-mobile` writes `.maestro/liftoff-money-path.yaml`. Set `appId`, add the testIDs, and on iOS attach a StoreKit configuration file to the scheme so purchases run locally.
2. Run `maestro test .maestro/liftoff-money-path.yaml` on a simulator. It also covers Restore Purchases.

## Prove it

The test's own report isn't the proof. For web apps that pay through Stripe, Liftoff proves the purchase flow from Stripe's records, and `liftoff check pay-e2e` refuses a hand tick.

- **Web with Stripe:** after the test passes, run `liftoff verify --only pay-e2e`. It looks in Stripe test mode for a paid Checkout on this app (the live URL, a web deploy or `preview.url`) from the last 30 days, checks the app's webhook accepted `checkout.session.completed`, that the subscription was then cancelled, and that the webhook accepted `customer.subscription.deleted`. When it fails, its message says which part is missing; fix that and run the test again.
- **Mobile, Paddle or Lemon Squeezy:** Liftoff can't check these from Stripe yet. Tick `pay-e2e`, and `pay-restore` for the mobile flow, only after the run passes. Never tick on a skipped run.

Record the step with `liftoff step money-test done --note "<web|mobile> test in place, <proven|waiting for first run>"`. The step is building the test; the checklist item is the proof.

**In Liftoff Cloud** Liftoff runs the test itself, in its own browser on its own server (the sandbox can't open the preview site or Stripe Checkout). Add the test ids (step 2) and push. Once a preview with Stripe test keys is deployed from that branch, save it with `liftoff_set preview.url <preview url>`, and `liftoff_set signup.path <path>` if sign-up isn't on `/`. Then call `liftoff_prove_purchase`: it signs up a new test user, pays with the 4242 card, checks Pro unlocks, cancels in Stripe, checks Pro locks again, and ticks `pay-e2e` from Stripe's records for that checkout. If a step fails, it says which one and why (the Flight Board has a screenshot of each step); fix it, deploy the preview again and rerun. If there's no preview you can reach yet, add a task for the user: "Deploy a preview with Stripe test keys, then press Run the purchase test on the Flight Board". The CI test (step 6) is still worth adding so later changes can't break checkout; give CI the test key with `github_set_secret`.
