---
name: beta-builds
description: Ship iOS builds to TestFlight and Android builds to a Play testing track (or Firebase App Distribution). Used by the TestFlight beta and Play test track launch steps.
---

# Beta builds

## iOS → TestFlight
Requires the Apple Developer account (App Store Connect API key stored as `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_KEY`).
1. Make sure the bundle id is set and the app record exists in App Store Connect. If you can't create it via API, add a blocking task: "Create the app in App Store Connect with bundle id X".
2. Expo: `liftoff exec --only expo,apple-developer -- eas build --platform ios --profile production --non-interactive --auto-submit`. Native: `fastlane beta` (`build_app` + `upload_to_testflight` with `app_store_connect_api_key`).
3. Add internal testers (the user) to a TestFlight group.
4. `liftoff deploy --target testflight --platform ios --version "1.0 (1)" --status live`

## Android → Play test track
Requires the Google Play service account JSON (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`).
1. The first upload of a new app must be done by hand in Play Console: if this is a new app, build the AAB, then add a blocking task "Upload the first AAB to the internal testing track in Play Console" with the file path.
2. After that: `liftoff exec --only expo,google-play -- eas submit --platform android` or `fastlane supply --track internal`.
3. Enable Play App Signing and tell the user to back up the upload key (task).
4. New personal developer accounts need a closed test with 12 testers for 14 days before production: add that as a blocking task with the start date.
5. Optionally also distribute via Firebase App Distribution for quick testers.
6. `liftoff deploy --target play-internal --platform android --version "1.0 (1)" --status live`

Never submit for production review without asking.

Record: `liftoff step testflight done` / `liftoff step play-testing done`; tick `beta-ios`, `beta-ios-testers`, `beta-android`, `beta-android-signing`, `ci-versioning`.
