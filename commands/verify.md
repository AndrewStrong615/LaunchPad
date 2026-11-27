---
description: Check the launch against the real services (live site, DNS, HTTPS, Stripe webhook, Sentry, PostHog, CI, database security, leaked keys) and the App Store pre-scan.
argument-hint: "[optional: check ids, comma-separated]"
allowed-tools: Bash
---

Run in the app folder:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs verify ${ARGUMENTS:+--only $ARGUMENTS}
```

If the app ships to iOS or Android, also run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs scan`.

Report what passed, what failed (with the reason verify gives) and what couldn't be checked and why (usually an account that isn't connected or a setting like `sentry.project` that isn't set: say which `liftoff set` command fixes it). For each failure, say in one line how you'd fix it and offer to do it. Verify ticks passing items and unticks failing ones, so the checklist on the Flight Board now matches reality.
