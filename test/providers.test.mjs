// The services beyond the defaults: which one an app uses per category, the
// accounts its steps need, what Liftoff can prove for it, and the checks for
// Paddle, Polar, Lemon Squeezy, Firebase, Neon and SendGrid. No network: fetch
// and Google's token endpoint are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-prov-'));
process.env.LIFTOFF_HOME = path.join(tmp, 'home');
process.env.LIFTOFF_SECRET_STORE = 'file';

const { STEPS, accountsFor, accountsForStep, paperworkFor, usesOf } = await import('../lib/catalog.mjs');
const { detectProject } = await import('../lib/detect.mjs');
const state = await import('../lib/state.mjs');
const { canProve, openRules, runVerify } = await import('../lib/verify.mjs');
const { costReport } = await import('../lib/costs.mjs');

function makeApp(name, files) {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

// Routes match on "METHOD url-prefix"; the longest prefix wins.
function fakeFetch(routes, calls = []) {
  return async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, url: String(url), headers: opts.headers || {} });
    const key = Object.keys(routes).filter((k) => {
      const [m, prefix] = k.split(' ');
      return m === method && String(url).startsWith(prefix);
    }).sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key];
    const v = typeof r === 'function' ? r(url, opts) : r;
    if (v instanceof Response) return v.clone();
    return new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const step = (id) => STEPS.find((s) => s.id === id);

test('detects the newer services from packages and config files', () => {
  const dir = makeApp('mixed', {
    'package.json': { name: 'mixed', dependencies: { next: '15', react: '19', '@polar-sh/sdk': '0.30', '@clerk/nextjs': '6', '@sendgrid/mail': '8' } },
    'netlify.toml': '[build]\ncommand = "next build"',
    '.env.example': 'DATABASE_URL=postgres://user:pass@ep-cool-1234.us-east-2.aws.neon.tech/neondb',
  });
  const d = detectProject(dir);
  for (const k of ['polar', 'clerk', 'sendgrid', 'netlify', 'neon']) assert.equal(d.integrations[k], true, k);
  assert.equal(d.auth, 'clerk');
  assert.ok(d.payments.includes('polar'));
  const fb = detectProject(makeApp('fb', { 'package.json': { name: 'fb', dependencies: { react: '19', firebase: '11' } }, 'firebase.json': { hosting: { public: 'dist' } } }));
  assert.equal(fb.integrations.firebaseHosting, true);
});

test('each category uses the recorded provider, else what the code uses, else the user’s own service', () => {
  assert.deepEqual(usesOf({ integrations: { stripe: true, supabase: true } }), { payments: 'stripe', database: 'supabase' });
  assert.equal(usesOf({ integrations: { paddle: true } }).payments, 'paddle');
  assert.equal(usesOf({ integrations: { stripe: true }, steps: { payments: { provider: 'Lemon Squeezy' } } }).payments, 'lemonsqueezy', 'the step says what it used');
  assert.equal(usesOf({ integrations: { netlify: true } }).hosting, 'netlify');
  const creem = { id: 'custom-creem', name: 'Creem', category: 'payments' };
  assert.equal(usesOf({ integrations: {} }, { custom: [creem] }).payments, 'custom-creem');
  assert.equal(usesOf({ integrations: { stripe: true } }, { custom: [creem] }).payments, 'stripe', 'code that uses Stripe keeps Stripe');
  assert.equal(usesOf({ integrations: { stripe: true }, steps: { payments: { provider: 'creem' } } }, { custom: [creem] }).payments, 'custom-creem');

  // The step's accounts follow: Paddle replaces Stripe, mobile paywalls keep RevenueCat.
  assert.deepEqual(accountsForStep(step('payments'), ['web'], { payments: 'paddle' }), ['paddle']);
  assert.deepEqual(accountsForStep(step('payments'), ['web'], {}), ['stripe']);
  assert.deepEqual(accountsForStep(step('paywall'), ['ios'], { payments: 'paddle' }), ['revenuecat']);
  assert.deepEqual(accountsForStep(step('hosting'), ['web'], { hosting: 'netlify' }), ['netlify']);
  assert.deepEqual(accountsForStep(step('database'), ['web'], { database: 'custom-mydb' }), ['custom-mydb']);
  const all = accountsFor(['web'], undefined, { payments: 'polar', email: 'postmark' });
  assert.ok(all.includes('polar') && all.includes('postmark') && !all.includes('stripe') && !all.includes('resend'));
});

