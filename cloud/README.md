# Liftoff Cloud

Liftoff as a web app. People sign in, bring their app (a GitHub repo or a zip), and get the same Mission Control the plugin shows. Then Claude runs the launch steps in a private cloud sandbox, using the plugin's own skills, while they watch, answer questions and approve anything risky from the browser.

```
Sign in with GitHub ─▶ Add an app ─▶ Mission Control ─▶ Run with Claude ─▶ Pull request
                     (repo or zip)   (scan, checklist,   (live activity,     (or a patch
                                      tasks, verify)      approvals)          for zips)
```

It lives next to the plugin and reuses it: the same detection, launch steps, readiness checklist, App Store pre-scan, leaked-key scan, `verify`, Pulse, next action and the Mission Control front end (`lib/` and `dashboard/` at the repo root). The plugin keeps working on its own.

## What it does

- **Add an app** from a GitHub link (public, or private once you sign in with GitHub), from a list of your repos, or by uploading a zip. The code is unpacked safely (no `../` paths, no links, size and file limits), read with the plugin's detection, and scanned: App Store pre-scan and leaked keys.
- **Mission Control** for every app: launch steps, your tasks, release readiness, deploys, Pulse and "do this next", plus where the code came from, what the scan found, and per-app settings.
- **Accounts** connected once per person and reused by every app. Keys are encrypted at rest (AES-256-GCM) and never sent back to the browser.
- **Verify and Pulse** run on the server against the live site and the connected services, through a fetch that refuses private and internal addresses.
- **Cloud runs with Claude.** Pick steps (or all that are left), add a note, start. Claude works in its own sandbox with a copy of the code and follows the plugin's skills. The run page shows what it's doing live; questions and approval requests appear as cards. GitHub apps get a branch and a draft pull request. Zips get a patch and an updated zip to download.

## How a run works

Runs use [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview): Anthropic runs the agent loop and a fresh sandbox per run, so people's code never runs on this server.

- **Code**: GitHub apps are mounted as a repository with the user's GitHub token, which also lets Claude push its branch. Zips are uploaded as a file.
- **Keys**: each person's connected accounts are copied into their own Anthropic vault as credentials limited to that service's API host (for example `STRIPE_SECRET_KEY` only for `api.stripe.com`). The sandbox sees placeholders; the real key is swapped in only on the way to that host. Signing keys (App Store Connect, Google Play) never enter the sandbox: Claude asks to copy them into GitHub Actions secrets, the server does it directly, and only after the user approves it in the browser.
- **Network**: the sandbox can reach package registries, GitHub and the connected services' APIs, nothing else. Web search and fetch are off.
- **Liftoff tools**: Claude reads the plan, skills and templates and records steps, tasks, checks, deploys and settings through tools this server carries out (`liftoff_plan`, `liftoff_step`, `liftoff_verify`, …), so Mission Control updates as it works and checks that need real keys run here. Checklist items the server can prove can only be ticked by `verify`.
- **Asking first**: Claude asks (`ask_user`) before anything that spends money, changes DNS, goes live, submits to a store or deletes something. Commands the sandbox's safety check is unsure about wait for an Allow or Decline.
- **Budget**: every run has a spending cap (`LIFTOFF_RUN_BUDGET_USD`, default $15). A run that reaches it pauses, and the user can add $10 and continue.
- **Restarts**: run state is saved after every event. After a restart the server picks each run up where it left off, handling each event once.

The agent's prompt and tools are in `lib/agent.mjs`. The server creates the agent and its environment on first start and updates them when that file changes (ids are kept in `<data>/agent.json`).

## Run it locally

```
cd cloud
npm install
npm run dev            # http://localhost:8787, with a one-click local sign-in
```

Open `http://localhost:8787` (not 127.0.0.1: the address must match `PUBLIC_URL`). Without `ANTHROPIC_API_KEY` everything works except cloud runs.

```
ANTHROPIC_API_KEY=sk-ant-... npm run dev      # cloud runs too
npm test                                      # 17 tests, no network needed
```

## Deploy on Render

`render.yaml` at the repo root is a Render blueprint: one web service with a 5 GB disk for data.

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
| `LIFTOFF_MAX_ACTIVE_RUNS` | Runs one person can have going at once (default 3). |
| `LIFTOFF_MAX_UPLOAD_MB`, `LIFTOFF_MAX_SOURCE_MB`, `LIFTOFF_MAX_SOURCE_FILES` | Limits for uploads and unpacked code (50 MB, 200 MB, 40,000 files). |
| `LIFTOFF_EXTRA_HOSTS` | More hosts the sandbox may reach, comma-separated. |

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
    store.mjs         file storage
    crypto.mjs, http.mjs, config.mjs
  public/             the web app's pages (Mission Control itself is ../dashboard)
  test/
```
