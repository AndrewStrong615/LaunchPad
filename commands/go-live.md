---
description: Switch payments from test mode to live, safely - checks first, live products, keys and webhook, verify, then one real purchase and refund with your approval.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

Follow the `go-live` skill step by step for the app in the current folder, using `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs` as `liftoff`.

Start by running `liftoff verify` and `liftoff status`, and tell the user in two or three lines whether the app is ready to go live and what's missing. Stop at any failed precondition and say what to fix. Ask before every step that touches real money (live products, the live webhook, the real purchase), and never paste or ask for secret keys in the chat.

Finish with what is now live, the result of the real purchase test (or that the user skipped it), and `liftoff next`.
