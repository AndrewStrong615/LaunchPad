---
name: landing-page
description: Build a landing page for the app with a clear headline, screenshots, a download or sign-up button, social previews, and privacy/terms pages. Used by the landing page launch step.
---

# Landing page

Write the page from what the app actually does, in the app's own visual style (its colours, fonts, icon). Don't use a generic template look.

Sections:
1. Hero: short headline in the user's voice ("Your habits, finally kept."), one-line subhead, primary button (App Store / Google Play badges for mobile, "Get started" for web), a device screenshot or mockup.
2. Three features, each with a screenshot.
3. Pricing (free vs Pro, matching the payments step).
4. FAQ (3–5).
5. Footer: support email, privacy policy, terms.

Placement:
- Web app: the marketing route of the same app (`/` for logged-out users), or `/landing`.
- Mobile-only app: a small static site in `landing/` deployed through the hosting step.

Also create `/privacy` and `/terms` pages (plain, honest: list the services actually used, e.g. Stripe, PostHog, Sentry, Supabase; add an account deletion section). These URLs are needed for the store listings. Add Open Graph / Twitter meta tags and an `og-image` (generate a 1200×630 image from the hero). Add PostHog pageview tracking if analytics is set up.

Record: `liftoff step landing done --note "<url>"`, tick `land-page`, `land-cta`, `land-og`, `land-legal`, `land-support`.
