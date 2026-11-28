// The Launch Pass: what it opens, Stripe Checkout and the webhook that grant
// it, and the tokens it includes.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zipDirectory } from '../lib/archive.mjs';
import { checkStripeSignature } from '../lib/billing.mjs';
import { fakeAnthropic } from './fake-anthropic.mjs';
import { FIXTURES, signIn, startTest, until } from './helpers.mjs';

const KEY = 'sk_test_liftoff_own_account';
const WHSEC = 'whsec_test_liftoff_webhook_secret';
const PAID = { env: { LIFTOFF_STRIPE_SECRET_KEY: KEY, LIFTOFF_STRIPE_WEBHOOK_SECRET: WHSEC } };

// Liftoff's own Stripe account, as Checkout sees it.
function fakeStripe() {
  const s = { sessions: new Map(), created: [], auth: new Set() };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  s.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host !== 'api.stripe.com') return json({ error: { message: `fake: ${u.host}` } }, 404);
    s.auth.add(opts.headers?.authorization);
    if (u.pathname === '/v1/checkout/sessions' && opts.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(opts.body));
      const id = `cs_test_${crypto.randomBytes(12).toString('hex')}`;
      const session = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid', amount_total: Number(form['line_items[0][price_data][unit_amount]']), currency: 'usd', livemode: false, metadata: { kind: form['metadata[kind]'], uid: form['metadata[uid]'], slug: form['metadata[slug]'] } };
      s.sessions.set(id, session);
      s.created.push(form);
      return json(session);
    }
    const m = /^\/v1\/checkout\/sessions\/(cs_\w+)$/.exec(u.pathname);
    if (m && opts.method === 'GET') return s.sessions.has(m[1]) ? json(s.sessions.get(m[1])) : json({ error: { message: 'No such checkout.session' } }, 404);
    return json({ error: { message: `fake: no route ${u.pathname}` } }, 404);
  };
  s.pay = (id) => Object.assign(s.sessions.get(id), { status: 'complete', payment_status: 'paid' });
  s.last = () => [...s.sessions.values()].at(-1);
  return s;
}

const sign = (raw, t = Math.floor(Date.now() / 1000), secret = WHSEC) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

