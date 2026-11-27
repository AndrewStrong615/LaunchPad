---
description: Connect a service account once (Stripe, Vercel, Supabase, PostHog, Sentry, Apple, Google Play…) so every app reuses it.
argument-hint: "[account id]"
allowed-tools: Bash
---

Run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs accounts` and show which accounts are connected.

For the account in $ARGUMENTS (or each missing one the user wants), tell them where to create the key (the URL in the list) and ask them to run this themselves, so the secret never appears in the chat:

```
! node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs accounts connect <id>
```

Keys are stored in the OS keychain when one is available (otherwise `~/.liftoff/credentials.env`, readable only by them) and injected into commands via `liftoff exec --only <account>`. If keys are still in the file on a machine with a keychain, suggest `liftoff accounts migrate`. Never ask the user to paste a key into the conversation.
