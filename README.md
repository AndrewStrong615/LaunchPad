# Liftoff

A Claude Code plugin that launches your app from one command, then tracks every app you've launched in a local **Mission Control** dashboard.

```
> /liftoff:onboard
  ✓ Reading your app            Fernweh · Expo (iOS, Android, Web)
  ! Start now                   Apple Paid Apps Agreement (1–3 days), Play closed test (14 days)…
  ✓ Database + sign-in          Supabase, Sign in with Apple, account deletion
  ✓ Hosting + domain            Vercel (or Cloudflare)            verified: https, DNS, redirects
  ✓ Payments + paywall          Stripe on web, RevenueCat on mobile  verified: webhook rejects unsigned calls
  ✓ Email                       welcome, receipts, resets          verified: SPF + DKIM
  ✓ Analytics + crashes         PostHog + Sentry                   verified: events arriving
  ✓ CI/CD on GitHub             build → test → deploy to production
  ✓ Purchase flow test          buy → Pro unlocks → cancel → Pro locks
  ✓ Uptime + alerts             health check every 10 minutes
  ✓ Landing page + growth       email capture, review prompt, launch kit
  ✓ TestFlight build            Play testing build
  ✓ Store checks + listing      rejection pre-scan, listing uploaded, stops before Submit
  Ready for users ✓
  Next: Start the slow paperwork now. "Sign the Paid Apps Agreement…" usually takes 1–3 days.
```

Claude does the work itself. You only step in for things a person has to do (create an account, pay a store fee, approve anything involving money, DNS or a store submission), and those land in your task list, release blockers first. Paperwork with long lead times goes on that list on day one, so it runs while Claude builds.

Liftoff doesn't trust its own ticks: `liftoff verify` checks the live site, DNS, the Stripe webhook, Sentry, PostHog, CI, Supabase row-level security and the shipped code for leaked keys, and unticks anything that isn't true. After launch, `/liftoff:pulse` pulls revenue, sign-ups, conversion, crashes and uptime from the accounts you already connected, and recommends one next action.

## Liftoff Cloud (web app)

The same thing in the browser: sign in with GitHub, add an app from a repo link or a zip, see it in Mission Control, and let Claude run the launch steps in a private cloud sandbox while you watch, answer questions and approve anything risky. Changes come back as a draft pull request (or a patch for zips). Keys stay encrypted on the server; the sandbox only sees placeholders.

It lives in [`cloud/`](cloud/README.md) and reuses this plugin's code. `render.yaml` deploys it to Render.

## Install

```
/plugin marketplace add AndrewStrong615/LaunchPad
/plugin install liftoff@launchpad
```

Requires Node 18+. No npm dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `/liftoff:onboard [steps]` | Reads the app and runs every launch step that isn't done yet (or just the ones you name). |
| `/liftoff:dashboard` | Starts Mission Control at http://localhost:4747. |
| `/liftoff:status [all\|app]` | Progress for this app or all of them. |
| `/liftoff:connect [account]` | Connect a service account once. |
| `/liftoff:verify [checks]` | Check the launch against the real services, plus the App Store pre-scan. |
| `/liftoff:go-live` | Switch payments to live safely: checks, live products and webhook, one real purchase and refund with your yes. |
| `/liftoff:pulse` | Live numbers (MRR, subscribers, sign-ups, paywall conversion, crash-free, uptime) and the next action. |
| `/liftoff:undo <step>` | Show what a step changed, revert it with your approval, reset the step. |

## Launch steps

Picked per app from the platforms it ships to (web, iOS, Android), and run in dependency order (payments waits for sign-in and the deployed URL its webhook needs; store checks wait for the privacy URL). `liftoff plan --explain` shows the order and what each step does. Each step has a skill in `skills/` that tells Claude exactly how to do it.

