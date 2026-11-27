# Liftoff

Liftoff is a Claude Code plugin that takes an app you've already built and gets it ready for real users: database, sign-in, payments, hosting, email, analytics, crash tracking, CI, beta builds and the store listing. Then it proves each piece works against the live services. A local **Flight Board** follows every app you've launched with it.

Run `/liftoff:launch` in your app. Claude reads the code, puts the slow paperwork on your list on day one, and works through the launch steps in dependency order. Halfway through, `liftoff status` for an Expo app looks like this:

```
Greenrow  (Expo · android, ios)
Launch steps ███████████████░░░░░ 12/16
  ✓ Database (Supabase) · row-level security on, nightly backups
  ✓ Sign-in (Supabase Auth) · Sign in with Apple, delete account
  ✓ Payments (Stripe) · test mode, webhook verified
  ✓ Paywall (RevenueCat) · Pro yearly + monthly, restore works
  …
  ✓ Crash tracking (Sentry) · dSYMs upload on release
  ✓ Purchase flow test (Maestro) · buy, unlock, cancel, relock
  ✓ TestFlight beta (EAS)
  ◐ Play test track
  ○ Review pre-check
  ○ Store listing · waits on store-checks, play-testing
Needs you (6 open, 5 blocking release):
  ! Sign the Paid Apps Agreement in App Store Connect (takes 1–3 days, start now)
  ! Start the 12-tester closed test on Google Play (takes 14 days, start now)
  …
Next: Start the slow paperwork now. ...
```

Claude does the work. It stops only for what a person has to do: create an account, pay a store fee, or say yes to anything that touches money, DNS or a store submission. Those become tasks, with release blockers on top.

Liftoff doesn't trust its own ticks: `liftoff verify` checks the live site, DNS, the Stripe webhook, Sentry, PostHog, CI, Supabase row-level security and the shipped code for leaked keys, and unticks anything that isn't true. For web apps on Stripe, the purchase flow test is proven from Stripe's own records (a paid test Checkout on the app, then a cancellation, with the app's webhook accepting both), so Claude can't tick it by hand. After launch, `/liftoff:pulse` pulls revenue, sign-ups, conversion, crashes and uptime from the accounts you already connected, and recommends one next action.

## Liftoff Cloud (web app)

The same thing in the browser: sign in with GitHub, add an app from a repo link or a zip, see it on the Flight Board, and let Claude run the launch steps in a private cloud sandbox while you watch, answer questions and approve anything risky. Changes come back as a draft pull request (or a patch for zips). Keys stay encrypted on the server; the sandbox only sees placeholders.

It lives in [`cloud/`](cloud/README.md) and reuses this plugin's code. `render.yaml` deploys it to Render.

## Install

```
/plugin marketplace add AndrewStrong615/liftoff
/plugin install liftoff@liftoff
```

Requires Node 18+. No npm dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `/liftoff:launch [steps]` | Reads the app and runs every launch step that isn't done yet (or just the ones you name). |
| `/liftoff:dashboard` | Opens the Flight Board at http://localhost:4810. |
| `/liftoff:status [all\|app]` | Progress for this app or all of them. |
| `/liftoff:connect [account]` | Connect a service account once. |
| `/liftoff:verify [checks]` | Check the launch against the real services, plus the App Store pre-scan. |
| `/liftoff:go-live` | Switch payments to live safely: checks, live products and webhook, one real purchase and refund with your yes. |
| `/liftoff:pulse` | Live numbers (MRR, subscribers, sign-ups, paywall conversion, crash-free, uptime) and the next action. |
| `/liftoff:undo <step>` | Show what a step changed, revert it with your approval, reset the step. |

## Launch steps

Picked per app from the platforms it ships to (web, iOS, Android), and run in dependency order (payments waits for sign-in and the deployed URL its webhook needs; the review pre-check waits for the privacy URL). `liftoff plan --explain` shows the order and what each step does. Each step has a skill in `skills/` that tells Claude exactly how to do it.

