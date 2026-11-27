---
name: database
description: Set up the app's database (Supabase by default, or keep the one it already uses) with row-level security on every table and backups. Used by the database launch step.
---

# Database

If the app already has a database (Firebase, Prisma with Postgres, PlanetScale, Convex…), keep it: check it against the list below and skip creating a new one.

## Supabase (default)
1. Create the project through the Management API if it doesn't exist, after confirming the region with the user: `liftoff exec --only supabase -- curl -sS -X POST https://api.supabase.com/v1/projects -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" ...`. Record it: `liftoff set supabase.ref <ref>` and `liftoff record database --resource supabase:project:<ref>`.
2. Write the schema as migrations in `supabase/migrations/` (`supabase migration new <name>`), never by clicking in the dashboard. Minimum: `profiles` (id = `auth.users.id`, created_at) and `subscriptions` (user_id, plan, status, provider, current_period_end) for the payments step.
3. **Row-level security on every table**, with policies so users read and write only their own rows (`auth.uid() = user_id`). `subscriptions` is written only by the server (service role) from the payments webhook.
4. Put the anon key in the client env (`NEXT_PUBLIC_SUPABASE_ANON_KEY` / `EXPO_PUBLIC_…`). The service role key goes only in server env vars, never in the client.
5. Backups: free projects have none and pause after a week without traffic. Add a task: "Upgrade Supabase to Pro before launch ($25/mo) for daily backups" (blocks release).

## Check
`liftoff verify --only sec-rls,sec-keys` must pass (RLS on every public table, no service role key in client code).

Record: `liftoff step database done --provider supabase`, `liftoff record database --file <each migration>`; tick `sec-rls` only through verify, `sec-backup` once backups are on.
