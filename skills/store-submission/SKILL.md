---
name: store-submission
description: Write the App Store and Google Play listings from the app, make captioned screenshots, and upload the metadata with fastlane or the store APIs, stopping before Submit for the user's approval. Used by the store listing launch step.
---

# Store listing and submission

The listing is the main lever on downloads, and every rejection costs one to three days. Run `liftoff scan` first and fix what it finds (the store-readiness skill).

## 1. Write the listing (into `store/`)
From what the app actually does, in the user's voice:
- **App Store** (`store/ios/metadata/en-US/`, fastlane `deliver` layout): `name.txt` (30 chars, include the main keyword), `subtitle.txt` (30), `keywords.txt` (100 chars, comma-separated, no spaces, no words already in the name, no competitor names), `description.txt`, `promotional_text.txt` (170), `release_notes.txt`, `privacy_url.txt`, `support_url.txt`, `marketing_url.txt`.
- **Google Play** (`store/android/metadata/android/en-US/`, fastlane `supply` layout): `title.txt` (30), `short_description.txt` (80), `full_description.txt` (4000, keywords used naturally, no keyword stuffing).
Show the user the name, subtitle and keywords before uploading. Count characters; the stores reject over-length fields.

## 2. Screenshots
- Capture from the simulator/emulator on the core screens with realistic sample data (never lorem ipsum): iPhone 6.9" (1320×2868) and 6.5" (1284×2778); Android phone (1080×1920 or larger).
- Add a short caption above each (benefit, not feature: "Plan a trip in a minute"), in the app's colours. Generate the framed images with a script (HTML + Playwright screenshot works well), into `store/ios/screenshots/en-US/` and `store/android/metadata/android/en-US/images/phoneScreenshots/`.
- First two screenshots carry most of the conversion: put the core action and the result first.

## 3. Upload metadata (not submit)
- iOS: `liftoff exec --only apple-developer -- fastlane deliver --skip_binary_upload --submit_for_review false --force` with an App Store Connect API key (or the App Store Connect API directly). Attach the in-app purchases to the version.
- Android: `liftoff exec --only google-play -- fastlane supply --skip_upload_apk --skip_upload_aab --track internal`.
- Fill the age rating, privacy nutrition labels and data safety form from the drafts the store-readiness step wrote; anything only the console accepts becomes a task with the exact answers.

## 4. Stop before Submit
Add the task `Submit <App> for review` (blocks release) with what's in this version, and tell the user. Submitting is their call; when they say go, submit (`deliver --submit_for_review true` / Play Console promotion) and record `liftoff deploy --target app-store --platform ios --version <v> --status in-review`.

Record: `liftoff step store-listing done`; tick `ios-listing`, `ios-screens`, `play-listing`, `play-listing-upload`.
