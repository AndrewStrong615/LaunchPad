// Step order, paperwork, verify, scans, pulse, advice, costs, undo, scoped
// credentials, detection and scaffolds. No network: fetch and DNS are faked.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-imp-'));
process.env.LIFTOFF_HOME = path.join(tmp, 'home');
process.env.LIFTOFF_SECRET_STORE = 'file';
for (const k of ['STRIPE_SECRET_KEY', 'VERCEL_TOKEN', 'SENTRY_AUTH_TOKEN', 'POSTHOG_PERSONAL_API_KEY']) delete process.env[k];

const { STEPS, stepsFor } = await import('../lib/catalog.mjs');
const { detectProject } = await import('../lib/detect.mjs');
const state = await import('../lib/state.mjs');
const { runVerify, applyVerify } = await import('../lib/verify.mjs');
const { scanSecrets, storeScan } = await import('../lib/scan.mjs');
const { collectPulse, recordPulse } = await import('../lib/pulse.mjs');
const { nextAction } = await import('../lib/advice.mjs');
const { costReport } = await import('../lib/costs.mjs');
const { startServer } = await import('../lib/server.mjs');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'liftoff.mjs');
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function makeApp(name, files) {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

// A tiny fake of fetch: routes match on "METHOD url-prefix".
function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const key = Object.keys(routes).find((k) => {
      const [m, prefix] = k.split(' ');
      return m === method && String(url).startsWith(prefix);
    });
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key];
    const v = typeof r === 'function' ? r(url, opts) : r;
    if (v instanceof Response) return v.clone();
    return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

let web, expo;
before(() => {
  web = makeApp('ledger', {
    'package.json': { name: 'ledger', dependencies: { next: '15', react: '19', stripe: '17', '@supabase/supabase-js': '2' } },
    'app/page.tsx': 'export default function Home() { return null }',
  });
  expo = makeApp('greenrow', {
    'package.json': { name: 'greenrow', dependencies: { expo: '52', 'react-native': '0.76', 'expo-camera': '16', '@supabase/supabase-js': '2' } },
    'app.json': { expo: { name: 'Greenrow', ios: { infoPlist: { NSCameraUsageDescription: 'Camera' } } } },
    'src/pay.ts': "const url = 'https://checkout.stripe.com/c/pay/abc'",
  });
});

// ---------- 3. step order ----------

test('steps run in dependency order and payments waits on hosting and sign-in', () => {
  const ids = stepsFor(['web']).map((s) => s.id);
  for (const s of STEPS) for (const n of s.needs || []) {
    if (ids.includes(s.id) && ids.includes(n)) assert.ok(ids.indexOf(n) < ids.indexOf(s.id), `${n} before ${s.id}`);
  }
  assert.ok(ids.indexOf('hosting') < ids.indexOf('payments'));
  assert.ok(ids.indexOf('auth') < ids.indexOf('payments'));
  // Mobile-only apps have no hosting step, so payments only waits on sign-in.
  const s = state.initProject(expo);
  assert.deepEqual(state.waitingOn(s, 'payments'), ['auth']);
});

test('a step cannot be marked done before what it needs, unless forced', () => {
  const s = state.initProject(web);
  assert.throws(() => state.setStep(s, 'payments', 'done'), /needs auth, hosting first/);
  assert.deepEqual(state.nextSteps(s).slice(0, 3), ['database', 'hosting', 'crashes']);
  state.setStep(s, 'database', 'done');
  state.setStep(s, 'auth', 'done');
  state.setStep(s, 'hosting', 'skipped');
  state.setStep(s, 'payments', 'done');
  assert.equal(s.steps.payments.status, 'done');
  state.setStep(s, 'paywall', 'done', { force: true });
});

test('plan --explain shows order, waits and what each step does', () => {
  const out = execFileSync('node', [CLI, 'plan', '--explain', '--dir', expo]).toString();
  assert.match(out, /Payments .*waits on auth/);
  assert.match(out, /Creates products and prices in test mode/);
  assert.match(out, /without your yes/);
});

