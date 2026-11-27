---
description: Live numbers for this app - revenue, subscriptions, sign-ups, conversion, crashes and uptime - and the one thing to do next.
allowed-tools: Bash
---

Run `node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs pulse` in the app folder.

If it says there are no numbers yet, tell the user which accounts or settings are missing (`liftoff settings` lists them) and stop.

Otherwise reply with the numbers that moved most this week, in plain words ("MRR $420, up $60 from last week; 38 sign-ups, down from 52"), anything alarming (site down, crash-free below 99%, failed payments), and the **Next:** line with the reason behind it. Offer to do that next action. If the user asks about costs, run `liftoff costs`.
