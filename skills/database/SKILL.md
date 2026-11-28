---
name: database
description: Set up the app's database (Supabase by default, or keep the Firebase, Neon or other one it already uses) with row-level security or security rules on every table and backups. Used by the database launch step.
---

# Database

If the app already has a database (Firebase, Prisma with Postgres, PlanetScale, Convex…), keep it: check it against the list below and skip creating a new one.

## Supabase (default)
1. Create the project through the Management API if it doesn't exist, after confirming the region with the user: `liftoff exec --only supabase -- curl -sS -X POST https://api.supabase.com/v1/projects -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" ...`. Record it: `liftoff set supabase.ref <ref>` and `liftoff record database --resource supabase:project:<ref>`.
2. Write the schema as migrations in `supabase/migrations/` (`supabase migration new <name>`), never by clicking in the dashboard. Minimum: `profiles` (id = `auth.users.id`, created_at) and `subscriptions` (user_id, plan, status, provider, current_period_end) for the payments step.
3. **Row-level security on every table**, with policies so users read and write only their own rows (`auth.uid() = user_id`). `subscriptions` is written only by the server (service role) from the payments webhook.
4. Put the anon key in the client env (`NEXT_PUBLIC_SUPABASE_ANON_KEY` / `EXPO_PUBLIC_…`). The service role key goes only in server env vars, never in the client.
5. Backups: free projects have none and pause after a week without traffic. Add a task: "Upgrade Supabase to Pro before launch ($25/mo) for daily backups" (blocks release).

## Firebase (Firestore)
If the app uses Firebase (`firebase.json`, the `firebase` package), keep it. The key is a service account JSON (`FIREBASE_SERVICE_ACCOUNT_JSON`), which signs its own requests, so it never goes in the sandbox: write `firestore.rules` and `storage.rules` into the repo and deploy them from CI (`firebase deploy --only firestore:rules,storage` in a GitHub Actions workflow, with the key as a secret via `github_set_secret` in the cloud).
- Rules: users read and write only their own documents (`request.auth.uid == userId`). Never leave test-mode rules (`allow read, write: if request.time < timestamp.date(…)`) or `if true`, and never a catch-all `match /{document=**}` that lets any signed-in user write everything.
- `liftoff verify --only sec-rls` reads the released Firestore and Storage rules through the Firebase Rules API and fails on open ones.
- Backups: Firestore scheduled backups need the Blaze plan. Add a task for the user if they're not on.

## Neon (Postgres)
If the app uses Neon (`@neondatabase/serverless`, a `*.neon.tech` connection string), keep it. Migrations live in the repo with the app's ORM (Prisma, Drizzle…). There's no row-level security by default: enforce per-user access in the server queries, or turn on Postgres RLS and say so in the note. Save the project with `liftoff set neon.project <id>`; `liftoff verify --only sec-backup` checks the restore window (history retention) through the Neon API.

## Check
`liftoff verify --only sec-rls,sec-keys` must pass (RLS on every public table, no service role key in client code).

Record: `liftoff step database done --provider supabase` (or firebase, neon), `liftoff record database --file <each migration>`; tick `sec-rls` only through verify, `sec-backup` once backups are on.

## A service Liftoff doesn't list
If the user added the provider themselves (Liftoff Cloud: `customServices` in `liftoff_plan`), keep the goals above and get the how from its docs: read them with `liftoff_docs` (start at the link the user gave; `/llms.txt` or an OpenAPI file are quicker when they exist), call its API with `liftoff_call`, and have the app read the key from the env var named `keyName`. Use its test or sandbox mode. `liftoff verify` can't check it: tick the items you tested yourself (they show as reported), and record the service's name as the provider.