async function setup({ env = PAID.env, anthropic } = {}) {
  const stripe = fakeStripe();
  const t = await startTest({ env, fetch: stripe.fetch, anthropic });
  const me = await signIn(t.base);
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
  const slug = (await me.call('POST', '/api/import/zip?name=invoicely.zip', zip, { 'content-type': 'application/zip' })).body.slug;
  const uid = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
  const pass = async () => (await me.get(`/api/apps/${slug}`)).body.cloud.pass;
  const back = (id, cookie = me.cookie) => fetch(`${t.base}/billing/done?session_id=${id}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return { t, me, stripe, slug, uid, pass, back, zip };
}

test('with billing off, nothing is locked', async () => {
  const { t, me, slug, pass } = await setup({ env: {} });
  try {
    assert.deepEqual(await pass(), { enabled: false, unlocked: true });
    assert.equal((await me.post(`/api/apps/${slug}/pass`)).status, 404);
    assert.equal((await me.post(`/api/apps/${slug}/report`)).status, 200);
  } finally {
    await t.stop();
  }
});

test('the paid parts need a Launch Pass, and Checkout grants it', async () => {
  const { t, me, stripe, slug, uid, pass, back } = await setup();
  try {
    let p = await pass();
    assert.equal(p.enabled, true);
    assert.equal(p.unlocked, false);
    assert.equal(p.testMode, true);
    assert.deepEqual(p.price, { usd: 149, tokens: 5000 }, 'the pass is charged in dollars and shown with its tokens');
    assert.equal(p.includes[0], 'Pilot runs the launch steps in the cloud');
    assert.equal(p.pass, null);

    // Free: the scan, verify and the score. Paid: runs, the purchase test, reports.
    assert.equal((await me.post(`/api/apps/${slug}/verify`)).status, 200);
    for (const [what, pathname] of [['runs', 'runs'], ['purchase test', 'proof'], ['report', 'report']]) {
      const r = await me.post(`/api/apps/${slug}/${pathname}`, {});
      assert.equal(r.status, 402, what);
      assert.match(r.body.error, /part of the Launch Pass for this app \(\$149, once\)/, what);
    }

    // Checkout, on Liftoff's own Stripe account.
    let r = await me.post(`/api/apps/${slug}/pass`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);
    const form = stripe.created[0];
    assert.match(form['line_items[0][price_data][product_data][description]'], /cloud runs with Pilot and 5,000 tokens/);
    assert.equal(form.mode, 'payment');
    assert.equal(form['line_items[0][price_data][unit_amount]'], '14900');
    assert.equal(form['line_items[0][price_data][currency]'], 'usd');
    assert.equal(form['metadata[uid]'], uid);
    assert.equal(form['metadata[slug]'], slug);
    assert.equal(form['payment_intent_data[metadata][slug]'], slug);
    assert.equal(form.success_url, `${t.base}/billing/done?session_id={CHECKOUT_SESSION_ID}`);
    assert.equal(form.cancel_url, `${t.base}/#${slug}`);
    assert.deepEqual([...stripe.auth], [`Bearer ${KEY}`]);
    const id = stripe.last().id;

    // Back before Stripe has the payment: nothing yet.
    let res = await back(id);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/?pass=pending#${slug}`);
    assert.equal((await pass()).unlocked, false);

    stripe.pay(id);
    res = await back(id);
    assert.equal(res.headers.get('location'), `/?pass=ok#${slug}`);
    p = await pass();
    assert.equal(p.unlocked, true);
    assert.deepEqual(p.pass.tokens, { included: 5000, used: 0, left: 5000, held: 0, usedUp: false });
    await back(id); // the same checkout again changes nothing
    assert.deepEqual((await pass()).pass.tokens, { included: 5000, used: 0, left: 5000, held: 0, usedUp: false });
    assert.equal((await me.post(`/api/apps/${slug}/pass`)).status, 409, 'one pass at a time');
    assert.equal((await me.post(`/api/apps/${slug}/report`)).status, 200, 'reports are open now');

    // Someone else's checkout, a made-up id, or no sign-in: no pass.
    stripe.sessions.set('cs_test_someoneelse0001', { id: 'cs_test_someoneelse0001', status: 'complete', payment_status: 'paid', metadata: { kind: 'launch_pass', uid: 'u_someoneelse01', slug } });
    assert.equal((await back('cs_test_someoneelse0001')).headers.get('location'), '/?pass=error');
    assert.equal((await back('cs_test_nope000000000001')).headers.get('location'), '/?pass=error');
    assert.equal((await back('../../v1/charges')).headers.get('location'), '/?pass=error');
    assert.equal((await back(id, null)).headers.get('location'), '/login');

    // Every checkout and payment is in the billing log, without names or emails.
    const log = fs.readFileSync(path.join(t.dataDir, 'billing', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(log.map((l) => l.event), ['checkout', 'paid']);
    assert.equal(log[1].amount, 14900);
    assert.equal(log[1].via, 'return');
    assert.doesNotMatch(JSON.stringify(log), /Local developer/);
  } finally {
    await t.stop();
  }
});

test("Stripe's webhook grants the pass when the tab was closed", async () => {
  const { t, me, stripe, slug, pass } = await setup();
  try {
    await me.post(`/api/apps/${slug}/pass`);
    const session = { ...stripe.last(), status: 'complete', payment_status: 'paid' };
    const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } });
    const hook = (body, signature, headers = {}) => fetch(`${t.base}/billing/stripe-webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'stripe-signature': signature, ...headers } });

    assert.equal((await hook(raw, 't=1,v1=00')).status, 400);
    assert.equal((await hook(raw, sign(raw, Math.floor(Date.now() / 1000) - 3600))).status, 400, 'an old signature');
    assert.equal((await hook(raw, sign(raw, undefined, 'whsec_wrong'))).status, 400);
    assert.equal((await hook(raw.replace('"paid"', '"unpaid"'), sign(raw))).status, 400, 'a changed body');
    const unpaid = JSON.stringify({ id: 'evt_0', type: 'checkout.session.completed', data: { object: { ...session, payment_status: 'unpaid' } } });
    assert.equal((await hook(unpaid, sign(unpaid))).status, 200);
    assert.equal((await pass()).unlocked, false, 'not paid yet (a bank transfer, say)');

    const ok = await hook(raw, sign(raw), { origin: 'https://evil.example' });
    assert.equal(ok.status, 200, 'Stripe sends no Origin of ours');
    assert.equal((await pass()).unlocked, true);
    await hook(raw, sign(raw));
    assert.deepEqual((await pass()).pass.tokens, { included: 5000, used: 0, left: 5000, held: 0, usedUp: false }, 'a retried event counts once');
    stripe.pay(session.id);
    assert.equal((await fetch(`${t.base}/billing/done?session_id=${session.id}`, { redirect: 'manual', headers: { cookie: me.cookie } })).headers.get('location'), `/?pass=ok#${slug}`);
  } finally {
    await t.stop();
  }
});

