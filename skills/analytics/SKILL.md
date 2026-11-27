---
name: analytics
description: Add product analytics with PostHog (web and mobile), track the key funnel events and identify users. Used by the analytics launch step.
---

# Analytics

1. Install: web `posthog-js` (+ `posthog-node` server-side for webhooks); Expo/React Native `posthog-react-native`; Flutter `posthog_flutter`; native iOS/Android PostHog SDKs.
2. Initialise once at app start with the **project** API key (public, fine in the client) from env (`NEXT_PUBLIC_POSTHOG_KEY`, `EXPO_PUBLIC_POSTHOG_KEY`, …) and host `https://us.i.posthog.com` or `eu` as the user chose. The personal API key stored in Liftoff is only for server/API work.
3. Track the funnel that matters for this app, with consistent snake_case names:
   - `signed_up`, `signed_in`
   - the core action (e.g. `trip_created`, `item_added`, `habit_checked`)
   - `paywall_viewed`, `upgraded_to_pro` (with `plan`, `price`), `subscription_cancelled` (from the payments webhook, server-side)
4. `identify(userId, { email, plan })` after sign-in; `reset()` on sign-out.
5. Respect consent where required (EU): don't capture before consent if the app targets the EU.
6. Optional: create a dashboard via the PostHog API with live users, events, signups and upgrades.

Record: `liftoff step analytics done --provider posthog`, tick `ana-sdk`, `ana-events`, `ana-identify`.