| Step | Skill | Provider |
| --- | --- | --- |
| Database | `database` | Supabase (or what the app already uses) |
| Sign-in | `auth` | Supabase Auth (or Clerk, Auth0, NextAuth, Firebase if present) |
| Hosting + domain | `hosting` | Vercel or Cloudflare (web apps) |
| Payments, Paywall | `payments` | Stripe (web), RevenueCat (iOS/Android); keeps Lemon Squeezy or Paddle |
| Email | `email` | Resend, with SPF and DKIM |
| Analytics | `analytics` | PostHog |
| Crash reports | `crash-reports` | Sentry |
| CI/CD | `ci-cd` | GitHub Actions (+ EAS / fastlane for mobile) |
| Purchase flow test | `money-path-test` | Playwright (web), Maestro (mobile) |
| Uptime + alerts | `monitoring` | GitHub Actions uptime check, Sentry and Stripe alerts |
| Landing page | `landing-page` | Built into your app or a small static site |
| Growth basics | `growth` | Review prompt, feedback, activation event, launch kit |
| TestFlight build, Play testing | `beta-builds` | App Store Connect, Google Play / Firebase App Distribution |
| Store checks | `store-readiness` | Rejection pre-scan (`liftoff scan`) and review checklist |
| Store listing | `store-submission` | fastlane deliver / supply; stops before Submit |

Also used on demand: `go-live` (by `/liftoff:go-live`) and `pricing-experiments` (when Pulse shows weak paywall conversion).

## Accounts: connect once, reuse everywhere

```
liftoff accounts                     # what's connected
liftoff accounts connect stripe      # prompts for the key, hidden
liftoff exec --only vercel -- vercel deploy --prod   # just the Vercel key in its environment
liftoff accounts migrate             # move keys from credentials.env into the OS keychain
```

Keys live in the OS keychain (macOS Keychain, or the Linux Secret Service via `secret-tool`) when one is available, otherwise in `~/.liftoff/credentials.env` (mode 600); never in your repo or the chat. Set `LIFTOFF_SECRET_STORE=file` or `keychain` to choose. `exec --only` injects only the named accounts' keys, so a command can't read keys it doesn't need. Every app you onboard afterwards reuses them, so the second app needs no setup.

## Mission Control

`/liftoff:dashboard` (or `node bin/liftoff.mjs dashboard`) serves a local page on 127.0.0.1:4747 showing:

- **All apps** with what's live, deploys and progress.
- **Your tasks**: everything waiting on you, with what blocks a release first. Add tasks and mark them done here.
- **Status** per app: live URL, deploys (web, TestFlight, Android testers), recent activity.
- **Release readiness**: about 50 checks across payments, hosting, analytics, builds, landing page, App Store, Google Play and security. Some tick themselves from the repo.
- **Your accounts**: which services are connected.
- **Do this next**: one recommended action with the number behind it.
- **Pulse**: MRR, subscribers, sign-ups, paywall conversion, crash-free sessions and uptime, refreshed on demand.
- **Verify** button on release readiness: re-checks against the live services and shows why anything failed.

## The CLI

Slash commands drive `bin/liftoff.mjs`; you can run it yourself too (`node bin/liftoff.mjs help`). State lives in `<your app>/.liftoff/state.json` (add `.liftoff/` to the app's `.gitignore` if you don't want it committed) and the list of apps in `~/.liftoff/projects.json`. Set `LIFTOFF_HOME` to move the shared folder.

## Settings that verify and Pulse read

```
liftoff set sentry.org acme          liftoff set posthog.project 12345
liftoff set sentry.project fernweh   liftoff set supabase.ref abcd1234
liftoff settings                     # all of them
```

The skills set these as they go. `liftoff costs` estimates monthly costs for the services an app uses (approximate list prices, with warnings such as Vercel Hobby not allowing commercial use).

## Develop

```
npm test
claude --plugin-dir .   # try the plugin locally
cd cloud && npm install && npm test && npm run dev   # the web app
```