test('Lemon Squeezy apps get a dated, non-blocking notice to move before it shuts down', () => {
  const notice = paperworkFor(['web'], undefined, ['lemonsqueezy']).find((w) => w.key === 'lemonsqueezy-shutdown');
  assert.equal(notice.blocks, false);
  assert.equal(notice.notice, true);
  assert.match(notice.title, /March 31, 2027/);
  assert.ok(!paperworkFor(['web'], undefined, ['stripe']).some((w) => w.key === 'lemonsqueezy-shutdown'));
});

test('Liftoff proves an item only when it can check the service the app uses', () => {
  // The owner says the app takes payments, so the purchase test applies.
  const web = (uses, extra = {}) => ({ platforms: ['web'], steps: {}, integrations: {}, payments: [], profile: { set: { payments: true } }, ...extra, uses });
  const can = (id, uses, extra) => canProve(web(uses, extra), id, { uses });
  assert.equal(can('pay-webhook', { payments: 'stripe' }), true);
  assert.equal(can('pay-webhook', { payments: 'paddle' }), true);
  assert.equal(can('pay-webhook', { payments: 'custom-creem' }), false, 'a service of the user’s own is reported, not proven');
  assert.equal(can('pay-live', { payments: 'lemonsqueezy' }), false, 'Lemon Squeezy doesn’t say whether a key is live');
  assert.equal(can('pay-e2e', { payments: 'polar' }), true);
  assert.equal(can('pay-e2e', { payments: 'lemonsqueezy' }), false);
  assert.equal(canProve({ platforms: ['ios'], steps: {} }, 'pay-e2e', { uses: { payments: 'paddle' } }), false);
  assert.equal(can('sec-rls', { database: 'firebase' }), true);
  assert.equal(can('sec-rls', { database: 'neon' }), false);
  assert.equal(can('sec-backup', { database: 'neon' }), true);
  assert.equal(can('host-https', { hosting: 'custom-railway' }), true, 'the live site is checked whoever hosts it');
  assert.equal(can('sec-rls', {}), true, 'nothing named yet: Supabase, as before');
});

test('open Firebase rules are caught: no condition, test mode, a catch-all for any signed-in user', () => {
  const now = Date.UTC(2026, 10, 28);
  assert.deepEqual(openRules("match /databases/{db}/documents { match /{document=**} { allow read, write: if request.time < timestamp.date(2027, 1, 1); } }", now), ['test-mode rules let anyone read, write until 2027-01-01']);
  assert.deepEqual(openRules("match /{document=**} { allow read, write: if request.time < timestamp.date(2026, 1, 1); }", now), [], 'expired test rules lock everything');
  assert.deepEqual(openRules('match /b/{bucket}/o { match /{allPaths=**} { allow read, write; } }', now), ['anyone can read, write']);
  assert.deepEqual(openRules('match /x/{id} { allow read: if true; }', now), ['anyone can read']);
  assert.deepEqual(openRules('match /{path=**} { allow read, write: if request.auth != null; }', now), ['any signed-in user can read, write every document']);
  assert.deepEqual(openRules("match /users/{uid} { allow read, write: if request.auth != null && request.auth.uid == uid; } // allow write: if true;", now), []);
});

function webState(name, deps, extra = {}) {
  const s = state.initProject(makeApp(name, { 'package.json': { name, dependencies: { next: '15', react: '19', ...deps } } }));
  s.liveUrl = `https://${name}.app`;
  return Object.assign(s, extra);
}

