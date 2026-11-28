# Liftoff's test browser

A small private service that runs an app's purchase flow test in Chromium for Liftoff Cloud: sign up as a new user, buy Pro on Stripe Checkout with the 4242 test card, check Pro unlocks, wait while Liftoff Cloud cancels the subscription in Stripe, and check Pro locks again. It returns each step's result with a screenshot. How the cloud uses it, and why it's trusted with nothing, is in [cloud/README.md](../cloud/README.md#the-purchase-test).

```
server.mjs     the signed job API Liftoff Cloud calls (one test at a time)
purchase.mjs   the browser steps
guard.mjs      the proxy all of Chromium's traffic goes through: public addresses on ports 80 and 443 only
protocol.mjs   request signing and the step names, shared with Liftoff Cloud
Dockerfile     built from the repo root by render.yaml, on the Playwright image
```

It holds no keys and keeps nothing: jobs live in memory for 15 minutes. Settings: `LIFTOFF_PROOF_SECRET` (32+ characters, the same as Liftoff Cloud's) and `PORT` (10000).

```
npm ci
npm test    # needs Chromium for Playwright 1.63.0 (CI uses the Playwright image)
```

Playwright's version in `package.json` must match the image tag in `Dockerfile` and in the `proof` job of `.github/workflows/test.yml`.
