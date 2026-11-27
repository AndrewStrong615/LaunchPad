---
description: Show launch progress for this app, or every app with "all".
argument-hint: "[all | app-slug]"
allowed-tools: Bash
---

If $ARGUMENTS is `all`, run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs status --all`. If it names an app, run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs status $ARGUMENTS`. Otherwise run it with no arguments in the current project.

If there is no state yet, say so and suggest `/liftoff:onboard`.

Reply with a short summary: what's live, launch steps done out of total, readiness checks done, and the open tasks with release blockers first. Suggest the single most useful next step.
