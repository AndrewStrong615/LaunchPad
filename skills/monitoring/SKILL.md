---
name: monitoring
description: Add a health endpoint, an uptime check and alerts for downtime, crash spikes, failed webhooks and failed payments. Used by the uptime + alerts launch step.
---

# Uptime and alerts

1. **Health endpoint**: add `GET /api/health` (or the framework's equivalent) that returns 200 with `{ ok: true, version }` and does one cheap database read, so it fails when the database does. For a mobile-only app, use the API or Supabase project URL. Save the path if it differs: `liftoff set health.path /healthz`.
2. **Uptime check**: `liftoff scaffold uptime` writes `.github/workflows/liftoff-uptime.yml` (every 10 minutes, 3 tries). Set the repo variable: `liftoff exec --only github -- gh variable set LIFTOFF_HEALTH_URL --body <url>`. If the user wants a status page or phone alerts, suggest Better Stack instead; don't sign them up.
3. **Alerts** (default to email; ask whether they want Slack and, if so, have them add a `SLACK_WEBHOOK_URL` secret):
   - Downtime: the uptime workflow (GitHub emails on failure).
   - Crash spike: a Sentry metric alert when errors are more than 3× the weekly average in an hour.
   - Failed webhooks: Stripe emails on failing webhook deliveries by default; confirm the account email is right.
   - Failed payments: turn on Stripe Smart Retries and customer emails for failed payments (Billing settings). That's a dashboard setting: add a task with the link if you can't set it via API.
4. Verify: `liftoff verify --only mon-uptime`.

Record: `liftoff step monitoring done`, `liftoff record monitoring --file .github/workflows/liftoff-uptime.yml`; tick `mon-alerts` when the downtime and crash spike alerts exist, and `pay-alerts` when the failed webhook and failed payment alerts do (apps that take payments only; skip those two otherwise).
