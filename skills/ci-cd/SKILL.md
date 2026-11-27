---
name: ci-cd
description: Set up GitHub Actions so every push builds and tests, main deploys to production, and mobile builds go to testers. Used by the CI/CD launch step.
---

# CI/CD on GitHub

Create `.github/workflows/ci.yml`:
- Trigger on `push` and `pull_request`.
- Jobs: **Build** → **Test** → **Deploy to production** (deploy only on `main`, `needs: [build, test]`).
- Cache the package manager; use the repo's actual lint/test/build scripts (read package.json, don't invent).
- Web deploy: Vercel (`npx vercel deploy --prod --token ${{ secrets.VERCEL_TOKEN }}` with `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID`) or Cloudflare (`cloudflare/wrangler-action`).
- Upload Sentry source maps after build if Sentry is set up.

Mobile, in `.github/workflows/mobile.yml` on tags or manual dispatch:
- Expo: `expo/expo-github-action` + `eas build --platform all --auto-submit` (`EXPO_TOKEN`). Make sure `eas.json` has a `production` profile with `autoIncrement: true`.
- Native iOS/Android: fastlane lanes `beta` (TestFlight / Play internal track).

Secrets: set them with `liftoff exec --only github,<account> -- gh secret set NAME --body "$NAME"` so the values come from stored credentials and are never printed. Never commit secrets.

Verify by pushing a branch and watching the run (`gh run watch`), then `liftoff verify --only ci-tests`. Report the checks (Build, Test, Deploy) with ✓.

Once the purchase flow test exists, run it in CI on pull requests against the preview deploy (see the money-path-test skill).

Record: `liftoff step cicd done --provider github-actions`, tick `ci-workflow`, `ci-tests`, `ci-deploy`, `ci-secrets`, `ci-versioning` (mobile).
