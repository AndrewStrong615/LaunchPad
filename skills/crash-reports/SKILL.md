---
name: crash-reports
description: Add Sentry crash and error reporting with source maps / dSYMs and alerts. Used by the crash reports launch step.
---

# Crash tracking

1. Install for the stack: `@sentry/nextjs` (run `npx @sentry/wizard@latest -i nextjs`), `@sentry/react`, `@sentry/node`, `@sentry/react-native` (Expo: add the `@sentry/react-native/expo` plugin), `sentry_flutter`, or the native SDKs.
2. Create the Sentry project via API if needed: `liftoff exec --only sentry -- curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" ...`.
3. Init early with the DSN from env, `environment` (production / preview / development) and `release` = app version so crashes map to builds. Keep `tracesSampleRate` low (0.1) in production.
4. Upload source maps (web/RN) or dSYMs (iOS) in CI with `SENTRY_AUTH_TOKEN` as a CI secret.
5. Attach the user id after sign-in (`Sentry.setUser({ id })`), no emails unless the user wants that.
6. Create an alert rule for new issues (email by default).
7. Save the slugs so verify and Pulse can read Sentry: `liftoff set sentry.org <org>` and `liftoff set sentry.project <project>`. Turn on release health (sessions) so Pulse shows crash-free sessions.
8. Verify: trigger a test error once in development, then `liftoff verify --only crash-sdk,crash-alerts`. Remove the trigger.

Record: `liftoff step crashes done --provider sentry`, tick `crash-sdk`, `crash-sourcemaps`, `crash-alerts`.
