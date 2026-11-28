# Liftoff Cloud

Liftoff as a web app. People sign in, bring their app (a GitHub repo or a zip), and get the same Flight Board the plugin shows. Then Claude runs the launch steps in a private cloud sandbox, using the plugin's own skills, while they watch, answer questions and approve anything risky from the browser.

```
Sign in with GitHub ─▶ Add an app ─▶ Flight Board ─▶ Run with Claude ─▶ Pull request
                     (repo or zip)   (scan, checklist,   (live activity,     (or a patch
                                      tasks, verify)      approvals)          for zips)
```

It lives next to the plugin and reuses it: the same detection, launch steps, readiness checklist, App Store pre-scan, leaked-key scan, `verify`, Pulse, next action and the Flight Board front end (`lib/` and `dashboard/` at the repo root). The plugin keeps working on its own.

## What it does

- **Sign-in** (`/login`): GitHub (or the one-click local sign-in in development) on the left, a quiet picture of Liftoff at work on the right, which drops away on phones. "What Liftoff can see on GitHub" spells out the OAuth scopes in plain words.
- **The welcome tour** for a new account with no apps, in four steps: what Liftoff does; add an app (search your GitHub repos, paste a link or upload a zip) and see what the free scan found; connect the services that app uses (optional); and what's free versus the Launch Pass. It covers the whole window and opens by itself once. Finishing or skipping it saves `prefs.onboarded` on the account, and Account settings has *Start tour* to see it again.
- **Add an app** from a GitHub link (public, or private once you sign in with GitHub), from a list of your repos, or by uploading a zip. The code is unpacked safely (no `../` paths, no links, size and file limits), read with the plugin's detection, and scanned: App Store pre-scan and leaked keys.
- **The Flight Board** for every app: launch steps, your tasks, release readiness, deploys, Pulse and "do this next", plus where the code came from, what the scan found, and per-app settings. Each view is a browser history entry (`#<app>`, `#accounts`, `#!<view>`, and each step of the tour), so Back and Forward move around the app instead of leaving it.
- **An app that's already live**: *Already live?* on the Deployments card takes its address (`myapp.com` means `https://myapp.com`), so the free Verify checks hosting, HTTPS and the legal pages without a run. Pilot's deploys set it too. Saving it empty removes it.
- **Accounts**: each person adds a key once and all their apps use it. Keys are encrypted at rest (AES-256-GCM) and never sent back to the browser. A key that can't be right (a Stripe publishable key, text with spaces, a GitHub token without its prefix) is turned away in the dialog with what the right one looks like, instead of showing Connected.
- **Account settings** (your picture in the sidebar): profile from GitHub, Light, Dark or Match device (saved to the account and in the browser, so the page never flashes the wrong theme; the sun and moon button in the top bar switches it too), the mode your runs start in, connections, signing out here or on every other device, and deleting the account. Deleting removes the apps, imported code, run history and keys, deletes the person's Anthropic vault, and takes back Liftoff Cloud's GitHub access. It waits until no run is going. The anonymous run records stay (the dialog says so).
- **Verify and Pulse** run on the server against the live site and the connected services, through a fetch that refuses private and internal addresses.
- **Liftoff runs the purchase test itself** for web apps on Stripe: its own browser signs up on the app's test-mode preview, buys Pro with Stripe's test card, checks Pro unlocks, cancels, and checks Pro locks again, with a screenshot of each step. Stripe's records for that checkout decide the result (see [The purchase test](#the-purchase-test)).
- **Launch reports and the "Launch certified" badge**: a dated page anyone with the link can open, with every check, the evidence and a score, and a badge for the app's own site that links to it. It says "Launch certified" only when every required check ran on Liftoff's server and passed (see [Launch reports](#launch-reports-and-the-badge)).
- **The Launch Pass**: one payment per app, through Liftoff's own Stripe account, opens cloud runs (with tokens included), the purchase test and launch reports. Importing, the scan, verify, Pulse and the launch score stay free. The tour's last step shows the price. Off until a Stripe key is set (see [The Launch Pass](#the-launch-pass)).
- **Run records**: every cloud run leaves an anonymous record of the stack, how each step ended, the checklist before and after, the cost and the errors, so Liftoff can learn what works for which stack. Admins see success rates by stack, step, mode and model, and what a step really costs in dollars (see [Run records](#run-records)).
- **Cloud runs with Pilot.** Pick steps (or all that are left), pick a mode, add a note, start. Pilot works in its own sandbox with a copy of the code and follows the plugin's skills. The run page shows what it's doing live; questions and approval requests appear as cards. GitHub apps get a branch and a draft pull request. Zips get a patch and an updated zip to download.

## What people see: Pilot, modes and tokens

People never see model names or what runs cost in dollars. `lib/brand.mjs` and `MODELS` in `lib/agent.mjs` decide what they see instead:

- **Pilot**: the assistant goes by Liftoff's own name everywhere a person looks (the run thread, cards, buttons, the sign-in page, public reports). Set `LIFTOFF_ASSISTANT_NAME` to call it something else. Its prompt tells it the name, and to say plainly that it runs on Claude (made by Anthropic) if someone asks. Account settings says so in one line too, so no one is misled about what's underneath.
- **Modes, not models**: *Cruise* (Claude Sonnet 5.5, the default) and *Boost* (Claude Opus 5.5, "thinks harder, uses about twice the tokens"). The API only takes and returns mode ids (`cruise`, `boost`); model ids stay on the server. A finished run offers "Try again with Boost".
- **Tokens, not dollars**: Liftoff's own unit for what runs use. `LIFTOFF_TOKENS_PER_USD` (default 100) sets how many tokens make one dollar of model spend, so by default one token is one cent: the $15 run budget shows as 1,500 tokens, "add $10" as "Add 1,000 tokens", and the $50 on the Launch Pass as 5,000 tokens. Anthropic still gets dollars (in cents), and the Launch Pass price stays a real dollar charge on Stripe.
- **Admins** still see dollars and the real model ("Cruise · Claude Sonnet 5.5") on the run records page.

## How a run works

Runs use [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview): Anthropic runs the agent loop and a fresh sandbox per run, so people's code never runs on this server.

- **Model**: runs use Claude Sonnet 5.5 by default (shown as *Cruise*), which handles this setup and coding work well for about half the cost of Opus (*Boost*). Each person can make Boost their own default in Account settings and can pick either mode when they start a run. A finished or failed run offers "Try again with Boost" for the same steps. Both run at high effort. The choices are `MODELS` in `lib/agent.mjs`.
- **Code**: GitHub apps are mounted as a repository with the user's GitHub token, which also lets Claude push its branch. Zips are uploaded as a file.
- **Keys**: each person's connected accounts are copied into their own Anthropic vault as credentials limited to that service's API host (for example `STRIPE_SECRET_KEY` only for `api.stripe.com`). The sandbox sees placeholders; the real key is swapped in only on the way to that host. Signing keys (App Store Connect, Google Play) never enter the sandbox: Claude asks to copy them into GitHub Actions secrets, the server does it directly, and only after the user approves it in the browser.
- **Network**: the sandbox can reach package registries, GitHub and the connected services' APIs, nothing else. Web search and fetch are off.
- **Liftoff tools**: Claude reads the plan, skills and templates and records steps, tasks, checks, deploys and settings through tools this server carries out (`liftoff_plan`, `liftoff_step`, `liftoff_verify`, …), so the Flight Board updates as it works and checks that need real keys run here. Checklist items the server can prove can only be ticked by `verify`. That includes the purchase flow test for web apps on Stripe: the sandbox can't open Stripe Checkout, so Claude calls `liftoff_prove_purchase` and Liftoff's own browser runs it, or the test runs in the app's CI and `verify` finds it. Either way Stripe's records decide (a paid test Checkout on the app, then a cancellation, with the app's webhook accepting both).
- **Asking first**: Claude asks (`ask_user`) before anything that spends money, changes DNS, goes live, submits to a store or deletes something. Commands the sandbox's safety check is unsure about wait for an Allow or Decline.
- **Budget**: every run has a spending cap (`LIFTOFF_RUN_BUDGET_USD`, default $15, shown as 1,500 tokens). A run that reaches it pauses, and the user can add 1,000 tokens ($10) and continue. The run page shows what each run used, in tokens.
- **What runs cost** (rough, before real usage data): on Sonnet 5.5, about $0.50 to $2.50 for one step and $10 to $30 for a full launch; Opus 5.5 costs about twice that. Scans, the Flight Board, verify and Pulse don't use Claude. Once runs happen, the [run records](#run-records) page shows the real cost per run and per step.
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

## Launch reports and the badge

*Make the report* on the Flight Board runs every check again, then saves a snapshot of the app at `/r/<id>`, a link anyone can open without signing in.

- **Certified** when the app is a web app and every required check was proven by Liftoff (ticked by `verify` or the scan, not by hand) in the last 30 days. Required: the live deploy answers, HTTPS with http and www redirecting, `/privacy` and `/terms` load, no secret keys in the shipped code; for apps that sell through Stripe, the webhook rejects unsigned requests and the purchase test (or the app's CI) left a paid, cancelled checkout in Stripe; for Supabase apps, row-level security is on. A skipped check never counts as a pass. Other checks don't block, so a test-mode Stripe key (which `pay-live` fails) doesn't stop a certificate.
- **On the page**: what each proven check found and when, Liftoff's latest purchase test with its screenshots, then what didn't pass, what isn't proven yet, what was marked done by hand, and what's still open. Why a check failed is never shown (it could point at a weakness, like a leaked key's file or a table without RLS); the owner sees that on the Flight Board. Skip reasons stay private too. Security checks whose title alone points at a weakness (the `sec-*` checks, `pay-webhook`, `pay-entitlement`, `ci-secrets`) aren't named until Liftoff proves them or the team marks them done: the page says "3 security checks" instead. This applies as the page is drawn, so older reports follow it too, and the report card on the Flight Board says so.
- **Launch score**: proven items count fully, hand-ticked items half, out of every checklist item. It is separate from the Flight Board's release readiness, which counts every tick the same.
- **The badge**: `/b/<id>.svg` shows the newest report, "launch certified" with its date or a plain "launch report" that claims nothing, and `/b/<id>` sends visitors to that report. Visits are counted once per visitor every 10 minutes, without crawlers. The card has the code to paste into the site.
- **Taking a report down** stops its link; the badge falls back to the report before it. The last 20 reports are kept. Removing the app or the account takes every link down.

Report pages, screenshots and badges are served with a 5 minute public cache and `noindex`. Shared links are random ids (`rp_…`, `bd_…`) kept in `<data>/public/`, each pointing at the app that owns it; the content lives with the app in `apps/<slug>/reports/`.

## The Launch Pass

Liftoff Cloud charges once per app for the parts that cost money to run or that only Liftoff can grant. Billing is off (everything free) until `LIFTOFF_STRIPE_SECRET_KEY` is set.

| Free | With the Launch Pass |
| --- | --- |
| Import from GitHub or a zip, the App Store pre-scan and leaked keys, verify, Pulse, the Flight Board, the launch score and the top problems found | Cloud runs with Pilot, with `LIFTOFF_PASS_CLAUDE_USD` of Claude time included (default $50, shown as 5,000 tokens); Liftoff's purchase test; launch reports and the "Launch certified" badge |

- **Per app**: the card lists only what that app can use. The purchase test is listed for web apps that take payments through Stripe, and the "Launch certified" badge for web apps; an App Store or Google Play app is told those come later, before it pays. The Checkout description says the same. The tokens line says how far they go: each run asks before going past `LIFTOFF_RUN_BUDGET_USD` (1,500 tokens by default), so 5,000 is at least 3 runs.
- **Buying**: the Launch Pass card on the app's page (or the button that replaces *Start the launch*) opens Stripe Checkout for `LIFTOFF_PASS_USD` (default $149; promotion codes are allowed). It's a one-time payment on Liftoff's own Stripe account, not the person's.
- **Granting**: when the person comes back from Checkout, the server reads that session from Stripe and grants the pass if it's theirs and paid. Stripe's webhook (`POST /billing/stripe-webhook`, signature checked with `LIFTOFF_STRIPE_WEBHOOK_SECRET`) grants it too, for when the tab was closed or the payment cleared later. Each checkout counts once.
- **Tokens on the pass**: a run's budget is the usual per-run budget or what's left on the pass, whichever is less, and raising a paused run's budget stops at what's left. Open runs count at their budget, so two runs can't overspend (the pass card shows that part as "held for the run going now"). When it's used up, buying another pass adds the same amount again. Removing an app keeps what its runs cost counted against its pass, so importing it again doesn't reset it.
- **Free accounts**: GitHub logins in `LIFTOFF_FREE_LOGINS` get every pass free (for the team and testers).
- **Records**: passes live in `users/<uid>/billing.json` and go when the account is deleted. Every checkout and payment is also appended to `<data>/billing/log.jsonl` (user id, app, Stripe session, amount; no names or emails) for the books and the free-scan-to-pass numbers.

To turn it on: in Stripe (test mode first), copy the secret key into `LIFTOFF_STRIPE_SECRET_KEY`; add a webhook endpoint at `https://<service>/billing/stripe-webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded` and copy its signing secret into `LIFTOFF_STRIPE_WEBHOOK_SECRET`. In test mode the card says so and Checkout takes the 4242 card. A refund in Stripe doesn't take the pass back yet.

## Run records

Every cloud run leaves a record in `<data>/records/runs/<run id>.json`. It's written when the run starts and brought up to date each time the run stops working (finished, stopped, failed or paused at its budget, again if it's picked up later). This is what Phase 3 of the roadmap learns from: which stacks and steps go well, why steps get stuck, and what a launch really costs.

- **In a record**: the stack the scan detected (framework, platforms, sign-in, payments, package manager, integrations, GitHub or zip), which accounts were connected (ids only), the model, the steps asked for, each step's status before and after with the provider used and, if it got blocked, why; every checklist item before and after (proven, failed, ticked or open) and which checks still fail with the reason; the cost, budget and minutes; whether a pull request was opened; the errors the run hit; and counts of tool calls, questions and approvals.
- **Not in a record**: the person, the app's name, the repo, code, keys, the note, the chat or Claude's messages. The app is a keyed hash (`a_…`), so one app's runs group together but can't be traced back once the account is gone. Error texts and blocked reasons have links, hosts, IP addresses, emails, key-like strings and the app's own names (app, repo, owner, login) taken out, and are cut to 240 characters.
- **Deleting** an app or an account leaves its records.
- **Reading them**: GitHub logins in `LIFTOFF_ADMIN_LOGINS` get a *Run records* card in Account settings. It opens a page with runs, the share that finished, cost per run and per step done, then tables by stack, by step (tried, done, blocked, success rate, the usual provider, why it got stuck) and by model, the checks that fail most after a run, the errors runs hit most, and the latest runs. *Download all* gives every record as JSON lines (`GET /api/records/export`). Anyone else gets a 404 from `/api/records`.

The page reads every record on each visit, which is fine for thousands of runs on one disk; Phase 2's database is where they move after that.

## Run it locally

```
cd cloud
npm install
npm run dev            # http://localhost:8787, with a one-click local sign-in
```

Open `http://localhost:8787` (not 127.0.0.1: the address must match `PUBLIC_URL`). Without `ANTHROPIC_API_KEY` everything works except cloud runs.

```
ANTHROPIC_API_KEY=sk-ant-... npm run dev      # cloud runs too
npm test                                      # 46 tests, no network needed
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
| `LIFTOFF_RUN_BUDGET_USD` | Spending cap per run, in dollars of model spend (default 15). |
| `LIFTOFF_RUN_MODEL` | The mode runs use when the person doesn't pick one: `cruise` (default) or `boost` (a model id like `claude-opus-5-5` works too). |
| `LIFTOFF_ASSISTANT_NAME` | What people call the assistant (default `Pilot`). Letters, digits, spaces and `.'-`, up to 24 characters. |
| `LIFTOFF_TOKENS_PER_USD` | Tokens shown for each dollar of model spend (default 100, so one token is one cent). |
| `LIFTOFF_MAX_ACTIVE_RUNS` | Runs one person can have going at once (default 3). |
| `LIFTOFF_MAX_UPLOAD_MB`, `LIFTOFF_MAX_SOURCE_MB`, `LIFTOFF_MAX_SOURCE_FILES` | Limits for uploads and unpacked code (50 MB, 200 MB, 40,000 files). |
| `LIFTOFF_EXTRA_HOSTS` | More hosts the sandbox may reach, comma-separated. |
| `LIFTOFF_PROOF_URL` | Where Liftoff's test browser listens (`host:port` on Render's private network). Unset turns the purchase test off. |
| `LIFTOFF_PROOF_SECRET` | 32+ random characters, the same on the test browser. Signs every request to it. |
| `LIFTOFF_STRIPE_SECRET_KEY` | Liftoff's own Stripe secret key, for selling the Launch Pass. Unset turns billing off and everything is free. |
| `LIFTOFF_STRIPE_WEBHOOK_SECRET` | The signing secret of the Stripe webhook at `/billing/stripe-webhook`. |
| `LIFTOFF_PASS_USD` | The Launch Pass price in US dollars (default 149). |
| `LIFTOFF_PASS_CLAUDE_USD` | Claude time included with each pass, in US dollars of model spend (default 50, shown as 5,000 tokens). |
| `LIFTOFF_FREE_LOGINS` | GitHub logins that get every pass free, comma-separated. |
| `LIFTOFF_ADMIN_LOGINS` | GitHub logins that can see the run records, comma-separated. If an admin renames their GitHub account, update this. |

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
    tools.mjs         the Liftoff tools the assistant calls, carried out here
    agent.mjs         the agent's prompt, tools, modes and sandbox network
    brand.mjs         what people see: the assistant's name and tokens
    provision.mjs     creates/updates the agent and environment
    importer.mjs      GitHub and zip import, scans
    accounts.mjs      per-user accounts and the Anthropic vault
    archive.mjs       safe tar.gz/zip unpacking and zipping
    github.mjs        OAuth, repos, tarballs, pull requests, Actions secrets
    safe-fetch.mjs    fetch that refuses private addresses (verify, Pulse)
    proof.mjs         the purchase test: queue, Stripe cancel, screenshots, result
    report.mjs        launch reports: certification, the public page, the badge
    billing.mjs       the Launch Pass: Stripe Checkout, webhook, tokens
    records.mjs       run records: one per run, scrubbed, and the admin numbers
    store.mjs         file storage
    crypto.mjs, http.mjs, config.mjs
  public/             the web app's pages (the Flight Board itself is ../dashboard)
  test/
proof/                Liftoff's test browser, a separate private service (see proof/README.md)
```