// ---------- 5. paperwork ----------

test('slow paperwork lands on the task list on day one with lead times', () => {
  const m = state.loadState(expo);
  const keys = m.tasks.map((t) => t.key).filter(Boolean);
  for (const k of ['apple-enroll', 'apple-paid-apps', 'play-verify', 'play-closed-test']) assert.ok(keys.includes(k), k);
  assert.ok(!keys.includes('stripe-activate'), 'mobile-only app pays through the stores');
  const paid = m.tasks.find((t) => t.key === 'apple-paid-apps');
  assert.equal(paid.blocksRelease, true);
  assert.match(paid.leadTime, /days/);
  assert.ok(state.loadState(web).tasks.some((t) => t.key === 'stripe-activate'));
  // First advice is to start it, before any build step.
  const a = nextAction(state.summarize(m));
  assert.equal(a.title, 'Start the slow paperwork now');
});

// ---------- 1. verify ----------

test('verify checks the live site and Stripe, ticks what passes and unticks what fails', async () => {
  const s = state.loadState(web);
  s.liveUrl = 'https://ledger.app';
  s.checklist['pay-products'].done = true; // ticked by hand earlier, but not true
  const fetch = fakeFetch({
    'GET https://ledger.app/privacy': new Response('ok'),
    'GET https://ledger.app/terms': new Response('nope', { status: 404 }),
    'GET https://ledger.app/og.png': new Response('img'),
    'GET https://ledger.app': new Response('<html><head><title>Ledger</title><meta property="og:image" content="/og.png"></head><body><h1>Ledger</h1></body></html>'),
    'GET http://ledger.app/': new Response(null, { status: 308, headers: { location: 'https://ledger.app/' } }),
    'GET https://www.ledger.app/': new Response(null, { status: 308, headers: { location: 'https://ledger.app/' } }),
    'GET https://api.stripe.com/v1/prices': { data: [] },
    'GET https://api.stripe.com/v1/webhook_endpoints': {
      data: [{ status: 'enabled', url: 'https://ledger.app/api/stripe/webhook', enabled_events: ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted'] }],
    },
    'POST https://ledger.app/api/stripe/webhook': new Response('bad signature', { status: 400 }),
  });
  const results = await runVerify(s, {
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    fetch,
    resolve4: async () => ['76.76.21.21'],
    repo: 'me/ledger',
  });
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by['host-deploy'].ok, true);
  assert.equal(by['host-https'].ok, true);
  assert.equal(by['host-domain'].ok, true);
  assert.equal(by['land-page'].ok, true);
  assert.equal(by['land-og'].ok, true);
  assert.equal(by['land-legal'].ok, false);
  assert.match(by['land-legal'].detail, /terms 404/);
  assert.equal(by['pay-webhook'].ok, true);
  assert.equal(by['pay-products'].ok, false);
  assert.equal(by['ci-tests'].ok, null, 'GitHub not connected → skipped, not failed');
  applyVerify(s, results);
  assert.equal(s.checklist['host-deploy'].by, 'verified');
  assert.equal(s.checklist['pay-products'].done, false, 'a hand tick that verify disproves is removed');
});

test('verify flags a webhook that accepts unsigned requests and a vercel.app domain', async () => {
  const s = state.loadState(web);
  s.liveUrl = 'https://ledger.vercel.app';
  const results = await runVerify(s, {
    env: { STRIPE_SECRET_KEY: 'sk_test_x' },
    only: ['pay-webhook', 'host-domain'],
    fetch: fakeFetch({
      'GET https://api.stripe.com/v1/webhook_endpoints': { data: [{ status: 'enabled', url: 'https://ledger.vercel.app/api/stripe/webhook', enabled_events: ['*'] }] },
      'POST https://ledger.vercel.app/api/stripe/webhook': new Response('ok'),
    }),
  });
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by['pay-webhook'].ok, false);
  assert.match(by['pay-webhook'].detail, /unsigned/);
  assert.equal(by['host-domain'].ok, false);
});

