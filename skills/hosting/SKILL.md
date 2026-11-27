---
name: hosting
description: Deploy a web app to production on Vercel (default) or Cloudflare, with environment variables, preview deploys and a custom domain. Used by the hosting launch step.
---

# Hosting + domain

## Pick the host
- `wrangler.toml` present, or the user prefers Cloudflare → Cloudflare Pages/Workers.
- Otherwise Vercel.

## Vercel
1. `liftoff exec -- npx vercel link --yes` (uses `VERCEL_TOKEN` via `--token $VERCEL_TOKEN` if needed).
2. Push env vars: for each required var (Stripe, Supabase, PostHog, Sentry…) `liftoff exec -- npx vercel env add NAME production` reading the value from the stored credentials. Never echo secrets.
3. Deploy: `liftoff exec -- npx vercel deploy --prod --yes`. Capture the URL.
4. Connecting the Git repo gives preview deploys for pull requests (`vercel git connect`).

## Cloudflare
1. Static/SSR frameworks: `liftoff exec -- npx wrangler pages deploy <build-dir> --project-name <slug>`; Workers: `npx wrangler deploy`.
2. Secrets: `npx wrangler secret put NAME` / Pages env vars in the project settings via API.

## Domain
Ask the user which domain to use (never buy one or change DNS without a yes). Add it to the project (`vercel domains add <domain>`), then give the exact DNS records to set, or set them via the Cloudflare API if the zone is there and the user approved. Make `www` redirect to the apex (or the reverse).

## Record
- `liftoff deploy --target vercel --platform web --url https://<url> --status live`
- `liftoff step hosting done --provider vercel --note "<domain>"`
- Tick `host-deploy`, `host-env`, `host-https`, `host-previews`, `host-domain` (only once DNS resolves).
- If DNS is pending on the user: `liftoff task add "Add DNS records for <domain> at your registrar" --blocks`.