| Step | Skill | Provider |
| --- | --- | --- |
| Database | `database` | Supabase (or what the app already uses) |
| Sign-in | `auth` | Supabase Auth (or Clerk, Auth0, NextAuth, Firebase if present) |
| Deploy and domain | `hosting` | Vercel or Cloudflare (web apps) |
| Payments, Paywall | `payments` | Stripe (web), RevenueCat (iOS/Android); keeps Lemon Squeezy or Paddle |
| Email | `email` | Resend, with SPF and DKIM |
| Analytics | `analytics` | PostHog |
| Crash tracking | `crash-reports` | Sentry |
| CI/CD | `ci-cd` | GitHub Actions (+ EAS / fastlane for mobile) |
| Purchase flow test | `money-path-test` | Playwright (web), Maestro (mobile) |
| Uptime + alerts | `monitoring` | GitHub Actions uptime check, Sentry and Stripe alerts |
| Landing page | `landing-page` | Built into your app or a small static site |
| Growth basics | `growth` | Review prompt, feedback, activation event, launch kit |
| TestFlight beta, Play test track | `beta-builds` | App Store Connect, Google Play / Firebase App Distribution |
| Review pre-check | `store-readiness` | Rejection pre-scan (`liftoff scan`) and review checklist |
| Store listing | `store-submission` | fastlane deliver / supply; stops before Submit |

Also used on demand: `go-live` (by `/liftoff:go-live`) and `pricing-experiments` (when Pulse shows weak paywall conversion).

## Accounts

```
liftoff accounts                     # what's connected
liftoff accounts connect stripe      # prompts for the key, hidden
liftoff exec --only vercel -- vercel deploy --prod   # just the Vercel key in its environment
liftoff accounts migrate             # move keys from credentials.env into the OS keychain
```

Keys live in the OS keychain (macOS Keychain, or the Linux Secret Service via `secret-tool`) when one is available, otherwise in `~/.liftoff/credentials.env` (mode 600); never in your repo or the chat. Set `LIFTOFF_SECRET_STORE=file` or `keychain` to choose. `exec --only` injects only the named accounts' keys, so a command can't read keys it doesn't need. Keys belong to the machine, not to one app, so your next app starts with them already in place.

## Flight Board

`/liftoff:dashboard` (or `node bin/liftoff.mjs dashboard`) opens a local page on 127.0.0.1:4810. It has:

- **Overview**: how many apps are live, what's blocking a release, and a card per app with its launch steps and readiness.
- **Needs you**: every task waiting on a person, blockers on top. Add your own or tick them off here.
- **One page per app**: live URL, test builds, recent activity, and the accounts the app uses.
- **Release readiness**: around 50 checks across payments, hosting, analytics, builds, the landing page, App Store, Google Play and security. Some tick themselves from the code, and **Verify** re-checks them against the live services and says why anything failed.
- **Do this next**: one recommended action, with the number behind it.
- **Pulse**: MRR, subscribers, sign-ups, paywall conversion, crash-free sessions and uptime, refreshed when you ask.

## The CLI

Slash commands drive `bin/liftoff.mjs`; you can run it yourself too (`node bin/liftoff.mjs help`). State lives in `<your app>/.liftoff/state.json` (add `.liftoff/` to the app's `.gitignore` if you don't want it committed) and the list of apps in `~/.liftoff/projects.json`. Set `LIFTOFF_HOME` to move the shared folder.

## Settings that verify and Pulse read

```
liftoff set sentry.org acme          liftoff set posthog.project 12345
liftoff set sentry.project greenrow   liftoff set supabase.ref abcd1234
liftoff set preview.url https://greenrow-git-main-me.vercel.app   # where the purchase flow test runs
liftoff settings                     # all of them
```

The skills set these as they go. `liftoff costs` estimates monthly costs for the services an app uses (approximate list prices, with warnings such as Vercel Hobby not allowing commercial use).

## Develop

```
npm test
claude --plugin-dir .   # try the plugin locally
cd cloud && npm install && npm test && npm run dev   # the web app
```
