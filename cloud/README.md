# Liftoff Cloud

Liftoff as a web app. People sign in, bring their app (a GitHub repo or a zip), and get the same Flight Board the plugin shows. Then Claude runs the launch steps in a private cloud sandbox, using the plugin's own skills, while they watch, answer questions and approve anything risky from the browser.

```
Sign in with GitHub ─▶ Add an app ─▶ Flight Board ─▶ Run with Claude ─▶ Pull request
                     (repo or zip)   (scan, checklist,   (live activity,     (or a patch
                                      tasks, verify)      approvals)          for zips)
```

It lives next to the plugin and reuses it: the same detection, launch steps, readiness checklist, App Store pre-scan, leaked-key scan, `verify`, Pulse, next action and the Flight Board front end (`lib/` and `dashboard/` at the repo root). The plugin keeps working on its own.

## What it does

- **Add an app** from a GitHub link (public, or private once you sign in with GitHub), from a list of your repos, or by uploading a zip. The code is unpacked safely (no `../` paths, no links, size and file limits), read with the plugin's detection, and scanned: App Store pre-scan and leaked keys.
- **The Flight Board** for every app: launch steps, your tasks, release readiness, deploys, Pulse and "do this next", plus where the code came from, what the scan found, and per-app settings.
- **Accounts**: each person adds a key once and all their apps use it. Keys are encrypted at rest (AES-256-GCM) and never sent back to the browser.
- **Verify and Pulse** run on the server against the live site and the connected services, through a fetch that refuses private and internal addresses.
- **Liftoff runs the purchase test itself** for web apps on Stripe: its own browser signs up on the app's test-mode preview, buys Pro with Stripe's test card, checks Pro unlocks, cancels, and checks Pro locks again, with a screenshot of each step. Stripe's records for that checkout decide the result (see [The purchase test](#the-purchase-test)).
- **Cloud runs with Claude.** Pick steps (or all that are left), pick a model, add a note, start. Claude works in its own sandbox with a copy of the code and follows the plugin's skills. The run page shows what it's doing live; questions and approval requests appear as cards. GitHub apps get a branch and a draft pull request. Zips get a patch and an updated zip to download.

## How a run works

Runs use [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview): Anthropic runs the agent loop and a fresh sandbox per run, so people's code never runs on this server.

