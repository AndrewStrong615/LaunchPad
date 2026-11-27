// The launch steps `/liftoff:onboard` runs, the accounts they need, and
// the release-readiness checklist shown in Mission Control.

// Third-party accounts. Each one is connected once and reused by every app.
export const ACCOUNTS = {
  'apple-developer': { label: 'Apple Developer', env: ['APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_KEY'], note: '$99 a year', url: 'https://developer.apple.com/programs/enroll/' },
  'google-play': { label: 'Google Play Console', env: ['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'], note: '$25 once', url: 'https://play.google.com/console/signup' },
  stripe: { label: 'Stripe', env: ['STRIPE_SECRET_KEY'], note: 'verify your business', url: 'https://dashboard.stripe.com/apikeys' },
  revenuecat: { label: 'RevenueCat', env: ['REVENUECAT_API_KEY'], note: 'mobile subscriptions', url: 'https://app.revenuecat.com/' },
  vercel: { label: 'Vercel', env: ['VERCEL_TOKEN'], note: 'link your repo', url: 'https://vercel.com/account/tokens' },
  cloudflare: { label: 'Cloudflare', env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], note: 'alternative host', url: 'https://dash.cloudflare.com/profile/api-tokens' },
  supabase: { label: 'Supabase', env: ['SUPABASE_ACCESS_TOKEN'], note: 'database and auth', url: 'https://supabase.com/dashboard/account/tokens' },
  posthog: { label: 'PostHog', env: ['POSTHOG_PERSONAL_API_KEY'], note: 'copy the API key', url: 'https://app.posthog.com/settings/user-api-keys' },
  sentry: { label: 'Sentry', env: ['SENTRY_AUTH_TOKEN'], note: 'crash reports', url: 'https://sentry.io/settings/account/api/auth-tokens/' },
  github: { label: 'GitHub', env: ['GITHUB_TOKEN'], note: 'CI/CD and secrets', url: 'https://github.com/settings/tokens' },
  expo: { label: 'Expo (EAS)', env: ['EXPO_TOKEN'], note: 'cloud builds', url: 'https://expo.dev/settings/access-tokens' },
};

// Launch steps, in the order onboarding runs them.
// `platforms` limits a step to apps that ship there; `skill` is the plugin skill that does the work.
export const STEPS = [
  { id: 'payments', label: 'Payments', skill: 'payments', accounts: ['stripe'] },
  { id: 'paywall', label: 'Paywall', skill: 'payments', accounts: { web: ['stripe'], ios: ['revenuecat'], android: ['revenuecat'] } },
  { id: 'hosting', label: 'Hosting + domain', skill: 'hosting', platforms: ['web'], accounts: ['vercel'] },
  { id: 'analytics', label: 'Analytics', skill: 'analytics', accounts: ['posthog'] },
  { id: 'crashes', label: 'Crash reports', skill: 'crash-reports', accounts: ['sentry'] },
  { id: 'cicd', label: 'CI/CD', skill: 'ci-cd', accounts: ['github'] },
  { id: 'landing', label: 'Landing page', skill: 'landing-page', accounts: [] },
  { id: 'testflight', label: 'TestFlight build', skill: 'beta-builds', platforms: ['ios'], accounts: ['apple-developer'] },
  { id: 'play-testing', label: 'Play testing', skill: 'beta-builds', platforms: ['android'], accounts: ['google-play'] },
  { id: 'store-checks', label: 'Store checks', skill: 'store-readiness', platforms: ['ios', 'android'], accounts: [] },
];

export const STEP_STATUSES = ['todo', 'running', 'done', 'skipped', 'blocked'];

export function stepsFor(platforms) {
  return STEPS.filter((s) => !s.platforms || s.platforms.some((p) => platforms.includes(p)));
}

export function accountsForStep(step, platforms) {
  if (Array.isArray(step.accounts)) return step.accounts;
  const set = new Set();
  for (const p of platforms) for (const a of step.accounts[p] || []) set.add(a);
  return [...set];
}

export function accountsFor(platforms) {
  const set = new Set();
  for (const step of stepsFor(platforms)) for (const a of accountsForStep(step, platforms)) set.add(a);
  return [...set];
}

// Release-readiness checklist. `auto` names a check that can be verified
// from the repo; everything else is ticked by Claude or by hand.
const C = (category, id, title, extra = {}) => ({ category, id, title, ...extra });