// Stripe test mode as the purchase flow test leaves it: a paid Checkout on the
// app, its subscription cancelled, and the webhook events delivered.
function stripeRecords({ successUrl = 'https://ledger.app/billing?ok=1', subStatus = 'canceled', paidPending = 0, cancelPending = 0, sessions = null, endpoints = null } = {}) {
  const created = Math.floor(Date.now() / 1000) - 3600;
  return fakeFetch({
    'GET https://api.stripe.com/v1/checkout/sessions': {
      data: sessions ?? [{ id: 'cs_test_a1b2c3d4e5f6', status: 'complete', payment_status: 'paid', mode: 'subscription', created, success_url: successUrl, subscription: { id: 'sub_9', status: subStatus } }],
    },
    'GET https://api.stripe.com/v1/webhook_endpoints': {
      data: endpoints ?? [{ status: 'enabled', url: 'https://ledger.app/api/stripe/webhook', enabled_events: ['checkout.session.completed', 'customer.subscription.deleted'] }],
    },
    'GET https://api.stripe.com/v1/events?type=checkout.session.completed': { data: [{ data: { object: { id: 'cs_test_a1b2c3d4e5f6' } }, pending_webhooks: paidPending }] },
    'GET https://api.stripe.com/v1/events?type=customer.subscription.deleted': { data: [{ data: { object: { id: 'sub_9' } }, pending_webhooks: cancelPending }] },
  });
}

