// The launch steps `/liftoff:launch` runs, the accounts they need, and
// the release-readiness checklist shown on the Flight Board. Steps, checks
// and paperwork fit an app by the platforms it ships to and by what it does
// (lib/profile.mjs): an app that takes no payments gets no payment steps.
import { ALL_FEATURES } from './profile.mjs';

// Third-party accounts. Each one is connected once and reused by every app.
// `category` says which launch step it can serve (see PROVIDERS below).
export const ACCOUNTS = {
  'apple-developer': { label: 'Apple Developer', category: 'stores', env: ['APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID', 'APP_STORE_CONNECT_KEY'], note: '$99/year membership', url: 'https://developer.apple.com/programs/enroll/' },
  'google-play': { label: 'Google Play Console', category: 'stores', env: ['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'], note: '$25 one-time fee', url: 'https://play.google.com/console/signup' },
  stripe: { label: 'Stripe', category: 'payments', env: ['STRIPE_SECRET_KEY'], note: 'payouts need business details', url: 'https://dashboard.stripe.com/apikeys' },
  paddle: { label: 'Paddle', category: 'payments', env: ['PADDLE_API_KEY'], note: 'payments, handles sales tax for you', url: 'https://vendors.paddle.com/authentication-v2' },
  polar: { label: 'Polar', category: 'payments', env: ['POLAR_ACCESS_TOKEN'], note: 'payments, handles sales tax for you', url: 'https://polar.sh/dashboard' },
  lemonsqueezy: { label: 'Lemon Squeezy', category: 'payments', env: ['LEMONSQUEEZY_API_KEY'], note: 'shutting down March 31, 2027', url: 'https://app.lemonsqueezy.com/settings/api' },
  revenuecat: { label: 'RevenueCat', category: 'payments', env: ['REVENUECAT_API_KEY'], note: 'mobile subscriptions', url: 'https://app.revenuecat.com/' },
  vercel: { label: 'Vercel', category: 'hosting', env: ['VERCEL_TOKEN'], note: 'web hosting', url: 'https://vercel.com/account/tokens' },
  netlify: { label: 'Netlify', category: 'hosting', env: ['NETLIFY_AUTH_TOKEN'], note: 'web hosting', url: 'https://app.netlify.com/user/applications#personal-access-tokens' },
  cloudflare: { label: 'Cloudflare', category: 'hosting', env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'], note: 'alternative host', url: 'https://dash.cloudflare.com/profile/api-tokens' },
  supabase: { label: 'Supabase', category: 'database', env: ['SUPABASE_ACCESS_TOKEN'], note: 'database and auth', url: 'https://supabase.com/dashboard/account/tokens' },
  firebase: { label: 'Firebase', category: 'database', env: ['FIREBASE_SERVICE_ACCOUNT_JSON'], note: 'database, sign-in and hosting', url: 'https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk' },
  neon: { label: 'Neon', category: 'database', env: ['NEON_API_KEY'], note: 'Postgres database', url: 'https://console.neon.tech/app/settings/api-keys' },
  clerk: { label: 'Clerk', category: 'auth', env: ['CLERK_SECRET_KEY'], note: 'sign-in and user accounts', url: 'https://dashboard.clerk.com/last-active?path=api-keys' },
  posthog: { label: 'PostHog', category: 'analytics', env: ['POSTHOG_PERSONAL_API_KEY'], note: 'product analytics', url: 'https://app.posthog.com/settings/user-api-keys' },
  sentry: { label: 'Sentry', category: 'crashes', env: ['SENTRY_AUTH_TOKEN'], note: 'crash tracking', url: 'https://sentry.io/settings/account/api/auth-tokens/' },
  github: { label: 'GitHub', category: 'builds', env: ['GITHUB_TOKEN'], note: 'CI/CD and secrets', url: 'https://github.com/settings/tokens' },
  expo: { label: 'Expo (EAS)', category: 'builds', env: ['EXPO_TOKEN'], note: 'cloud builds', url: 'https://expo.dev/settings/access-tokens' },
  resend: { label: 'Resend', category: 'email', env: ['RESEND_API_KEY'], note: 'transactional email', url: 'https://resend.com/api-keys' },
  sendgrid: { label: 'SendGrid', category: 'email', env: ['SENDGRID_API_KEY'], note: 'transactional email', url: 'https://app.sendgrid.com/settings/api_keys' },
  postmark: { label: 'Postmark', category: 'email', env: ['POSTMARK_SERVER_TOKEN'], note: 'transactional email', url: 'https://account.postmarkapp.com/servers' },
};

// What a step can be built on. The first entry is the default; the others
// stand in for it when the app's code already uses them (each pair is the
// account id and the detection flag from lib/detect.mjs). Sign-in has no
// default account: Supabase Auth, Auth.js and Better Auth need none.
export const PROVIDERS = {
  database: [['supabase', 'supabase'], ['firebase', 'firebase'], ['neon', 'neon']],
  auth: [['clerk', 'clerk'], ['firebase', 'firebaseAuth']],
  hosting: [['vercel', 'vercel'], ['netlify', 'netlify'], ['cloudflare', 'cloudflare'], ['firebase', 'firebaseHosting']],
  payments: [['stripe', 'stripe'], ['paddle', 'paddle'], ['polar', 'polar'], ['lemonsqueezy', 'lemonsqueezy']],
  email: [['resend', 'resend'], ['sendgrid', 'sendgrid'], ['postmark', 'postmark']],
  analytics: [['posthog', 'posthog']],
  crashes: [['sentry', 'sentry']],
};
export const CATEGORIES = { payments: 'Payments', auth: 'Sign-in', database: 'Database', hosting: 'Hosting', email: 'Email', analytics: 'Analytics', crashes: 'Crash tracking', other: 'Something else' };

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The service an app uses for each category: what a finished step recorded,
// else what the code uses, else one of the user's own services for that
// category (`custom`: [{ id, name, category }]), else nothing (the step's
// default account applies).
export function usesOf(state, { custom = [] } = {}) {
  const uses = {};
  const i = state?.integrations || {};
  for (const [cat, list] of Object.entries(PROVIDERS)) {
    const recorded = Object.entries(STEP_CATEGORY).filter(([, c]) => c === cat).map(([id]) => state?.steps?.[id]?.provider).find(Boolean);
    const own = custom.filter((c) => c.category === cat);
    const named = recorded && (list.find(([id]) => squash(id) === squash(recorded) || squash(ACCOUNTS[id]?.label) === squash(recorded))?.[0] || own.find((c) => squash(c.name) === squash(recorded) || c.id === recorded)?.id);
    const detected = list.find(([, flag]) => i[flag])?.[0];
    const pick = named || detected || own[0]?.id;
    if (pick) uses[cat] = pick;
  }
  return uses;
}

// Launch steps. `needs` lists steps that must be finished first (only the
// ones that apply to the app count), and `/liftoff:launch` runs them in that order.
// `platforms` limits a step to apps that ship there and `features` to apps
// that do one of those things; `skill` is the plugin skill that does the
// work; `does` is what `liftoff plan --explain` prints.
export const STEPS = [
  { id: 'database', label: 'Database', skill: 'database', features: ['database'], accounts: ['supabase'], needs: [],
    does: 'Creates the database and tables with row-level security, plus backups.' },
  { id: 'auth', label: 'Sign-in', skill: 'auth', features: ['accounts'], accounts: [], needs: ['database'],
    does: 'Adds sign-up and sign-in (email + social, Sign in with Apple when required) and server-side account deletion.' },
  { id: 'hosting', label: 'Deploy and domain', skill: 'hosting', platforms: ['web'], accounts: ['vercel'], needs: [],
    does: 'Deploys to production with env vars and preview deploys; connects your domain after you approve DNS.' },
  { id: 'payments', label: 'Payments', skill: 'payments', features: ['payments'], accounts: ['stripe'], needs: ['auth', 'hosting'],
    does: 'Creates products and prices in test mode, checkout, billing portal and a verified webhook at the live URL.' },
  { id: 'paywall', label: 'Paywall', skill: 'payments', features: ['payments'], accounts: { web: ['stripe'], ios: ['revenuecat'], android: ['revenuecat'] }, needs: ['payments'],
    does: 'Adds the upgrade screen, the Pro gate that reads the server entitlement, and Restore Purchases on mobile.' },
  { id: 'email', label: 'Email', skill: 'email', features: ['email'], accounts: ['resend'], needs: ['auth'],
    does: 'Sends welcome, receipt and password reset emails from your domain with SPF and DKIM.' },
  { id: 'safety', label: 'Abuse and spend limits', skill: 'safety', features: ['ai', 'uploads', 'community'], accounts: [], needs: ['auth'],
    does: 'Keeps AI calls on the server with per-user limits, limits uploads by size and type, and adds report and block for what people post.' },
  { id: 'analytics', label: 'Analytics', skill: 'analytics', accounts: ['posthog'], needs: ['auth'],
    does: 'Installs PostHog, tracks the funnel (sign up, activation, paywall, upgrade) and identifies users.' },
  { id: 'crashes', label: 'Crash tracking', skill: 'crash-reports', accounts: ['sentry'], needs: [],
    does: 'Installs Sentry with releases, source maps or dSYMs, and an alert for new issues.' },
  { id: 'cicd', label: 'CI/CD', skill: 'ci-cd', accounts: ['github'], needs: ['hosting'],
    does: 'GitHub Actions: build and test every push, deploy main, mobile builds on tags.' },
  { id: 'money-test', label: 'Purchase flow test', skill: 'money-path-test', features: ['payments'], accounts: [], needs: ['paywall', 'cicd'],
    does: 'Adds an end-to-end test that buys Pro with a test card, checks it unlocks, cancels and checks it locks again.' },
  { id: 'monitoring', label: 'Uptime + alerts', skill: 'monitoring', accounts: [], needs: ['crashes'],
    does: 'Adds a health endpoint, an uptime check and alerts for downtime, crash spikes, failed webhooks and failed payments.' },
  { id: 'landing', label: 'Landing page', skill: 'landing-page', accounts: [], needs: ['hosting'],
    does: 'Builds the landing page with email capture, privacy, terms and social previews.' },
  { id: 'growth', label: 'Growth basics', skill: 'growth', accounts: [], needs: ['analytics', 'landing'],
    does: 'Adds a review prompt, in-app feedback, the activation event and a launch kit (Product Hunt, posts, press kit).' },
  { id: 'testflight', label: 'TestFlight beta', skill: 'beta-builds', platforms: ['ios'], accounts: ['apple-developer'], needs: ['cicd'],
    does: 'Builds and uploads to TestFlight and invites you as a tester.' },
  { id: 'play-testing', label: 'Play test track', skill: 'beta-builds', platforms: ['android'], accounts: ['google-play'], needs: ['cicd'],
    does: 'Uploads to the Play internal testing track with Play App Signing.' },
  { id: 'store-checks', label: 'Review pre-check', skill: 'store-readiness', platforms: ['ios', 'android'], accounts: [], needs: ['landing', 'paywall'],
    does: 'Runs the rejection pre-scan and fixes what it finds: purpose strings, account deletion, review notes, export compliance.' },
  { id: 'store-listing', label: 'Store listing', skill: 'store-submission', platforms: ['ios', 'android'], accounts: [], needs: ['store-checks', 'testflight', 'play-testing'],
    does: 'Writes the listing, makes captioned screenshots and uploads the metadata. Stops before Submit for your approval.' },
];

export const STEP_STATUSES = ['todo', 'running', 'done', 'skipped', 'blocked'];

// Whether a step, check or paperwork item fits an app: it ships to one of the
// item's platforms, and does one of the item's features. Leaving out
// `features` counts every feature as on (the full launch).
export function fits(item, platforms, features = ALL_FEATURES) {
  if (item.platforms && !item.platforms.some((p) => platforms.includes(p))) return false;
  if (item.features && !item.features.some((f) => features[f])) return false;
  return true;
}

export function stepsFor(platforms, features = ALL_FEATURES) {
  return orderByNeeds(STEPS.filter((s) => fits(s, platforms, features)));
}

// The steps a step waits on, limited to those that apply to this app.
export function needsFor(step, platforms, features = ALL_FEATURES) {
  const ids = new Set(STEPS.filter((s) => fits(s, platforms, features)).map((s) => s.id));
  return (step.needs || []).filter((id) => ids.has(id));
}

// Stable topological order: keeps catalog order, but never puts a step before what it needs.
export function orderByNeeds(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();
  const visiting = new Set();
  const visit = (s) => {
    if (seen.has(s.id)) return;
    if (visiting.has(s.id)) throw new Error(`Step dependency cycle at "${s.id}"`);
    visiting.add(s.id);
    for (const n of s.needs || []) if (byId.has(n)) visit(byId.get(n));
    visiting.delete(s.id);
    seen.add(s.id);
    out.push(s);
  };
  for (const s of steps) visit(s);
  return out;
}

// The category of service each step is built on (paywall sells through the
// same provider as payments).
export const STEP_CATEGORY = { database: 'database', auth: 'auth', hosting: 'hosting', payments: 'payments', paywall: 'payments', email: 'email', analytics: 'analytics', crashes: 'crashes' };

// The accounts a step needs. `uses` (from usesOf) swaps the step's default
// account for the one the app already uses: Paddle instead of Stripe, Neon
// instead of Supabase, or one of the user's own services.
export function accountsForStep(step, platforms, uses = {}) {
  let base;
  if (Array.isArray(step.accounts)) base = step.accounts;
  else {
    const set = new Set();
    for (const p of platforms) for (const a of step.accounts[p] || []) set.add(a);
    base = [...set];
  }
  const cat = STEP_CATEGORY[step.id];
  const pick = cat && uses[cat];
  if (!pick) return base;
  // Mobile stores sell through RevenueCat whatever the web uses.
  if (step.id === 'paywall' && !platforms.includes('web')) return base;
  const defaults = new Set(PROVIDERS[cat].map(([id]) => id));
  return [...new Set([...base.filter((a) => !defaults.has(a)), pick])];
}

export function accountsFor(platforms, features = ALL_FEATURES, uses = {}) {
  const set = new Set();
  for (const step of stepsFor(platforms, features)) for (const a of accountsForStep(step, platforms, uses)) set.add(a);
  return [...set];
}

// Slow, human-only paperwork. Added as dated tasks the first time an app is
// read, so it runs in parallel with the build instead of stalling the launch.
// `when(platforms, features, providers)` decides whether it applies (providers:
// the payment services the code uses); `days` is the typical lead time.
// Paperwork that stops applying (the owner says the app takes no payments)
// leaves the task list while it's open.
export const PAPERWORK = [
  { key: 'apple-enroll', title: 'Enroll in the Apple Developer Program ($99/yr). Organizations need a D-U-N-S number first.', days: '1–2 days (D-U-N-S: up to 2 weeks)', blocks: true,
    url: 'https://developer.apple.com/programs/enroll/', when: (p) => p.includes('ios') },
  { key: 'apple-paid-apps', title: 'Sign the Paid Apps Agreement and add banking and tax info in App Store Connect. In-app purchases do not load until it is active.', days: '1–3 days', blocks: true,
    url: 'https://appstoreconnect.apple.com/business', when: (p, f) => p.includes('ios') && f.payments },
  { key: 'play-verify', title: 'Create a Google Play developer account ($25) and finish identity verification.', days: '2–7 days', blocks: true,
    url: 'https://play.google.com/console/signup', when: (p) => p.includes('android') },
  { key: 'play-closed-test', title: 'Start the 12-tester closed test on Google Play (new personal accounts must run it 14 days before production).', days: '14 days', blocks: true,
    url: 'https://support.google.com/googleplay/android-developer/answer/14151465', when: (p) => p.includes('android') },
  { key: 'play-merchant', title: 'Set up a Google Play payments profile (merchant account) for in-app subscriptions.', days: '1–3 days', blocks: true,
    url: 'https://support.google.com/googleplay/android-developer/answer/7161426', when: (p, f) => p.includes('android') && f.payments },
  { key: 'stripe-activate', title: 'Activate your Stripe account: business details, bank account for payouts, identity check.', days: '1–3 days', blocks: true,
    url: 'https://dashboard.stripe.com/account/onboarding', when: (p, f, pay) => p.includes('web') && f.payments && (!pay.length || pay.includes('stripe')) },
  { key: 'ai-spend-cap', title: 'Set a monthly spend limit with your AI provider (the billing or limits page of OpenAI, Anthropic or Google AI Studio), so a bug or a flood of requests can’t run up the bill.', days: '5 minutes', blocks: false,
    url: null, when: (p, f) => f.ai },
  { key: 'domain', title: 'Pick and buy a domain for the app (DNS can take up to 48 hours to spread).', days: 'same day, DNS up to 48 hours', blocks: false,
    url: null, when: () => true },
  // A heads-up rather than paperwork: nothing to start today, but the app can't
  // keep selling through it.
  { key: 'lemonsqueezy-shutdown', title: 'Lemon Squeezy takes no new sign-ups and shuts down on March 31, 2027. Plan the move to Stripe, Paddle or Polar before then.', days: 'before March 31, 2027', blocks: false, notice: true,
    url: 'https://www.lemonsqueezy.com/blog/2026-update', when: (p, f, pay) => pay.includes('lemonsqueezy') },
];

export function paperworkFor(platforms, features = ALL_FEATURES, providers = []) {
  return PAPERWORK.filter((w) => w.when(platforms, features, providers));
}
export const PAPERWORK_KEYS = new Set(PAPERWORK.map((w) => w.key));

const path_sep = /[\\/]/;

// Release-readiness checklist. `auto` names a check that can be verified
// from the repo; everything else is ticked by Claude or by hand. Like steps,
// `platforms` and `features` limit an item to the apps it fits.
const C = (category, id, title, extra = {}) => ({ category, id, title, ...extra });
const PAY = { features: ['payments'] };
const SIGN_IN = { features: ['accounts'] };

export const CHECKLIST = [
  C('Payments and paywall', 'pay-products', 'Products and prices created in test mode', PAY),
  C('Payments and paywall', 'pay-sdk', 'Payments SDK installed', { auto: 'payments-sdk', ...PAY }),
  C('Payments and paywall', 'pay-webhook', 'Webhook endpoint verifies signatures', PAY),
  C('Payments and paywall', 'pay-restore', 'Restore purchases works', { platforms: ['ios', 'android'], ...PAY }),
  C('Payments and paywall', 'pay-entitlement', 'Pro features check the entitlement, not the client', PAY),
  C('Payments and paywall', 'pay-live', 'Live keys swapped in for production', PAY),
  C('Payments and paywall', 'pay-portal', 'Customers can manage or cancel their plan', PAY),
  C('Payments and paywall', 'pay-e2e', 'Purchase flow tested end to end (buy, unlock, cancel, lock)', PAY),
  C('Payments and paywall', 'pay-alerts', 'Alerts for failed webhooks and failed payments', PAY),

  C('Accounts and email', 'auth-signin', 'Sign up and sign in work', SIGN_IN),
  C('Accounts and email', 'auth-apple', 'Sign in with Apple offered next to other social sign-in', { platforms: ['ios'], ...SIGN_IN }),
  C('Accounts and email', 'auth-delete', 'Account deletion removes server data', SIGN_IN),
  C('Accounts and email', 'email-domain', 'Email domain has SPF and DKIM records', { features: ['email'] }),
  C('Accounts and email', 'email-flows', 'Welcome, receipt and password reset emails send', { features: ['email'] }),

  C('Hosting and domain', 'host-deploy', 'Production deploy is live', { platforms: ['web'] }),
  C('Hosting and domain', 'host-domain', 'Custom domain points at the host', { platforms: ['web'] }),
  C('Hosting and domain', 'host-https', 'HTTPS on, www redirects to the apex (or back)', { platforms: ['web'] }),
  C('Hosting and domain', 'host-env', 'Production environment variables set', { platforms: ['web'] }),
  C('Hosting and domain', 'host-previews', 'Preview deploys for pull requests', { platforms: ['web'] }),

  C('Analytics and crashes', 'ana-sdk', 'Analytics SDK installed', { auto: 'analytics-sdk' }),
  C('Analytics and crashes', 'ana-events', 'Key events tracked: sign up, upgrade, core action'),
  C('Analytics and crashes', 'ana-identify', 'Users identified after sign in', SIGN_IN),
  C('Analytics and crashes', 'crash-sdk', 'Crash reporting SDK installed', { auto: 'crash-sdk' }),
  C('Analytics and crashes', 'crash-sourcemaps', 'Source maps or dSYMs uploaded on release'),
  C('Analytics and crashes', 'crash-alerts', 'Alert on new crash types'),
  C('Analytics and crashes', 'mon-uptime', 'Uptime check on the live URL or API', { auto: 'uptime-workflow' }),
  C('Analytics and crashes', 'mon-alerts', 'Alerts for downtime and crash spikes'),

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
  C('Landing page', 'land-capture', 'Email capture or waitlist on the landing page'),

  C('Growth', 'grow-review', 'Store review prompt after a success moment', { platforms: ['ios', 'android'] }),
  C('Growth', 'grow-feedback', 'In-app feedback link'),
  C('Growth', 'grow-activation', 'Activation event defined and tracked'),
  C('Growth', 'grow-kit', 'Launch kit drafted (Product Hunt, posts, press kit)'),

  C('App Store', 'ios-purpose', 'Every permission prompt explains why the app needs it', { platforms: ['ios'] }),
  C('App Store', 'ios-delete', 'People can delete their account from inside the app', { platforms: ['ios'], ...SIGN_IN }),
  C('App Store', 'ios-iap-review', 'In-app purchases attached to the version', { platforms: ['ios'], ...PAY }),
  C('App Store', 'ios-nutrition', 'Privacy nutrition labels filled in', { platforms: ['ios'] }),
  C('App Store', 'ios-privacy-url', 'Privacy policy linked in App Store Connect', { platforms: ['ios'] }),
  C('App Store', 'ios-export', 'Export compliance answered', { platforms: ['ios'] }),
  C('App Store', 'ios-age', 'Content questions for the age rating answered', { platforms: ['ios'] }),
  C('App Store', 'ios-review-notes', 'Notes for the reviewer, with a working demo account if the app has sign-in', { platforms: ['ios'] }),
  C('App Store', 'ios-screens', 'iPhone screenshots in both required sizes', { platforms: ['ios'] }),
  C('App Store', 'ios-listing', 'Listing uploaded: name, subtitle, keywords, description', { platforms: ['ios'] }),

  C('Google Play', 'play-listing', 'Store listing: icon, feature graphic, screenshots', { platforms: ['android'] }),
  C('Google Play', 'play-data-safety', 'Data safety form', { platforms: ['android'] }),
  C('Google Play', 'play-content', 'Content rating questionnaire', { platforms: ['android'] }),
  C('Google Play', 'play-target', 'Target audience and ads declaration', { platforms: ['android'] }),
  C('Google Play', 'play-delete', 'Account deletion URL', { platforms: ['android'], ...SIGN_IN }),
  C('Google Play', 'play-listing-upload', 'Listing text uploaded to Play Console', { platforms: ['android'] }),
  C('Google Play', 'play-testers', 'Closed test with 12 testers for 14 days (new personal accounts)', { platforms: ['android'] }),

  C('Security and safety', 'sec-keys', 'No secret keys in the client bundle'),
  C('Security and safety', 'sec-rls', 'Database row-level security on', { features: ['database'] }),
  C('Security and safety', 'sec-rate', 'Rate limits on auth and paid endpoints', { features: ['accounts', 'payments', 'ai'] }),
  C('Security and safety', 'sec-spend', 'Spend caps on pay-per-use services', { features: ['database', 'ai', 'uploads'] }),
  C('Security and safety', 'sec-backup', 'Database backups on', { features: ['database'] }),
  C('Security and safety', 'sec-confirm', 'Liftoff asks before money, DNS or store actions'),

  // Extra checks for apps that do more.
  C('AI features', 'ai-server', 'AI calls go through your server, never straight from the app', { features: ['ai'] }),
  C('AI features', 'ai-limits', 'Each person has a limit on AI requests', { features: ['ai'] }),
  C('AI features', 'ai-errors', 'The app copes when the AI is slow, down or says no', { features: ['ai'] }),

  C('Uploads', 'up-limits', 'Uploads are limited by size and file type', { features: ['uploads'] }),
  C('Uploads', 'up-private', 'Uploaded files are private unless meant to be shared', { features: ['uploads'] }),

  C('What people post', 'ugc-report', 'People can report posts and block other users', { features: ['community'] }),
  C('What people post', 'ugc-filter', 'Objectionable content is filtered before others see it', { features: ['community'] }),
  C('What people post', 'ugc-remove', 'You can remove content and ban accounts quickly', { features: ['community'] }),
  C('What people post', 'ugc-terms', 'Terms forbid abuse, and people agree to them when they join', { features: ['community'] }),
];

export function checklistFor(platforms, features = ALL_FEATURES) {
  return CHECKLIST.filter((c) => fits(c, platforms, features));
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
    case 'uptime-workflow':
      return files.some((f) => /\.github\/workflows\/.*uptime.*\.ya?ml$/.test(f.split(path_sep).join('/')));
    case 'legal-pages':
      return files.some((f) => /privacy/i.test(f)) && files.some((f) => /terms/i.test(f));
    default:
      return false;
  }
}