test('Paddle: prices, the notification destination, and a sandbox purchase that was paid and cancelled', async () => {
  const s = webState('paddleshop', { '@paddle/paddle-js': '1' });
  const SB = 'https://sandbox-api.paddle.com';
  const dest = (events) => ({ data: [{ id: 'ntfset_1', type: 'url', active: true, destination: 'https://paddleshop.app/api/paddle/webhook', subscribed_events: events.map((name) => ({ name })) }] });
  const records = ({ events = ['transaction.completed', 'subscription.updated', 'subscription.canceled'], sub = 'canceled', delivered = ['transaction.completed', 'subscription.canceled'] } = {}) => fakeFetch({
    [`GET ${SB}/prices`]: { data: [{ id: 'pri_1', billing_cycle: { interval: 'month' } }, { id: 'pri_2', billing_cycle: null }] },
    [`GET ${SB}/notification-settings`]: dest(events),
    'POST https://paddleshop.app/api/paddle/webhook': new Response('missing signature', { status: 401 }),
    [`GET ${SB}/transactions`]: { data: [{ id: 'txn_01hv8k2m3n4p5q', created_at: new Date().toISOString(), subscription_id: 'sub_01', checkout: { url: 'https://paddleshop.app/pricing?_ptxn=txn_01' } }] },
    [`GET ${SB}/notifications?filter=txn_`]: { data: delivered.includes('transaction.completed') ? [{ type: 'transaction.completed' }] : [] },
    [`GET ${SB}/notifications?filter=sub_`]: { data: delivered.includes('subscription.canceled') ? [{ type: 'subscription.canceled' }] : [] },
    [`GET ${SB}/subscriptions/sub_01`]: { data: { id: 'sub_01', status: sub } },
  });
  const env = { PADDLE_API_KEY: 'pdl_sdbx_apikey_01abc' };
  const run = async (only, fetch) => Object.fromEntries((await runVerify(s, { env, only, fetch })).map((r) => [r.id, r]));

  let by = await run(['pay-products', 'pay-webhook', 'pay-e2e', 'pay-live'], records());
  assert.equal(by['pay-products'].ok, true);
  assert.match(by['pay-products'].detail, /2 active Paddle price\(s\), 1 recurring/);
  assert.equal(by['pay-webhook'].ok, true, by['pay-webhook'].detail);
  assert.equal(by['pay-e2e'].ok, true, by['pay-e2e'].detail);
  assert.match(by['pay-e2e'].detail, /paid, cancelled, and your webhook accepted both/);
  assert.equal(by['pay-live'].ok, false);
  assert.match(by['pay-live'].detail, /sandbox key/);

  by = await run(['pay-webhook'], records({ events: ['transaction.completed'] }));
  assert.match(by['pay-webhook'].detail, /missing subscription\.updated, subscription\.canceled/);
  by = await run(['pay-e2e'], records({ sub: 'active' }));
  assert.match(by['pay-e2e'].detail, /never cancelled/);
  by = await run(['pay-e2e'], records({ delivered: ['transaction.completed'] }));
  assert.match(by['pay-e2e'].detail, /hasn't accepted subscription\.canceled/);
  by = await runVerify(s, { env: {}, only: ['pay-products'], fetch: records() });
  assert.equal(by[0].ok, null, 'not connected → skipped');
});

test('Polar: a token that live turns down is a sandbox token; paid and revoked deliveries prove the purchase', async () => {
  const s = webState('polarshop', { '@polar-sh/nextjs': '0.4' });
  const SB = 'https://sandbox-api.polar.sh';
  const calls = [];
  const fetch = fakeFetch({
    'GET https://api.polar.sh/v1/products/': new Response('{}', { status: 401 }),
    [`GET ${SB}/v1/products/`]: { items: [{ id: 'prod_1' }] },
    [`GET ${SB}/v1/webhooks/endpoints`]: { items: [{ url: 'https://polarshop.app/api/webhook/polar', format: 'raw', events: ['order.paid', 'subscription.revoked'] }] },
    'POST https://polarshop.app/api/webhook/polar': new Response('bad', { status: 403 }),
    [`GET ${SB}/v1/orders/`]: { items: [{ id: 'ord_7f3a9c1d2e4b', paid: true, created_at: new Date().toISOString(), subscription_id: 'sub_9' }] },
    [`GET ${SB}/v1/webhooks/deliveries?event_type=order.paid`]: { items: [{ succeeded: true, webhook_event: { payload: '{"type":"order.paid","data":{"id":"ord_7f3a9c1d2e4b"}}' } }] },
    [`GET ${SB}/v1/webhooks/deliveries?event_type=subscription.revoked`]: { items: [{ succeeded: true, webhook_event: { payload: '{"data":{"id":"sub_9"}}' } }] },
    [`GET ${SB}/v1/subscriptions/sub_9`]: { id: 'sub_9', status: 'canceled' },
  }, calls);
  const by = Object.fromEntries((await runVerify(s, { env: { POLAR_ACCESS_TOKEN: 'polar_oat_x' }, only: ['pay-products', 'pay-webhook', 'pay-e2e', 'pay-live'], fetch })).map((r) => [r.id, r]));
  assert.equal(by['pay-products'].ok, true);
  assert.equal(by['pay-webhook'].ok, true, by['pay-webhook'].detail);
  assert.equal(by['pay-e2e'].ok, true, by['pay-e2e'].detail);
  assert.equal(by['pay-live'].ok, false);
  assert.equal(calls.filter((c) => c.url.startsWith('https://api.polar.sh')).length, 1, 'live is asked once, then remembered');
  // The key check already said which: no probe.
  const known = await runVerify(s, { env: { POLAR_ACCESS_TOKEN: 'polar_oat_x' }, only: ['pay-live'], modes: { polar: 'live' }, fetch });
  assert.equal(known[0].ok, true);
});

test('Lemon Squeezy: published products and a webhook that checks X-Signature', async () => {
  const s = webState('lemonshop', { '@lemonsqueezy/lemonsqueezy.js': '4' });
  const fetch = fakeFetch({
    'GET https://api.lemonsqueezy.com/v1/products': { data: [{ attributes: { status: 'published' } }, { attributes: { status: 'draft' } }] },
    'GET https://api.lemonsqueezy.com/v1/webhooks': { data: [{ attributes: { url: 'https://lemonshop.app/api/lemon', events: ['order_created', 'subscription_created', 'subscription_updated'] } }] },
    'POST https://lemonshop.app/api/lemon': new Response('ok'),
  });
  const by = Object.fromEntries((await runVerify(s, { env: { LEMONSQUEEZY_API_KEY: 'eyJ.x.y' }, only: ['pay-products', 'pay-webhook', 'pay-live'], fetch })).map((r) => [r.id, r]));
  assert.match(by['pay-products'].detail, /1 published/);
  assert.equal(by['pay-webhook'].ok, false);
  assert.match(by['pay-webhook'].detail, /missing subscription_expired/);
  assert.equal(by['pay-live'].ok, null);
  assert.match(by['pay-live'].detail, /can't check Lemon Squeezy/);
});

test('a service of the user’s own is skipped by name, never failed', async () => {
  const s = webState('creemshop', {}, { steps: { payments: { status: 'done', provider: 'Creem' } } });
  const r = await runVerify(s, { env: {}, only: ['pay-webhook'], uses: { payments: 'custom-creem' }, names: { 'custom-creem': 'Creem' }, fetch: fakeFetch({}) });
  assert.equal(r[0].ok, null);
  assert.match(r[0].detail, /can't check Creem for this yet; tick it once it's tested/);
});

test('Firebase rules are read with the service account, from Google’s own token endpoint', async () => {
  const s = webState('fireapp', { firebase: '11' });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = JSON.stringify({ type: 'service_account', project_id: 'fireapp-prod', client_email: 'ci@fireapp-prod.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const rules = (source) => fakeFetch({
    'POST https://oauth2.googleapis.com/token': { access_token: 'ya29.test' },
    'GET https://firebaserules.googleapis.com/v1/projects/fireapp-prod/releases': { releases: [{ name: 'projects/fireapp-prod/releases/cloud.firestore', rulesetName: 'projects/fireapp-prod/rulesets/abc-123' }] },
    'GET https://firebaserules.googleapis.com/v1/projects/fireapp-prod/rulesets/abc-123': { source: { files: [{ content: source }] } },
  });
  const check = async (source) => (await runVerify(s, { env: { FIREBASE_SERVICE_ACCOUNT_JSON: key }, only: ['sec-rls'], uses: { database: 'firebase' }, fetch: rules(source) }))[0];
  let r = await check("service cloud.firestore { match /databases/{d}/documents { match /users/{uid} { allow read, write: if request.auth.uid == uid; } } }");
  assert.equal(r.ok, true, r.detail);
  r = await check("service cloud.firestore { match /databases/{d}/documents { match /{document=**} { allow read, write: if request.time < timestamp.date(2099, 1, 1); } } }");
  assert.equal(r.ok, false);
  assert.match(r.detail, /Firestore: test-mode rules/);
});

test('Neon backups: history retention is the restore window', async () => {
  const s = webState('neonapp', { '@neondatabase/serverless': '1' });
  const neon = (secs) => fakeFetch({
    'GET https://console.neon.tech/api/v2/projects?': { projects: [{ id: 'proj-1' }] },
    'GET https://console.neon.tech/api/v2/projects/proj-1': { project: { id: 'proj-1', history_retention_seconds: secs } },
  });
  let [r] = await runVerify(s, { env: { NEON_API_KEY: 'napi_x' }, only: ['sec-backup'], fetch: neon(86_400) });
  assert.equal(r.ok, true);
  assert.match(r.detail, /1 day/);
  [r] = await runVerify(s, { env: { NEON_API_KEY: 'napi_x' }, only: ['sec-backup'], fetch: neon(0) });
  assert.equal(r.ok, false);
});

test('SendGrid says itself whether the sending domain is verified', async () => {
  const s = webState('mailapp', { '@sendgrid/mail': '8' });
  s.config['email.domain'] = 'mailapp.app';
  const sg = (valid) => fakeFetch({ 'GET https://api.sendgrid.com/v3/whitelabel/domains': [{ domain: 'mailapp.app', valid }] });
  let [r] = await runVerify(s, { env: { SENDGRID_API_KEY: 'SG.a.b' }, only: ['email-domain'], fetch: sg(true) });
  assert.equal(r.ok, true, r.detail);
  [r] = await runVerify(s, { env: { SENDGRID_API_KEY: 'SG.a.b' }, only: ['email-domain'], fetch: sg(false) });
  assert.equal(r.ok, false);
  // Another provider needs the DKIM selector it gave.
  [r] = await runVerify(s, { env: {}, only: ['email-domain'], uses: { email: 'custom-mailbird' }, names: { 'custom-mailbird': 'Mailbird' }, fetch: sg(true) });
  assert.match(r.detail, /set email.dkim to the DKIM selector Mailbird gave you/);
});

test('fees follow the payment provider the app uses', () => {
  const base = { platforms: ['web'], readyForRelease: false, pulse: { stripe: { mrr: 1000 } } };
  const stripe = costReport({ ...base, uses: { payments: 'stripe' } });
  const paddle = costReport({ ...base, uses: { payments: 'paddle' } });
  assert.equal(stripe.revenueFeesMonthly, 29);
  assert.equal(paddle.revenueFeesMonthly, 50);
  assert.ok(paddle.rows.some((r) => r.id === 'paddle'));
  assert.ok(!paddle.rows.some((r) => r.id === 'stripe'));
});
