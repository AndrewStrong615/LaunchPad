---
name: safety
description: Limits for apps that do more than the basics. AI calls stay on the server with per-user limits, uploads are capped by size and type and kept private, and what people post can be reported, blocked, filtered and removed. Used by the abuse and spend limits launch step.
---

# Abuse and spend limits

Only do the parts that fit the app: `liftoff profile` (in the cloud, `liftoff_plan`'s profile) says whether it uses AI models, takes uploads or shows what people post. Keep the libraries the app already has.

## AI models (`ai`)

1. **On the server only.** Every call to the model provider goes through the app's own API route or function, with the key in server env vars. Remove any key or direct provider call from client code (`liftoff verify --only sec-keys` catches leaked keys). Tick `ai-server`.
2. **Per-person limits.** Rate-limit the AI route per signed-in user (or per IP for apps without sign-in): a short window (e.g. 10 requests a minute) and a daily cap that fits the free and paid plans. Use what the app already has (Upstash Ratelimit, a database counter, the host's rate limiting). Return a clear "you've hit today's limit" message, not a 500. Tick `ai-limits`.
3. **When the model fails.** Timeouts (30 s or less), one retry on 429/5xx with backoff, and a friendly error state in the UI. Cap `max_tokens` on every call. Tick `ai-errors`.
4. **Spend cap.** Only the user can set the monthly limit in the provider's console. The "Set a monthly spend limit with your AI provider" task is already on their list: point them to it with the provider's link.

## Uploads (`uploads`)

1. **Limits.** Check size and type on the server, not only in the picker: a size cap that fits the use (e.g. 10 MB for photos), an allowlist of MIME types checked against the file's first bytes, and image resizing where it helps. Tick `up-limits`.
2. **Private by default.** Store uploads in a private bucket (Supabase Storage policies, S3 without public ACLs, Vercel Blob with random names) and hand out signed, expiring URLs. Only files meant to be public go in a public bucket. Deleting an account deletes its files. Tick `up-private`.
3. Strip location data from photos that other people can see.

## What people post (`community`)

App Store guideline 1.2 asks for all four of these in any app where people post things others see; Google Play asks for the same.

1. **Report and block.** A "Report" action on every post, comment and profile, and "Block" on every person, with blocked people's content hidden. Tick `ugc-report`.
2. **Filter.** Check new text against a word list or a moderation API (OpenAI's moderation endpoint is free) before others see it, and hold what it flags. Tick `ugc-filter`.
3. **Remove fast.** An admin view or script to remove content and ban an account, and a support address that answers reports within 24 hours (on the landing page). Tick `ugc-remove`.
4. **Terms.** Terms that forbid abusive content, which people agree to when they sign up (a checkbox or "By joining you agree…" next to the button). Tick `ugc-terms`.

Record: `liftoff record safety --file <path>` for each file you add, then `liftoff step safety done --note "<what you set up>"`.