export const CHECKLIST = [
  C('Payments and paywall', 'pay-products', 'Products and prices created in test mode'),
  C('Payments and paywall', 'pay-sdk', 'Payments SDK installed', { auto: 'payments-sdk' }),
  C('Payments and paywall', 'pay-webhook', 'Webhook endpoint verifies signatures'),
  C('Payments and paywall', 'pay-restore', 'Restore purchases works', { platforms: ['ios', 'android'] }),
  C('Payments and paywall', 'pay-entitlement', 'Pro features check the entitlement, not the client'),
  C('Payments and paywall', 'pay-live', 'Live keys swapped in for production'),
  C('Payments and paywall', 'pay-portal', 'Customers can manage or cancel their plan'),

  C('Hosting and domain', 'host-deploy', 'Production deploy is live', { platforms: ['web'] }),
  C('Hosting and domain', 'host-domain', 'Custom domain points at the host', { platforms: ['web'] }),
  C('Hosting and domain', 'host-https', 'HTTPS on, www redirects to the apex (or back)', { platforms: ['web'] }),
  C('Hosting and domain', 'host-env', 'Production environment variables set', { platforms: ['web'] }),
  C('Hosting and domain', 'host-previews', 'Preview deploys for pull requests', { platforms: ['web'] }),

  C('Analytics and crashes', 'ana-sdk', 'Analytics SDK installed', { auto: 'analytics-sdk' }),
  C('Analytics and crashes', 'ana-events', 'Key events tracked: sign up, upgrade, core action'),
  C('Analytics and crashes', 'ana-identify', 'Users identified after sign in'),
  C('Analytics and crashes', 'crash-sdk', 'Crash reporting SDK installed', { auto: 'crash-sdk' }),
  C('Analytics and crashes', 'crash-sourcemaps', 'Source maps or dSYMs uploaded on release'),
  C('Analytics and crashes', 'crash-alerts', 'Alert on new crash types'),

  C('Builds and releases', 'ci-workflow', 'CI workflow runs on every push', { auto: 'ci-workflow' }),
  C('Builds and releases', 'ci-tests', 'Tests run before anything ships'),
  C('Builds and releases', 'ci-deploy', 'Pushing to main deploys to production'),
  C('Builds and releases', 'ci-secrets', 'Secrets stored in CI, not in the repo'),
  C('Builds and releases', 'ci-versioning', 'Build numbers bump automatically', { platforms: ['ios', 'android'] }),
  C('Builds and releases', 'beta-ios', 'TestFlight build uploaded', { platforms: ['ios'] }),
  C('Builds and releases', 'beta-ios-testers', 'Internal testers invited', { platforms: ['ios'] }),
  C('Builds and releases', 'beta-android', 'Internal testing track build uploaded', { platforms: ['android'] }),
  C('Builds and releases', 'beta-android-signing', 'Play App Signing set up and upload key backed up', { platforms: ['android'] }),

  C('Landing page', 'land-page', 'Landing page live with a clear headline'),
  C('Landing page', 'land-cta', 'Download or sign-up button works'),
  C('Landing page', 'land-og', 'Social preview image and meta tags'),
  C('Landing page', 'land-legal', 'Privacy policy and terms pages', { auto: 'legal-pages' }),
  C('Landing page', 'land-support', 'Support email or contact page'),

  C('App Store', 'ios-screens', 'Screenshots at 6.9" and 6.5"', { platforms: ['ios'] }),
  C('App Store', 'ios-privacy-url', 'Privacy policy URL', { platforms: ['ios'] }),
  C('App Store', 'ios-age', 'Age rating questionnaire', { platforms: ['ios'] }),
  C('App Store', 'ios-delete', 'Account deletion in the app', { platforms: ['ios'] }),
  C('App Store', 'ios-review-notes', 'App Review notes and demo login', { platforms: ['ios'] }),
  C('App Store', 'ios-nutrition', 'Privacy nutrition labels filled in', { platforms: ['ios'] }),
  C('App Store', 'ios-iap-review', 'In-app purchases attached to the version', { platforms: ['ios'] }),
  C('App Store', 'ios-export', 'Export compliance answered', { platforms: ['ios'] }),

  C('Google Play', 'play-listing', 'Store listing: icon, feature graphic, screenshots', { platforms: ['android'] }),
  C('Google Play', 'play-data-safety', 'Data safety form', { platforms: ['android'] }),
  C('Google Play', 'play-content', 'Content rating questionnaire', { platforms: ['android'] }),
  C('Google Play', 'play-target', 'Target audience and ads declaration', { platforms: ['android'] }),
  C('Google Play', 'play-delete', 'Account deletion URL', { platforms: ['android'] }),
  C('Google Play', 'play-testers', 'Closed test with 12 testers for 14 days (new personal accounts)', { platforms: ['android'] }),

  C('Security and safety', 'sec-keys', 'No secret keys in the client bundle'),
  C('Security and safety', 'sec-rls', 'Database row-level security on'),
  C('Security and safety', 'sec-rate', 'Rate limits on auth and paid endpoints'),
  C('Security and safety', 'sec-spend', 'Spend caps on pay-per-use services'),
  C('Security and safety', 'sec-backup', 'Database backups on'),
  C('Security and safety', 'sec-confirm', 'Claude asks before money, DNS or store actions'),
];

export function checklistFor(platforms) {
  return CHECKLIST.filter((c) => !c.platforms || c.platforms.some((p) => platforms.includes(p)));
}

export function autoCheck(key, detected, files) {
  const i = detected.integrations;
  switch (key) {
    case 'payments-sdk':
      return i.stripe || i.revenuecat;
    case 'analytics-sdk':
      return i.posthog;
    case 'crash-sdk':
      return i.sentry;
    case 'ci-workflow':
      return i.githubActions;
    case 'legal-pages':
      return files.some((f) => /privacy/i.test(f)) && files.some((f) => /terms/i.test(f));
    default:
      return false;
  }
}
