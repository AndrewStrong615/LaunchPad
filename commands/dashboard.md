---
description: Open the Flight Board, the local dashboard for every app Liftoff knows about.
allowed-tools: Bash
---

Start the Flight Board in the background and tell the user the URL:

```
node ${CLAUDE_PLUGIN_ROOT}/bin/liftoff.mjs dashboard --port ${LIFTOFF_PORT:-4810}
```

Run it with the Bash tool's background option so it keeps serving. If the port is taken, the Flight Board is probably already running: check with `curl -s localhost:4810/api/apps` and just give the URL.

Then tell the user: open http://localhost:4810. It shows all apps, what's live, deploys, release readiness, and their tasks with what blocks a release first. They can add tasks and mark them done there.
