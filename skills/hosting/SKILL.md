---
name: hosting
description: Deploy a web app to production on Vercel (default), Netlify or Cloudflare, with environment variables, preview deploys and a custom domain. Used by the deploy and domain launch step.
---

# Deploy and domain

## Pick the host
- `wrangler.toml` present, or the user prefers Cloudflare → Cloudflare Pages/Workers.
- `netlify.toml` present, or the user prefers Netlify → Netlify.
- `firebase.json` with `hosting` → Firebase Hosting, deployed from CI with the service account key (it never goes in the sandbox).
- Otherwise Vercel.

## Vercel
1. `liftoff exec --only vercel -- npx vercel link --yes` (uses `VERCEL_TOKEN` via `--token $VERCEL_TOKEN` if needed).
2. Push env vars: for each required var (Stripe, Supabase, PostHog, Sentry…) `liftoff exec --only vercel,<account> -- npx vercel env add NAME production` reading the value from the stored credentials. Never echo secrets.
3. Deploy: `liftoff exec --only vercel -- npx vercel deploy --prod --yes`. Capture the URL. Record the project: `liftoff record hosting --resource vercel:project:<name>`.
4. Connecting the Git repo gives preview deploys for pull requests (`vercel git connect`).
5. A paid app can't stay on Vercel's Hobby plan (non-commercial use only): add a task to upgrade to Pro before launch (see `liftoff costs`).

## Cloudflare
1. Static/SSR frameworks: `liftoff exec --only cloudflare -- npx wrangler pages deploy <build-dir> --project-name <slug>`; Workers: `npx wrangler deploy`.
2. Secrets: `npx wrangler secret put NAME` / Pages env vars in the project settings via API.

## Netlify
1. Create or link the site through the API (`liftoff exec --only netlify -- curl -sS https://api.netlify.com/api/v1/sites -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" ...`) or `npx netlify-cli link`. Record it: `liftoff record hosting --resource netlify:site:<id>`.
2. Env vars through the API (`/api/v1/accounts/<account>/env`), or the site settings. Never echo secrets.
3. Deploy with `npx netlify-cli deploy --prod --dir <build-dir>` (auth with `NETLIFY_AUTH_TOKEN`), or connect the Git repo for deploys and deploy previews on every pull request.

## Domain
Ask the user which domain to use (never buy one or change DNS without a yes). Add it to the project (`vercel domains add <domain>`), then give the exact DNS records to set, or set them via the Cloudflare API if the zone is there and the user approved. Make `www` redirect to the apex (or the reverse).

## Record
- `liftoff deploy --target vercel --platform web --url https://<url> --status live`
- `liftoff step hosting done --provider vercel --note "<domain>"`
- Run `liftoff verify --only host-deploy,host-https,host-domain`: it ticks those from the live site. Tick `host-env` and `host-previews` yourself.
- If DNS is pending on the user: `liftoff task add "Add DNS records for <domain> at your registrar" --blocks`.

## A service Liftoff doesn't list
If the user added the provider themselves (Liftoff Cloud: `customServices` in `liftoff_plan`), keep the goals above and get the how from its docs: read them with `liftoff_docs` (start at the link the user gave; `/llms.txt` or an OpenAPI file are quicker when they exist), call its API with `liftoff_call`, and have the app read the key from the env var named `keyName`. Use its test or sandbox mode. `liftoff verify` can't check it: tick the items you tested yourself (they show as reported), and record the service's name as the provider.
