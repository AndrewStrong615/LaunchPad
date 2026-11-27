---
name: auth
description: Add sign-up and sign-in (email plus social), Sign in with Apple where Apple requires it, password reset, and account deletion that removes server data. Used by the sign-in launch step.
---

# Sign-in

Payments, analytics and store review all assume users have accounts. If `liftoff init` reports an existing provider (`auth:` Clerk, Auth0, NextAuth, Firebase Auth, Supabase Auth), keep it and only fill the gaps below.

## Default: Supabase Auth (it comes with the database step)
1. Email + password with email confirmation, and magic link if the app is casual. Add Google sign-in if the audience expects it.
2. **iOS: if the app offers any third-party sign-in (Google, Facebook…), it must also offer Sign in with Apple** (guideline 4.8). Expo: `expo-apple-authentication`; web: Supabase's Apple provider. Adding the Apple key in the Apple Developer portal is a task for the user if you can't do it via API.
3. Password reset flow with a deep link back into the app (mobile) or `/reset-password` (web).
4. After sign-in: `posthog.identify(user.id)`, `Sentry.setUser({ id })`, RevenueCat `logIn(user.id)` if those steps are set up.

## Account deletion (required by both stores)
- A "Delete account" button in settings, with a confirmation, that calls a server route which deletes the user's rows, the auth user (`supabase.auth.admin.deleteUser`), cancels any active subscription (Stripe: `subscriptions.cancel`), and revokes the Sign in with Apple token (`https://appleid.apple.com/auth/revoke`).
- A web page at `/delete-account` that explains how to delete (Google Play requires a URL).

## Test it
Sign up a throwaway user, sign out, sign back in, reset the password, delete the account, and confirm the rows are gone. Use data-testid attributes `signup-email`, `signup-password`, `signup-submit` so the purchase flow test can reuse them.

Record: `liftoff step auth done --provider <name>`; `liftoff record auth --file <path>` for each file you add; tick `auth-signin`, `auth-apple` (iOS), `auth-delete`, `ios-delete`, `play-delete`.
