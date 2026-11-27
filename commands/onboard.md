---
description: Launch this app. Reads the code, then wires up payments, paywall, hosting, analytics, crash reports, CI/CD, beta builds, a landing page and store checks.
argument-hint: "[optional: steps to run, e.g. payments hosting]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch
---

You are launching the user's app end to end. Work through every step yourself; only stop for things that truly need the human (creating an account, paying a fee, approving a money/DNS/store action).

The Liftoff CLI records progress so Mission Control can show it:

```
LIFTOFF="node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs"
```

## 1. Read the app

Run `$LIFTOFF init` in the project root. Then read the code yourself (package.json / app.json / pubspec / Xcode / Gradle, the main screens, any existing backend) so you understand:
- what the app does and who pays for what (the "Pro" feature),
- platforms (web, iOS, Android) and framework,
- what's already set up (the `init` output lists detected integrations).

Tell the user in two or three lines what you found, e.g. "Reading your app: **Basket**, grocery list, Expo (iOS, Android, Web)".

## 2. Check accounts once

Run `$LIFTOFF plan`. Every ✗ account is missing on this machine. Accounts are connected **once per machine** and reused by every future app, so if they're all ✓, say "Accounts already connected, reusing them" and move on.

For missing accounts, give the user one short list: what to create, what it costs (Apple Developer $99/yr, Google Play $25 once), and where to get the key (the URL from `$LIFTOFF accounts`). Ask them to store each key themselves by running, in this session:

```
! node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs accounts connect <id>
```

so the secret never enters the chat. Never ask them to paste a secret key into the conversation. Steps whose accounts are still missing get `$LIFTOFF step <id> blocked --note "needs <account>"` and a task (`$LIFTOFF task add "Connect Stripe" --blocks`); keep going with everything else.

## 3. Run each step

If $ARGUMENTS names steps, run only those. Otherwise run every step from `$LIFTOFF plan` that isn't done, in order. For each step:

1. `$LIFTOFF step <id> running`
2. Follow the matching skill (the `skill:` column of the plan): `payments`, `hosting`, `analytics`, `crash-reports`, `ci-cd`, `landing-page`, `beta-builds`, `store-readiness`.
3. Run any provider CLI or API call that needs a key through `$LIFTOFF exec -- <command>` so stored keys are injected without printing them.
4. When it works: `$LIFTOFF step <id> done --provider <name> --note "<one line>"`, and tick the readiness items you satisfied with `$LIFTOFF check <item-id>` (see `$LIFTOFF checklist`).
5. Anything only the human can do goes in as a task: `$LIFTOFF task add "<what, where>" [--blocks]`. Use `--blocks` only when it stops a release.
6. Record deploys with `$LIFTOFF deploy --target vercel --platform web --url https://... --status live` (or `--target testflight --platform ios --version 1.4 (12)`).

Safety: always ask before anything that spends money, changes DNS, switches payments to live mode, or submits to an app store. Use test mode for payments until the user says go live. Never commit secrets; put them in the host's / CI's secret store.

Keep the user posted with one line per finished step (✓ Payments + paywall, ✓ Hosting + domain…). Commit your code changes in logical commits on a branch if the project is a git repo.

## 4. Finish

Run `$LIFTOFF status`. Summarise: what's live (URLs, TestFlight / Play testing builds), what's left for the human (open tasks, blocking ones first), and suggest `/liftoff:dashboard` to watch everything in Mission Control.