test('Stripe signatures', () => {
  const raw = '{"a":1}';
  assert.equal(checkStripeSignature(WHSEC, sign(raw), raw), true);
  assert.equal(checkStripeSignature(WHSEC, `${sign(raw)},v1=deadbeef`, raw), true, 'any v1 may match (secret rotation)');
  assert.equal(checkStripeSignature(WHSEC, sign(raw).replace(/v1=\w+/, 'v0=abc'), raw), false);
  assert.equal(checkStripeSignature(WHSEC, '', raw), false);
  assert.equal(checkStripeSignature(WHSEC, sign(raw, Math.floor(Date.now() / 1000) + 3600), raw), false);
});

test('runs spend the tokens on the pass, and removing the app keeps the count', async () => {
  const client = fakeAnthropic(async (s, tools) => tools.end('500'));
  const { t, me, stripe, slug, uid, pass, back, zip } = await setup({ anthropic: client });
  try {
    await me.post(`/api/apps/${slug}/pass`);
    const id = stripe.last().id;
    stripe.pay(id);
    await back(id);
    // An earlier run on this app cost $40.
    t.ctx.store.saveRun({ id: 'r_earlier01', uid, slug, status: 'finished', cost: 40, budgetUsd: 50, createdAt: new Date(Date.now() - 3600e3).toISOString(), steps: [], pending: [], events: [], seq: 0 });
    assert.deepEqual((await pass()).pass.tokens, { included: 5000, used: 4000, left: 1000, held: 0, usedUp: false });

    const run = async () => {
      const r = await me.post(`/api/apps/${slug}/runs`, { steps: ['hosting'] });
      if (r.status !== 200) return r;
      await until(async () => (await me.get(`/api/apps/${slug}/runs/${r.body.id}`)).body.status === 'finished');
      return r;
    };
    let r = await run();
    assert.equal(r.body.budgetTokens, 1000, 'the run gets what is left, not the usual 1,500 tokens');
    assert.equal(client.calls.find((c) => c[0] === 'sessions.create')[1].budget.max_list_cost.amount, '1000', 'the session gets the same cap, in cents');
    r = await run();
    assert.equal(r.body.budgetTokens, 500);
    assert.deepEqual((await pass()).pass.tokens, { included: 5000, used: 5000, left: 0, held: 0, usedUp: true });
    r = await run();
    assert.equal(r.status, 402);
    assert.match(r.body.error, /The 5,000 tokens that came with this app's Launch Pass are used up/);

    // Removing the app and importing it again doesn't reset the tokens.
    assert.equal((await me.del(`/api/apps/${slug}`)).status, 200);
    await me.call('POST', '/api/import/zip?name=invoicely.zip', zip, { 'content-type': 'application/zip' });
    assert.deepEqual((await pass()).pass.tokens, { included: 5000, used: 5000, left: 0, held: 0, usedUp: true });

    // Another pass adds the same again.
    r = await me.post(`/api/apps/${slug}/pass`);
    assert.equal(r.status, 200, r.text);
    stripe.pay(stripe.last().id);
    await back(stripe.last().id);
    assert.deepEqual((await pass()).pass.tokens, { included: 10000, used: 5000, left: 5000, held: 0, usedUp: false });
  } finally {
    await t.stop();
  }
});

test('free accounts skip the pass', async () => {
  const { t, me, slug, pass } = await setup({ env: { ...PAID.env, LIFTOFF_FREE_LOGINS: 'someone, YOU' } });
  try {
    const p = await pass();
    assert.equal(p.free, true);
    assert.equal(p.unlocked, true);
    assert.equal((await me.post(`/api/apps/${slug}/report`)).status, 200);
    assert.equal((await me.post(`/api/apps/${slug}/pass`)).status, 409);
  } finally {
    await t.stop();
  }
});
