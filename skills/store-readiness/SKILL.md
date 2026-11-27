---
name: store-readiness
description: Prepare App Store and Google Play submissions by going through the review checklist (screenshots, privacy URL, age rating, account deletion, review notes, data safety) and fixing what can be fixed in code. Used by the store checks launch step.
---

# Store checks

Run `liftoff checklist` and work through the **App Store** and **Google Play** groups. Fix what you can; turn the rest into tasks.

## App Store (common rejection reasons first)
- **Account deletion in the app** (Guideline 5.1.1(v)): if the app has accounts, add a "Delete account" button in settings that deletes server data (and revokes Sign in with Apple tokens). Tick `ios-delete`.
- **Privacy policy URL**: from the landing page step. Tick `ios-privacy-url`.
- **Screenshots at 6.9" and 6.5"**: generate them from the simulator (`xcrun simctl io booted screenshot`) on iPhone 16 Pro Max (6.9") and iPhone 11 Pro Max / XS Max (6.5") sized devices, or Expo/Maestro scripts, into `store/ios/`. Tick `ios-screens`.
- **Age rating**: draft answers from what the app contains, task for the user to confirm in App Store Connect.
- **App Review notes**: write `store/ios/review-notes.md` with what the app does, a demo login (create a test account), and where the paywall is. Tick `ios-review-notes`.
- **In-app purchases** must be attached to the version being submitted. Paywall must show price, period, and links to terms and privacy (3.1.2).
- Privacy nutrition labels: draft from the SDKs used (PostHog analytics, Sentry diagnostics, Stripe/RevenueCat purchases).
- Export compliance: if only standard HTTPS, set `ITSAppUsesNonExemptEncryption = false` in Info.plist / `app.json`.
- Sign in with Apple is required if the app offers other third-party sign-in.

## Google Play
- Store listing assets in `store/android/` (512px icon, 1024×500 feature graphic, phone screenshots).
- Data safety form: draft answers from the SDKs used.
- Content rating, target audience and ads declarations: draft answers as a task.
- Account deletion: also needs a web URL (add `/delete-account` on the landing site).
- New personal accounts: closed test with 12 testers for 14 days.

Never press submit. When everything's ready, add the task "Submit <App> for review" (blocks release) and tell the user.

Record: `liftoff step store-checks done --note "<n> items handled"` (or `blocked` with the reason) and tick each item you completed.
