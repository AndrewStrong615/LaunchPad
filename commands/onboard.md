---
description: Launch this app. Reads the code, then wires up the database, sign-in, hosting, payments, paywall, email, analytics, crash reports, CI/CD, a purchase flow test, uptime alerts, a landing page, growth basics, beta builds and the store listing, and verifies each against the real services.
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
- what's already set up (the `init` output lists detected integrations, the existing sign-in and payments provider, the package manager, and the apps inside a monorepo). Keep what exists; don't install a second auth or payments stack.

Tell the user in two or three lines what you found, e.g. "Reading your app: **Basket**, grocery list, Expo (iOS, Android, Web)".

## 2. Start the slow paperwork first

`init` adds dated tasks for paperwork with long lead times (Apple Developer enrollment and Paid Apps Agreement, Google Play verification and the 14-day closed test, Stripe activation, the domain). Show them to the user **before** building, with how long each takes and the link, and ask them to start them now so they run in parallel with your work. Mark each one done when the user says it is.

## 3. Check accounts once

Run `$LIFTOFF plan`. Every ✗ account is missing on this machine. Accounts are connected **once per machine** and reused by every future app, so if they're all ✓, say "Accounts already connected, reusing them" and move on.

For missing accounts, give the user one short list: what to create, what it costs (Apple Developer $99/yr, Google Play $25 once), and where to get the key (the URL from `$LIFTOFF accounts`). Ask them to store each key themselves by running, in this session:

```
! node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs accounts connect <id>
```

so the secret never enters the chat. Never ask them to paste a secret key into the conversation. Steps whose accounts are still missing get `$LIFTOFF step <id> blocked --note "needs <account>"` and a task (`$LIFTOFF task add "Connect Stripe" --blocks`); keep going with everything else.

## 4. Run each step

If $ARGUMENTS names steps, run only those. Otherwise run every step from `$LIFTOFF plan` that isn't done, **in the order the plan lists them**: steps depend on each other (payments needs sign-in and the deployed URL for its webhook; store checks need the privacy URL from the landing page), and `liftoff step <id> done` refuses a step whose needs aren't finished. If the user wants to see what will happen first, show `$LIFTOFF plan --explain`. For each step:

1. `$LIFTOFF step <id> running`
2. Follow the matching skill (the `skill:` column of the plan).
3. Run any provider CLI or API call that needs a key through `$LIFTOFF exec --only <account>[,<account>] -- <command>` so only the keys that command needs are injected, without printing them.
4. Log what you change so the step can be undone: `$LIFTOFF record <id> --file <path>` for files and `$LIFTOFF record <id> --resource <provider>:<kind>:<id>` for things you create at a provider.
5. Prove it works: run `$LIFTOFF verify --only <the step's checks>` where the skill names them. Verify ticks what passes and unticks what fails. Fix failures before marking the step done; don't tick a verifiable item by hand.
6. When it works: `$LIFTOFF step <id> done --provider <name> --note "<one line>"`, and tick the remaining readiness items you satisfied with `$LIFTOFF check <item-id>` (see `$LIFTOFF checklist`). If a step was already done before Liftoff (the app had it), use `skipped` with a note.
7. Anything only the human can do goes in as a task: `$LIFTOFF task add "<what, where>" [--blocks]`. Use `--blocks` only when it stops a release.
8. Record deploys with `$LIFTOFF deploy --target vercel --platform web --url https://... --status live` (or `--target testflight --platform ios --version 1.4 (12)`).

Safety: always ask before anything that spends money, changes DNS, switches payments to live mode, or submits to an app store. Use test mode for payments until the user says go live. Never commit secrets; put them in the host's / CI's secret store.

Keep the user posted with one line per finished step (✓ Payments + paywall, ✓ Hosting + domain…). Commit your code changes in logical commits on a branch if the project is a git repo.

## 5. Finish

Run `$LIFTOFF verify`, then `$LIFTOFF status`. Summarise: what's live (URLs, TestFlight / Play testing builds), what verify proved and anything that failed, what's left for the human (open tasks, blocking ones first, with lead times), and the single next action status prints. Then point to `/liftoff:go-live` for switching payments to live, `/liftoff:pulse` for numbers after launch, and `/liftoff:dashboard` to watch everything in Mission Control.
