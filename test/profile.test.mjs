// What the app does: detection, corrections, and how steps, checks and
// paperwork follow it. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-profile-'));
process.env.LIFTOFF_HOME = path.join(tmp, 'home');
process.env.LIFTOFF_SECRET_STORE = 'file';
for (const k of ['STRIPE_SECRET_KEY', 'VERCEL_TOKEN']) delete process.env[k];

const state = await import('../lib/state.mjs');
const { featuresOf, profileView, sizeOf } = await import('../lib/profile.mjs');
const { stepsFor, checklistFor, STEPS, CHECKLIST } = await import('../lib/catalog.mjs');
const { startServer } = await import('../lib/server.mjs');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'liftoff.mjs');

function makeApp(name, files) {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}
const ids = (xs) => xs.map((x) => x.id);
const keys = (s) => s.tasks.filter((t) => t.key && !t.done).map((t) => t.key);

test('a simple site gets a short launch: no payments, sign-in or Stripe paperwork', () => {
  const dir = makeApp('portfolio', {
    'package.json': { name: 'portfolio', dependencies: { next: '15', react: '19' } },
    'app/page.tsx': 'export default () => <h1>Hi</h1>',
  });
  const s = state.initProject(dir);
  const sum = state.summarize(s);
  assert.deepEqual(Object.values(sum.features), [false, false, false, false, false, false, false]);
  assert.equal(sum.profile.size, 'simple');
  for (const id of ['payments', 'paywall', 'money-test', 'auth', 'database', 'email', 'safety']) {
    assert.ok(!ids(sum.steps).includes(id), `no ${id} step`);
  }
  assert.ok(ids(sum.steps).includes('hosting'));
  assert.ok(sum.stepsTotal < stepsFor(['web']).length);
  assert.ok(!sum.checklist.some((c) => c.id.startsWith('pay-') || c.id.startsWith('auth-')));
  assert.ok(!keys(s).includes('stripe-activate'));
  assert.equal(sum.checksTotal, sum.checklist.length);
  assert.ok(sum.checksTotal < checklistFor(['web']).length);
});

test('a SaaS app with Stripe and Supabase gets payments, sign-in, data and email', () => {
  const dir = makeApp('invoicer', {
    'package.json': { name: 'invoicer', dependencies: { next: '15', react: '19', stripe: '17', '@supabase/supabase-js': '2' } },
  });
  const sum = state.summarize(state.initProject(dir));
  assert.equal(sum.features.payments, true);
  assert.equal(sum.features.accounts, true);
  assert.equal(sum.features.database, true);
  assert.equal(sum.features.email, true);
  const pay = sum.profile.features.find((f) => f.id === 'payments');
  assert.equal(pay.source, 'code');
  assert.match(pay.why, /Stripe/);
  for (const id of ['payments', 'paywall', 'money-test', 'auth', 'database', 'email']) assert.ok(ids(sum.steps).includes(id), id);
  assert.ok(ids(sum.checklist).includes('pay-e2e'));
  assert.ok(ids(sum.checklist).includes('sec-rls'));
});

test('an AI app with uploads gets the abuse and spend limits step, its checks and the spend cap task', () => {
  const dir = makeApp('summarizer', {
    'package.json': { name: 'summarizer', dependencies: { next: '15', react: '19', openai: '4' } },
    'app/upload/page.tsx': '<input type="file" />',
  });
  const s = state.initProject(dir);
  const sum = state.summarize(s);
  assert.equal(sum.features.ai, true);
  assert.equal(sum.features.uploads, true);
  assert.ok(ids(sum.steps).includes('safety'));
  for (const id of ['ai-server', 'ai-limits', 'up-limits', 'sec-rate']) assert.ok(ids(sum.checklist).includes(id), id);
  assert.ok(!ids(sum.checklist).includes('ugc-report'), 'nothing people post for others');
  assert.ok(keys(s).includes('ai-spend-cap'));
});

test('hints: a pricing page means the app will take payments, and paying customers need accounts', () => {
  const dir = makeApp('pricing-only', {
    'package.json': { name: 'pricing-only', dependencies: { next: '15', react: '19' } },
    'app/pricing/page.tsx': '',
  });
  const p = profileView(state.initProject(dir));
  const pay = p.features.find((f) => f.id === 'payments');
  const acc = p.features.find((f) => f.id === 'accounts');
  assert.equal(pay.on, true);
  assert.equal(pay.source, 'hint');
  assert.equal(acc.on, true);
  assert.match(acc.why, /Paying customers/);
});

