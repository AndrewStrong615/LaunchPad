---
description: Undo a launch step - shows the files and provider resources it changed, reverts them with your approval, and resets the step.
argument-hint: "<step id>"
allowed-tools: Bash, Read, Write, Edit
---

Run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs undo $ARGUMENTS` in the app folder and show the user what it lists: files to revert, provider resources to delete, and steps that build on this one.

Ask before deleting anything at a provider or reverting files. On yes: revert the files (use git where the change is in a commit), delete the resources through `liftoff exec --only <account> -- ...`, then run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs undo $ARGUMENTS --yes` to reset the step. Never delete live payment data (live prices with subscribers, customers, payouts).