- **Model**: runs use Claude Sonnet 5.5 by default, which handles this setup and coding work well for about half the cost of Opus. People can pick Claude Opus 5.5 when they start a run, and a finished or failed run offers "Try again with Opus" for the same steps. Both run at high effort. The choices are `MODELS` in `lib/agent.mjs`.
- **Code**: GitHub apps are mounted as a repository with the user's GitHub token, which also lets Claude push its branch. Zips are uploaded as a file.
- **Keys**: each person's connected accounts are copied into their own Anthropic vault as credentials limited to that service's API host (for example `STRIPE_SECRET_KEY` only for `api.stripe.com`). The sandbox sees placeholders; the real key is swapped in only on the way to that host. Signing keys (App Store Connect, Google Play) never enter the sandbox: Claude asks to copy them into GitHub Actions secrets, the server does it directly, and only after the user approves it in the browser.
- **Network**: the sandbox can reach package registries, GitHub and the connected services' APIs, nothing else. Web search and fetch are off.
- **Liftoff tools**: Claude reads the plan, skills and templates and records steps, tasks, checks, deploys and settings through tools this server carries out (`liftoff_plan`, `liftoff_step`, `liftoff_verify`, …), so the Flight Board updates as it works and checks that need real keys run here. Checklist items the server can prove can only be ticked by `verify`. That includes the purchase flow test for web apps on Stripe: the sandbox can't open Stripe Checkout, so Claude calls `liftoff_prove_purchase` and Liftoff's own browser runs it, or the test runs in the app's CI and `verify` finds it. Either way Stripe's records decide (a paid test Checkout on the app, then a cancellation, with the app's webhook accepting both).
- **Asking first**: Claude asks (`ask_user`) before anything that spends money, changes DNS, goes live, submits to a store or deletes something. Commands the sandbox's safety check is unsure about wait for an Allow or Decline.
- **Budget**: every run has a spending cap (`LIFTOFF_RUN_BUDGET_USD`, default $15). A run that reaches it pauses, and the user can add $10 and continue. The run page shows what each run cost.
- **What runs cost** (rough, before real usage data): on Sonnet 5.5, about $0.50 to $2.50 for one step and $10 to $30 for a full launch; Opus 5.5 costs about twice that. Scans, the Flight Board, verify and Pulse don't use Claude.
- **Restarts**: run state is saved after every event. After a restart the server picks each run up where it left off, handling each event once.

The agent's prompt and tools are in `lib/agent.mjs`. The server creates the agent and its environment on first start and updates them when that file changes (ids are kept in `<data>/agent.json`).

## The purchase test

The purchase flow is the part of a launch that most often breaks without anyone noticing, so Liftoff runs it itself instead of taking Claude's word or the app's own test report.

1. **Start**: the person presses *Run the purchase test* on the Flight Board, or Claude calls `liftoff_prove_purchase`. It needs a web app on Stripe, a connected Stripe **test** key, and `preview.url` (a deploy that uses Stripe test keys; the live URL is used if there's none). It starts at `signup.path` (default `/`).
2. **Browse**: Liftoff's test browser (`../proof`, a private Render service with Chromium) signs up as `liftoff+<id>@example.com`, presses `upgrade-button`, pays on Stripe Checkout with the 4242 card, and reloads until `pro-active` appears. It refuses a live (`cs_live_`) Checkout before entering a card.
3. **Cancel**: this server cancels the subscription with the user's Stripe key, as the Billing Portal would, and the browser reloads until `pro-active` is gone. The test browser never holds a key.
4. **Decide**: `verify` checks Stripe's records for that one checkout: paid, cancelled, and the app's webhook accepted `checkout.session.completed` and `customer.subscription.deleted`. Only that ticks `pay-e2e`. A failure in the app's own flow (sign-up, Checkout, Pro unlocking or locking) unticks it; problems outside the app's code (a live Checkout, the browser crashing, Stripe refusing the cancel) are reported without changing it.

The Flight Board shows each step as it happens, then the result with a screenshot of each step (kept for the last 5 tests). Tests run one at a time; the rest wait their turn. The app needs the test ids the purchase flow test step adds (`signup-email`, `signup-password`, `signup-submit`, `upgrade-button`, `pro-active`). An app that asks new users to confirm their email first can't be tested this way yet.

The test browser is isolated on purpose, because it opens sites Liftoff doesn't control: its own small server with no disk, no public address and no keys. Every request the cloud sends it is signed with `LIFTOFF_PROOF_SECRET` (a timestamp, a one-time nonce and an HMAC over the method, path and body), and the cloud trusts only Stripe's records, not the browser's report, so even a compromised browser can't tick anything. All of Chromium's traffic goes through a proxy that allows only ports 80 and 443 on public addresses (checked on the address it connects to), so a page can't reach Render's private network, cloud metadata or anything local.

## Run it locally

```
cd cloud
npm install
npm run dev            # http://localhost:8787, with a one-click local sign-in
```

Open `http://localhost:8787` (not 127.0.0.1: the address must match `PUBLIC_URL`). Without `ANTHROPIC_API_KEY` everything works except cloud runs.

```
ANTHROPIC_API_KEY=sk-ant-... npm run dev      # cloud runs too
npm test                                      # 22 tests, no network needed
```

## Deploy on Render

`render.yaml` at the repo root is a Render blueprint: the web service with a 5 GB disk for data, and Liftoff's test browser as a private service (Docker, Starter, about $7 a month; Standard if tests run out of memory). The two share a generated `LIFTOFF_PROOF_SECRET`, and the web service finds the browser through `LIFTOFF_PROOF_URL`. Leave the browser out and everything works except the purchase test.

1. **GitHub OAuth app**: GitHub → Settings → Developer settings → OAuth Apps → New. Homepage `https://<service>.onrender.com`, callback `https://<service>.onrender.com/auth/github/callback`. Copy the client id and generate a secret.
2. **Render**: New → Blueprint → pick this repo. Fill in `ANTHROPIC_API_KEY`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. `LIFTOFF_CLOUD_SECRET` is generated for you; keep it, since changing it makes stored keys unreadable.
3. Deploy. On first start the server creates the Claude agent and sandbox environment and logs their ids. Open the service URL and sign in with GitHub.

The blueprint uses the Starter instance because Render disks need a paid instance. With a custom domain, set `PUBLIC_URL=https://your.domain` and update the OAuth callback.

## Settings

| Variable | What it does |
| --- | --- |
| `PUBLIC_URL` | The address people open. Defaults to Render's `RENDER_EXTERNAL_URL`, else `http://localhost:$PORT`. Cookies are `Secure` when it's https. |
| `PORT`, `HOST` | Where to listen (default `8787`, `0.0.0.0`). |
| `LIFTOFF_DATA_DIR` | Where users, apps, imported code and runs are stored (default `./data`). |
| `LIFTOFF_CLOUD_SECRET` | 32+ random characters. Encrypts stored keys and signs cookies. Required in production; generated into the data folder locally. |
| `ANTHROPIC_API_KEY` | Enables cloud runs. |
| `LIFTOFF_AGENT_ID`, `LIFTOFF_ENVIRONMENT_ID` | Use an agent and environment you manage yourself instead of the ones the server creates. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in (scopes `repo read:user`, to import private repos, push branches and open pull requests). |
| `LIFTOFF_DEV_LOGIN=1` | One-click local sign-in. Ignored when `NODE_ENV=production`. |
| `LIFTOFF_RUN_BUDGET_USD` | Spending cap per run (default 15). |
| `LIFTOFF_RUN_MODEL` | The model runs use when the person doesn't pick one: `claude-sonnet-5-5` (default) or `claude-opus-5-5`. |
| `LIFTOFF_MAX_ACTIVE_RUNS` | Runs one person can have going at once (default 3). |
| `LIFTOFF_MAX_UPLOAD_MB`, `LIFTOFF_MAX_SOURCE_MB`, `LIFTOFF_MAX_SOURCE_FILES` | Limits for uploads and unpacked code (50 MB, 200 MB, 40,000 files). |
| `LIFTOFF_EXTRA_HOSTS` | More hosts the sandbox may reach, comma-separated. |
| `LIFTOFF_PROOF_URL` | Where Liftoff's test browser listens (`host:port` on Render's private network). Unset turns the purchase test off. |
| `LIFTOFF_PROOF_SECRET` | 32+ random characters, the same on the test browser. Signs every request to it. |

## Security notes

- Sessions are random ids in an `HttpOnly`, `SameSite=Lax` cookie. Every write must come from the site's own origin, and pages send a strict Content-Security-Policy (no inline scripts, no framing).
- Keys are encrypted with a key derived from `LIFTOFF_CLOUD_SECRET` and only decrypted on the server for verify, Pulse, the vault and GitHub secrets. They're never in the browser, the prompt or the sandbox.
- Settings that end up in API URLs (PostHog host, Sentry org, …) are validated, so a key can never be sent to another host.
- Repository text, command output and web pages are treated as data by the agent, and Claude's Liftoff tools can only touch the app the run belongs to.
- Storage is plain files on one disk, sized for one instance. Run one instance; to scale out, move `lib/store.mjs` to a database first.

## Layout

```
cloud/
  server.mjs          start here
  setup.mjs           create/update the agent by hand (optional)
  lib/
    app.mjs           routes: sign-in, pages, JSON API
    runs.mjs          runs: sessions, event stream, approvals, questions
    tools.mjs         the Liftoff tools Claude calls, carried out here
    agent.mjs         the agent's prompt, tools and sandbox network
    provision.mjs     creates/updates the agent and environment
    importer.mjs      GitHub and zip import, scans
    accounts.mjs      per-user accounts and the Anthropic vault
    archive.mjs       safe tar.gz/zip unpacking and zipping
    github.mjs        OAuth, repos, tarballs, pull requests, Actions secrets
    safe-fetch.mjs    fetch that refuses private addresses (verify, Pulse)
    proof.mjs         the purchase test: queue, Stripe cancel, screenshots, result
    store.mjs         file storage
    crypto.mjs, http.mjs, config.mjs
  public/             the web app's pages (the Flight Board itself is ../dashboard)
  test/
proof/                Liftoff's test browser, a separate private service (see proof/README.md)
```
