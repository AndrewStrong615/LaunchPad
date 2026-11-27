# Liftoff

A Claude Code plugin that launches your app from one command, then tracks every app you've launched in a local **Mission Control** dashboard.

```
> /liftoff:onboard
  ✓ Reading your app            Fernweh · Expo (iOS, Android, Web)
  ✓ Payments + paywall          Stripe on web, RevenueCat on mobile
  ✓ Hosting + domain            Vercel (or Cloudflare)
  ✓ Analytics + crashes         PostHog + Sentry
  ✓ CI/CD on GitHub             build → test → deploy to production
  ✓ TestFlight build            Play testing build
  ✓ Landing page                with privacy + terms pages
  ✓ Store checks                screenshots, age rating, account deletion, review notes…
  Ready for users ✓
```

Claude does the work itself. You only step in for things a person has to do (create an account, pay a store fee, approve anything involving money, DNS or a store submission), and those land in your task list, release blockers first.

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

## Launch steps

Picked per app from the platforms it ships to (web, iOS, Android). Each step has a skill in `skills/` that tells Claude exactly how to do it.

| Step | Skill | Provider |
| --- | --- | --- |
| Payments, Paywall | `payments` | Stripe (web), RevenueCat (iOS/Android) |
| Hosting + domain | `hosting` | Vercel or Cloudflare (web apps) |
| Analytics | `analytics` | PostHog |
| Crash reports | `crash-reports` | Sentry |
| CI/CD | `ci-cd` | GitHub Actions (+ EAS / fastlane for mobile) |
| Landing page | `landing-page` | Built into your app or a small static site |
| TestFlight build, Play testing | `beta-builds` | App Store Connect, Google Play / Firebase App Distribution |
| Store checks | `store-readiness` | App Store and Google Play review checklist |

## Accounts: connect once, reuse everywhere

```
liftoff accounts                     # what's connected
liftoff accounts connect stripe      # prompts for the key, hidden
liftoff exec -- vercel deploy --prod # runs with your stored keys in the environment
```

Keys live in `~/.liftoff/credentials.env` (mode 600), never in your repo or the chat. Every app you onboard afterwards reuses them, so the second app needs no setup.

## Mission Control

`/liftoff:dashboard` (or `node bin/liftoff.mjs dashboard`) serves a local page on 127.0.0.1:4747 showing:

- **All apps** with what's live, deploys and progress.
- **Your tasks**: everything waiting on you, with what blocks a release first. Add tasks and mark them done here.
- **Status** per app: live URL, deploys (web, TestFlight, Android testers), recent activity.
- **Release readiness**: about 50 checks across payments, hosting, analytics, builds, landing page, App Store, Google Play and security. Some tick themselves from the repo.
- **Your accounts**: which services are connected.

## The CLI

Slash commands drive `bin/liftoff.mjs`; you can run it yourself too (`node bin/liftoff.mjs help`). State lives in `<your app>/.liftoff/state.json` (add `.liftoff/` to the app's `.gitignore` if you don't want it committed) and the list of apps in `~/.liftoff/projects.json`. Set `LIFTOFF_HOME` to move the shared folder.

## Develop

```
npm test
claude --plugin-dir .   # try the plugin locally
```