test('turning payments off drops its steps, checks and open paperwork, and keeps progress for later', () => {
  const dir = makeApp('shop', {
    'package.json': { name: 'shop', dependencies: { next: '15', react: '19', stripe: '17' } },
  });
  const s = state.initProject(dir);
  assert.ok(keys(s).includes('stripe-activate'));
  state.setStep(s, 'payments', 'running', { force: true });
  state.setCheck(s, 'pay-products', true);

  state.setFeature(s, 'payments', false);
  let sum = state.summarize(s);
  assert.equal(sum.features.payments, false);
  assert.ok(!ids(sum.steps).includes('payments'));
  assert.ok(!ids(sum.checklist).includes('pay-products'));
  assert.ok(!keys(s).includes('stripe-activate'), 'open Stripe paperwork comes off');
  assert.deepEqual(sum.profile.overridden, ['payments'], 'the code has Stripe, so the report says it was turned off');
  assert.equal(s.steps.payments.status, 'running', 'progress is kept');
  assert.match(s.log.at(-1).msg, /Takes payments: no \(set by you\)/);

  // Can't record progress on a step that doesn't apply, and the error says how to fix it.
  assert.throws(() => state.setStep(s, 'paywall', 'done'), /turn that on under "What this app does"/);
  assert.throws(() => state.setCheck(s, 'pay-e2e', true), /doesn't apply/);

  state.setFeature(s, 'payments', null);
  sum = state.summarize(s);
  assert.equal(sum.features.payments, true, 'back to what the scan found');
  assert.equal(sum.checklist.find((c) => c.id === 'pay-products').done, true);
  assert.ok(keys(s).includes('stripe-activate'));
  assert.equal(s.profile.set.payments, undefined);
});

test('finished paperwork stays when it stops applying', () => {
  const dir = makeApp('shop2', {
    'package.json': { name: 'shop2', dependencies: { next: '15', react: '19', stripe: '17' } },
  });
  const s = state.initProject(dir);
  const t = s.tasks.find((x) => x.key === 'stripe-activate');
  state.setTaskDone(s, t.id);
  state.setFeature(s, 'payments', false);
  assert.ok(s.tasks.find((x) => x.key === 'stripe-activate' && x.done));
});

test('turning a feature on adds what it needs, and the owner\'s word survives a rescan', () => {
  const dir = makeApp('notes', {
    'package.json': { name: 'notes', dependencies: { next: '15', react: '19' } },
  });
  let s = state.initProject(dir);
  state.setFeature(s, 'community', true);
  state.setFeature(s, 'accounts', true);
  let sum = state.summarize(s);
  assert.ok(ids(sum.steps).includes('safety'));
  assert.ok(ids(sum.steps).includes('auth'));
  assert.ok(ids(sum.checklist).includes('ugc-report'));
  assert.equal(sum.features.database, true, 'implied by accounts');
  state.saveState(s);

  s = state.initProject(dir);
  assert.equal(featuresOf(s).community, true);
  assert.equal(featuresOf(s).accounts, true);
});

test('a step under way keeps its feature on, so a launch half done isn\'t lost', () => {
  const dir = makeApp('blank', {
    'package.json': { name: 'blank', dependencies: { next: '15', react: '19' } },
  });
  const s = state.initProject(dir);
  s.steps.payments = { status: 'done', provider: 'stripe', note: null, updatedAt: null };
  const p = profileView(s);
  const pay = p.features.find((f) => f.id === 'payments');
  assert.equal(pay.on, true);
  assert.equal(pay.source, 'launch');
});

test('older states without a profile still get every step that applied before', () => {
  // No profile at all, as saved before this change, with Stripe from detect.mjs.
  const old = { platforms: ['web'], integrations: { stripe: true }, payments: ['stripe'], steps: {}, checklist: {}, tasks: [] };
  assert.equal(featuresOf(old).payments, true);
  // And the catalog with no features passed still lists everything.
  assert.equal(stepsFor(['web']).length, STEPS.filter((s) => !s.platforms || s.platforms.includes('web')).length);
  assert.equal(checklistFor(['web', 'ios', 'android']).length, CHECKLIST.length);
});

test('size: simple, standard and complex', () => {
  assert.equal(sizeOf(['web'], {}), 'simple');
  assert.equal(sizeOf(['web'], { ai: true }), 'simple');
  assert.equal(sizeOf(['web'], { payments: true, accounts: true }), 'standard');
  assert.equal(sizeOf(['ios', 'android'], { payments: true, accounts: true, database: true, email: true }), 'complex');
});

test('confirming is logged once', () => {
  const s = state.initProject(makeApp('c', { 'package.json': { name: 'c', dependencies: { next: '15' } } }));
  state.confirmProfile(s);
  state.confirmProfile(s);
  assert.ok(s.profile.confirmedAt);
  assert.equal(s.log.filter((l) => l.msg === 'Confirmed what the app does').length, 1);
  assert.throws(() => state.setFeature(s, 'crypto', true), /Unknown feature/);
});

test('CLI: liftoff profile shows, corrects and confirms', () => {
  const dir = makeApp('cli-app', { 'package.json': { name: 'cli-app', dependencies: { next: '15', react: '19', stripe: '17' } } });
  const run = (...a) => execFileSync('node', [CLI, ...a, '--dir', dir], { env: process.env }).toString();
  run('init');
  assert.match(run('profile'), /Takes payments/);
  run('profile', 'payments', 'off');
  let p = JSON.parse(run('profile', '--json'));
  assert.equal(p.features.find((f) => f.id === 'payments').on, false);
  run('profile', '--confirm');
  p = JSON.parse(run('profile', '--json'));
  assert.ok(p.confirmedAt);
  const plan = JSON.parse(run('plan', '--json'));
  assert.equal(plan.features.payments, false);
});

test('Flight Board API: POST profile changes what the app does', async () => {
  const dir = makeApp('board-app', { 'package.json': { name: 'board-app', dependencies: { next: '15', react: '19', stripe: '17' } } });
  state.initProject(dir);
  const { server, url: u } = await startServer({ port: 0 });
  const url = u.replace('localhost', '127.0.0.1');
  const post = (body) => fetch(`${url}/api/apps/board-app/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let app = await (await post({ feature: 'payments', on: false })).json();
    assert.equal(app.features.payments, false);
    assert.ok(!app.steps.some((s) => s.id === 'payments'));
    app = await (await post({ confirm: true })).json();
    assert.ok(app.profile.confirmedAt);
    assert.equal((await post({ feature: 'nope', on: true })).status, 400);
  } finally {
    server.close();
  }
});