test('verify proves the purchase flow from Stripe: paid, cancelled, webhook took both', async () => {
  const s = state.loadState(web);
  s.liveUrl = 'https://ledger.app';
  const check = async (fetch, env = { STRIPE_SECRET_KEY: 'sk_test_x' }) => (await runVerify(s, { env, only: ['pay-e2e'], fetch }))[0];

  const ok = await check(stripeRecords());
  assert.equal(ok.ok, true, ok.detail);
  assert.match(ok.detail, /cs_test_.*paid, cancelled, and your webhook accepted both/);
  applyVerify(s, [ok]);
  assert.equal(s.checklist['pay-e2e'].by, 'verified');

  let r = await check(stripeRecords({ subStatus: 'active' }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /never cancelled/);
  r = await check(stripeRecords({ paidPending: 1 }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /hasn't accepted checkout\.session\.completed/);
  r = await check(stripeRecords({ cancelPending: 2 }));
  assert.match(r.detail, /hasn't accepted customer\.subscription\.deleted/);
  r = await check(stripeRecords({ endpoints: [] }));
  assert.match(r.detail, /no enabled Stripe webhook listens/);

  // A purchase on another app sharing the Stripe account doesn't count. Once
  // proven, an empty 30-day window keeps the earlier proof instead of unticking.
  r = await check(stripeRecords({ successUrl: 'https://other-app.com/thanks' }));
  assert.equal(r.ok, null);
  assert.match(r.detail, /last proven/);
  s.checklist['pay-e2e'] = { done: false, by: null, at: null };
  r = await check(stripeRecords({ sessions: [] }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /no paid test checkout on ledger\.app/);

  // A Vercel preview of the same project counts once preview.url names it.
  s.config['preview.url'] = 'https://ledger-git-main-me.vercel.app';
  r = await check(stripeRecords({ successUrl: 'https://ledger-7fd3k2q-me.vercel.app/billing' }));
  assert.equal(r.ok, true, r.detail);
  delete s.config['preview.url'];

  // Live keys never run it, and the last result stands.
  r = await check(stripeRecords(), { STRIPE_SECRET_KEY: 'sk_live_x' });
  assert.equal(r.ok, null);
  assert.match(r.detail, /test mode only/);

  // After Liftoff's own test browser ran it, only that checkout counts, wherever it sent the buyer back to.
  const only = async (checkout, fetch) => (await runVerify(s, { env: { STRIPE_SECRET_KEY: 'sk_test_x' }, only: ['pay-e2e'], fetch, checkout }))[0];
  r = await only('cs_test_a1b2c3d4e5f6', stripeRecords({ successUrl: 'https://elsewhere.example.com/thanks' }));
  assert.equal(r.ok, true, r.detail);
  r = await only('cs_test_zz99', stripeRecords());
  assert.equal(r.ok, false);
  assert.match(r.detail, /doesn't list the test checkout cs_test_…zz99 as complete and paid/);
});

test('the purchase flow is server-proven only for web apps that pay through Stripe', async () => {
  const { purchaseProvenByStripe, sameApp } = await import('../lib/verify.mjs');
  assert.equal(purchaseProvenByStripe({ platforms: ['web'], steps: {} }, { stripeConnected: true }), true);
  assert.equal(purchaseProvenByStripe({ platforms: ['web'], steps: {} }, { stripeConnected: false }), false);
  assert.equal(purchaseProvenByStripe({ platforms: ['web'], steps: { payments: { provider: 'paddle' } } }, { stripeConnected: true }), false);
  assert.equal(purchaseProvenByStripe({ platforms: ['ios', 'android'], steps: { payments: { provider: 'stripe' } } }, { stripeConnected: true }), false);
  assert.equal(sameApp('3fa9c1.ledger.pages.dev', 'ledger.pages.dev'), true);
  assert.equal(sameApp('deploy-preview-4--ledger.netlify.app', 'ledger.netlify.app'), true);
  assert.equal(sameApp('ledger-abc-me.vercel.app', 'ledger.vercel.app'), true);
  assert.equal(sameApp('ledgerx.vercel.app', 'ledger.vercel.app'), false);
  assert.equal(sameApp('ledger-abc-me.vercel.app', 'ledger.app'), false);

  // The CLI refuses a hand tick for a web app on Stripe, and allows it for a mobile app.
  const shop = makeApp('shopfront', { 'package.json': { name: 'shopfront', dependencies: { next: '15', react: '19', stripe: '17' } } });
  const st = state.initProject(shop);
  state.setStep(st, 'payments', 'done', { provider: 'stripe', force: true });
  state.saveState(st);
  const r = spawnSync('node', [CLI, 'check', 'pay-e2e', '--dir', shop], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /proven from Stripe/);
  assert.match(execFileSync('node', [CLI, 'check', 'pay-e2e', '--dir', expo]).toString(), /✓ pay-e2e/);
  const mobile = await runVerify(state.loadState(expo), { env: { STRIPE_SECRET_KEY: 'sk_test_x' }, only: ['pay-e2e'], fetch: stripeRecords() });
  assert.equal(mobile[0].ok, null, 'a mobile app keeps its own test run');
});

test('secret scan finds Stripe secret keys and service_role JWTs in client code', () => {
  const payload = Buffer.from(JSON.stringify({ role: 'service_role', iss: 'supabase' })).toString('base64url');
  const dir = makeApp('leaky', {
    'package.json': { name: 'leaky', dependencies: { next: '15' } },
    'app/page.tsx': `const k = 'sk_live_${'a'.repeat(24)}'`,
    '.next/static/chunks/main.js': `var s="eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJlc2lnbmF0dXJl"`,
    'lib/env.ts': 'process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY',
    '.env.local': `STRIPE_SECRET_KEY=sk_live_${'b'.repeat(24)}`,
  });
  const hits = scanSecrets(dir);
  const kinds = hits.map((h) => `${h.kind}@${h.file}`);
  assert.ok(kinds.includes('Stripe secret key@app/page.tsx'));
  assert.ok(kinds.includes('Supabase service_role key@.next/static/chunks/main.js'));
  assert.ok(kinds.some((k) => k.startsWith('secret in a public env var')));
  assert.ok(!hits.some((h) => h.file === '.env.local'), '.env files are not client code');
  assert.equal(scanSecrets(web).length, 0);
});

// ---------- 7. store pre-scan ----------

test('store scan catches vague purpose strings, export compliance, Stripe links on iOS, missing deletion', () => {
  const d = detectProject(expo);
  const f = Object.fromEntries(storeScan(expo, d).map((x) => [x.id, x]));
  assert.equal(f['ios-purpose'].ok, false);
  assert.match(f['ios-purpose'].detail, /too vague/);
  assert.equal(f['ios-export'].ok, false);
  assert.equal(f['iap-links'].ok, false);
  assert.equal(f['ios-delete'].ok, false);

  const good = makeApp('greenrow-good', {
    'package.json': { name: 'greenrow-good', dependencies: { expo: '52', 'expo-camera': '16' } },
    'app.json': { expo: { name: 'Good', plugins: [['expo-camera', { cameraPermission: 'Greenrow uses the camera to scan your boarding pass.' }]], ios: { config: { usesNonExemptEncryption: false } } } },
    'store/ios/review-notes.md': 'Demo login: review@example.com / password hunter2',
  });
  const g = Object.fromEntries(storeScan(good, detectProject(good)).map((x) => [x.id, x]));
  assert.equal(g['ios-purpose'].ok, true);
  assert.equal(g['ios-export'].ok, true);
  assert.equal(g['ios-review-notes'].ok, true);
});

// ---------- 8–9. pulse and next action ----------

test('pulse reads Stripe revenue and uptime and reports week-over-week change', async () => {
  const s = state.loadState(web);
  s.liveUrl = 'https://ledger.app';
  const price = (amt, interval) => ({ unit_amount: amt, currency: 'usd', recurring: { interval, interval_count: 1 } });
  const now = Date.now();
  const fetch = fakeFetch({
    'GET https://api.stripe.com/v1/subscriptions?status=active': {
      has_more: false,
      data: [
        { id: 'sub_1', created: Math.floor(now / 1000), items: { data: [{ price: price(900, 'month'), quantity: 1 }] } },
        { id: 'sub_2', created: 1, items: { data: [{ price: price(6000, 'year'), quantity: 1 }] } },
      ],
    },
    'GET https://api.stripe.com/v1/subscriptions?status=trialing': { data: [{}] },
    'GET https://api.stripe.com/v1/events?type=customer.subscription.deleted': { data: [] },
    'GET https://api.stripe.com/v1/events?type=invoice.payment_failed': { data: [{}, {}, {}] },
    'GET https://ledger.app': new Response('ok'),
  });
  s.pulse = { latest: null, history: [{ at: new Date(now - 7 * 86_400_000).toISOString(), stripe: { mrr: 10 } }] };
  const snap = recordPulse(s, await collectPulse(s, { env: { STRIPE_SECRET_KEY: 'sk_test_x' }, fetch, now }));
  assert.equal(snap.stripe.mrr, 14); // $9 + $60/12
  assert.equal(snap.stripe.newSubscriptions7d, 1);
  assert.equal(snap.stripe.trials, 1);
  assert.equal(snap.change.mrr, 4);
  assert.equal(snap.uptime.up, true);
  assert.ok(!snap.posthog, 'PostHog not set up → absent, not an error');

  // Three failed payments outrank build steps once nothing more urgent is open.
  const sum = state.summarize(s);
  for (const t of s.tasks) t.done = true;
  const a = nextAction({ ...state.summarize(s), pulse: snap });
  assert.equal(a.title, 'Recover failed payments');
  assert.ok(sum.pulse);
});

test('next action puts a down site first and suggests a pricing test on weak conversion', () => {
  const s = state.summarize(state.loadState(web));
  assert.equal(nextAction(s, { uptime: { up: false, status: 503 } }).title, 'Your live site is down');
  const done = { ...s, tasks: [], nextSteps: [], blockingTasks: 0, steps: s.steps.map((x) => ({ ...x, stale: false })), checklist: [] };
  const a = nextAction(done, { posthog: { paywallViews7d: 400, upgrades7d: 2, signups7d: 50, signupsPrev7d: 50, activations7d: 30 } });
  assert.equal(a.title, 'Test your paywall offer');
  assert.match(a.why, /400 paywall views/);
});

// ---------- 16. costs ----------

test('cost view warns about Vercel Hobby for paid apps and estimates fees', () => {
  const s = state.summarize(state.loadState(web));
  const r = costReport({ ...s, pulse: { stripe: { mrr: 1000 } } });
  assert.ok(r.rows.some((x) => x.id === 'vercel'));
  assert.ok(r.warnings.some((w) => /Hobby/.test(w)));
  assert.equal(r.revenueFeesMonthly, 29);
  const m = costReport(state.summarize(state.loadState(expo)));
  assert.match(m.storeCut, /15%/);
});

// ---------- 13. undo, stale steps ----------

test('steps log their changes, undo lists them and resets; stale running steps are flagged', () => {
  const s = state.loadState(web);
  s.steps.paywall.status = 'done';
  state.recordChange(s, 'payments', 'file', 'app/api/checkout/route.ts');
  state.recordChange(s, 'payments', 'resource', 'stripe:price:price_123');
  state.recordChange(s, 'payments', 'resource', 'stripe:price:price_123');
  const plan = state.undoPlan(s, 'payments');
  assert.deepEqual(plan.files, ['app/api/checkout/route.ts']);
  assert.deepEqual(plan.resources, ['stripe:price:price_123']);
  assert.ok(plan.dependents.includes('paywall'));
  state.resetStep(s, 'payments');
  assert.equal(s.steps.payments.status, 'todo');
  assert.equal(s.changes.payments, undefined);

  s.steps.crashes = { status: 'running', updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
  assert.equal(state.summarize(s).steps.find((x) => x.id === 'crashes').stale, true);
});

// ---------- 14. credentials ----------

test('exec --only injects just the named accounts', () => {
  state.connectAccount('stripe', { STRIPE_SECRET_KEY: 'sk_test_only' });
  state.connectAccount('vercel', { VERCEL_TOKEN: 'vc_tok' });
  const show = 'process.stdout.write(JSON.stringify([process.env.STRIPE_SECRET_KEY||null, process.env.VERCEL_TOKEN||null]))';
  const env = { ...process.env };
  const all = JSON.parse(execFileSync('node', [CLI, 'exec', '--', 'node', '-e', show], { env }).toString());
  assert.deepEqual(all, ['sk_test_only', 'vc_tok']);
  const only = JSON.parse(execFileSync('node', [CLI, 'exec', '--only', 'vercel', '--', 'node', '-e', show], { env }).toString());
  assert.deepEqual(only, [null, 'vc_tok']);
  assert.equal(state.listAccounts().find((a) => a.id === 'stripe').store, 'file');
});

// ---------- 15. detection ----------

test('detects monorepos, Capacitor, existing auth and payments, and the package manager', () => {
  const mono = makeApp('mono', {
    'package.json': { name: 'trailmix', private: true, workspaces: ['apps/*'] },
    'pnpm-lock.yaml': '',
    'apps/web/package.json': { name: 'web', dependencies: { next: '15', '@clerk/nextjs': '6', '@lemonsqueezy/lemonsqueezy.js': '4' } },
    'apps/mobile/package.json': { name: 'mobile', dependencies: { expo: '52', 'react-native': '0.76' } },
    'apps/mobile/app.json': { expo: { name: 'Trailmix' } },
  });
  const d = detectProject(mono);
  assert.deepEqual(d.platforms, ['android', 'ios', 'web']);
  assert.equal(d.apps.length, 2);
  assert.equal(d.auth, 'clerk');
  assert.deepEqual(d.payments, ['lemonsqueezy']);
  assert.equal(d.packageManager, 'pnpm');
  assert.match(d.framework, /Next\.js/);

  const cap = makeApp('cap', { 'package.json': { name: 'cap', dependencies: { '@capacitor/core': '6', '@capacitor/ios': '6', react: '19' } } });
  const c = detectProject(cap);
  assert.equal(c.framework, 'Capacitor');
  assert.deepEqual(c.platforms, ['ios', 'web']);
});

// ---------- 17. fixture apps ----------

for (const [name, expect] of Object.entries({
  'next-saas': { framework: 'Next.js', platforms: ['web'], steps: ['hosting', 'payments', 'money-test'], noSteps: ['testflight'] },
  'expo-recipes': { framework: 'Expo', platforms: ['android', 'ios'], steps: ['testflight', 'play-testing', 'store-listing'], noSteps: ['hosting'] },
  'flutter-notes': { framework: 'Flutter', platforms: ['android', 'ios'], steps: ['store-checks'], noSteps: ['hosting'] },
})) {
  test(`fixture ${name}: detected, planned in a valid order, scans run`, () => {
    const src = path.join(FIXTURES, name);
    const dir = path.join(tmp, `fx-${name}`);
    fs.cpSync(src, dir, { recursive: true });
    const s = state.initProject(dir);
    assert.equal(s.framework, expect.framework);
    assert.deepEqual(s.platforms, expect.platforms);
    const order = state.summarize(s).steps.map((x) => x.id);
    for (const id of expect.steps) assert.ok(order.includes(id), `${name} has ${id}`);
    for (const id of expect.noSteps) assert.ok(!order.includes(id), `${name} has no ${id}`);
    for (const step of state.summarize(s).steps) for (const n of step.waitingOn) assert.ok(order.indexOf(n) < order.indexOf(step.id));
    assert.equal(scanSecrets(dir).length, 0);
    if (s.platforms.includes('ios')) assert.ok(storeScan(dir, s).length >= 4);
  });
}

// ---------- scaffolds, CLI and API ----------

test('scaffold writes the purchase flow test and uptime workflow without overwriting', () => {
  const run = (...a) => execFileSync('node', [CLI, ...a, '--dir', web]).toString();
  assert.match(run('scaffold', 'money-test'), /wrote e2e\/liftoff-money-path\.spec\.ts/);
  assert.match(run('scaffold', 'uptime'), /wrote \.github\/workflows\/liftoff-uptime\.yml/);
  assert.match(run('scaffold', 'uptime'), /exists/);
  const wf = fs.readFileSync(path.join(web, '.github/workflows/liftoff-uptime.yml'), 'utf8');
  assert.match(wf, /Ledger is down/);
  assert.match(wf, /\$\{\{ vars\.LIFTOFF_HEALTH_URL \}\}/);
  // init now auto-ticks the uptime item from the workflow file.
  assert.equal(state.initProject(web).checklist['mon-uptime'].done, true);
});

test('CLI: set, settings, next, costs and undo', () => {
  const run = (...a) => execFileSync('node', [CLI, ...a, '--dir', web]).toString();
  run('set', 'sentry.org', 'acme');
  assert.match(run('settings'), /sentry\.org\s+acme/);
  assert.throws(() => execFileSync('node', [CLI, 'set', 'nope', 'x', '--dir', web], { stdio: 'pipe' }));
  const next = JSON.parse(run('next', '--json'));
  assert.ok(next.title && next.why && next.do);
  assert.match(run('costs'), /Fixed costs about/);
  run('record', 'hosting', '--resource', 'vercel:project:ledger');
  assert.match(run('undo', 'hosting'), /vercel:project:ledger/);
  assert.match(run('status'), /Next: /);
});

test('Flight Board API includes the next action and costs', async () => {
  const { server, url: u } = await startServer({ port: 0 });
  // Node 18's fetch doesn't fall back from ::1 to 127.0.0.1 for "localhost".
  const url = u.replace('localhost', '127.0.0.1');
  try {
    const app = await (await fetch(`${url}/api/apps/ledger`)).json();
    assert.ok(app.nextAction.title);
    assert.ok(app.costs.rows.length);
    assert.ok(Array.isArray(app.nextSteps));
    assert.ok(app.steps.every((s) => Array.isArray(s.waitingOn)));
  } finally {
    server.close();
  }
});
