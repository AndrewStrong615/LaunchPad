---
description: Show launch progress for this app, or every app with "all".
argument-hint: "[all | app-slug]"
allowed-tools: Bash
---

If $ARGUMENTS is `all`, run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs status --all`. If it names an app, run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs status $ARGUMENTS`. Otherwise run it with no arguments in the current project.

If there is no state yet, say so and suggest `/liftoff:launch`.

For a single app, also run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs verify` first if it hasn't run today (`lastVerifiedAt` in `status --json`), so the checklist reflects what's actually true, and `pulse` if the app is live.

Reply with a short summary: what's live, launch steps done out of total, readiness checks done (and how many were verified against the real services), anything verify found broken, the open tasks with release blockers first, and the Pulse numbers if there are any. End with the **Next:** line from status (one recommended action with the number behind it) and offer to do it.
