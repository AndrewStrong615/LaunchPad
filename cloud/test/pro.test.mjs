// Pro, the monthly plan per app that pays for watching it: Stripe Checkout
// in subscription mode, the days that come with the Launch Pass, cancelling
// and renewing, Stripe's billing page, and the webhook that keeps it in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { zipDirectory } from '../lib/archive.mjs';
import { FIXTURES, signIn, startTest } from './helpers.mjs';

const KEY = 'sk_test_liftoff_own_account';
const WHSEC = 'whsec_test_liftoff_webhook_secret';
const PAID = { LIFTOFF_STRIPE_SECRET_KEY: KEY, LIFTOFF_STRIPE_WEBHOOK_SECRET: WHSEC };
const DAY = 86_400_000;
const rand = () => crypto.randomBytes(10).toString('hex');

// Liftoff's own Stripe account: Checkout, subscriptions and the billing page.
function fakeStripe() {
  const s = { sessions: new Map(), subs: new Map(), created: [], portals: [], failSubUpdates: false };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  s.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host !== 'api.stripe.com') return json({ error: { message: `fake: ${u.host}` } }, 404);
    const form = opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : {};
    if (u.pathname === '/v1/checkout/sessions' && opts.method === 'POST') {
      const id = `cs_test_${rand()}`;
      const session = { id, object: 'checkout.session', mode: form.mode, url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid', subscription: null, customer: form.customer || null, livemode: false, metadata: { kind: form['metadata[kind]'], uid: form['metadata[uid]'], slug: form['metadata[slug]'] }, form };
      s.sessions.set(id, session);
      s.created.push(form);
      return json(session);
    }
    let m = /^\/v1\/checkout\/sessions\/(cs_\w+)$/.exec(u.pathname);
    if (m && opts.method === 'GET') return s.sessions.has(m[1]) ? json(s.sessions.get(m[1])) : json({ error: { message: 'No such checkout.session' } }, 404);
    m = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(u.pathname);
    if (m && opts.method === 'GET') return s.subs.has(m[1]) ? json(s.subs.get(m[1])) : json({ error: { message: 'No such subscription' } }, 404);
    if (m && opts.method === 'POST') {
      if (s.failSubUpdates) return json({ error: { message: 'fake: down' } }, 500);
      const sub = s.subs.get(m[1]);
      if (!sub) return json({ error: { message: 'No such subscription' } }, 404);
      if ('cancel_at_period_end' in form) sub.cancel_at_period_end = form.cancel_at_period_end === 'true';
      return json(sub);
    }
    if (u.pathname === '/v1/billing_portal/sessions' && opts.method === 'POST') {
      s.portals.push(form);
      return json({ id: `bps_${rand()}`, url: `https://billing.stripe.com/p/session/test_${rand()}` });
    }
    return json({ error: { message: `fake: no route ${u.pathname}` } }, 404);
  };
  // The person pays on Checkout: Stripe makes the subscription. Newer API
  // versions keep the period on the subscription's item, as here.
  s.subscribe = (sessionId, { metadata } = {}) => {
    const session = s.sessions.get(sessionId);
    const f = session.form;
    const trialEnd = f['subscription_data[trial_end]'] ? Number(f['subscription_data[trial_end]']) : null;
    const id = `sub_test_${rand()}`;
    const sub = {
      id,
      object: 'subscription',
      status: trialEnd ? 'trialing' : 'active',
      customer: f.customer || `cus_test_${rand()}`,
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: trialEnd,
      livemode: false,
      items: { data: [{ current_period_end: trialEnd || Math.floor((Date.now() + 30 * DAY) / 1000) }] },
      metadata: metadata || { kind: f['subscription_data[metadata][kind]'], uid: f['subscription_data[metadata][uid]'], slug: f['subscription_data[metadata][slug]'] },
    };
    s.subs.set(id, sub);
    Object.assign(session, { status: 'complete', payment_status: trialEnd ? 'no_payment_required' : 'paid', subscription: id, customer: sub.customer });
    return sub;
  };
  s.pay = (id) => Object.assign(s.sessions.get(id), { status: 'complete', payment_status: 'paid', amount_total: 14900, currency: 'usd' });
  s.last = () => [...s.sessions.values()].at(-1);
  return s;
}

const sign = (raw, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', WHSEC).update(`${t}.${raw}`).digest('hex')}`;

async function setup({ env = PAID } = {}) {
  const stripe = fakeStripe();
  const t = await startTest({ env, fetch: stripe.fetch });
  const me = await signIn(t.base);
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
  const slug = (await me.call('POST', '/api/import/zip?name=invoicely.zip', zip, { 'content-type': 'application/zip' })).body.slug;
  const uid = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
  t.ctx.store.updateApp(uid, slug, (s) => { s.liveUrl = 'https://invoicely.example/'; });
  const app = async () => (await me.get(`/api/apps/${slug}`)).body;
  const back = (id) => fetch(`${t.base}/billing/done?session_id=${id}`, { redirect: 'manual', headers: { cookie: me.cookie } });
  const hook = (event) => {
    const raw = JSON.stringify(event);
    return fetch(`${t.base}/billing/stripe-webhook`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) } });
  };
  const billingFile = path.join(t.dataDir, 'users', uid, 'billing.json');
  const editBilling = (fn) => {
    const b = JSON.parse(fs.readFileSync(billingFile, 'utf8'));
    fn(b);
    fs.writeFileSync(billingFile, JSON.stringify(b));
  };
  const log = () => fs.readFileSync(path.join(t.dataDir, 'billing', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { t, me, stripe, slug, uid, app, back, hook, editBilling, log, zip };
}

test('Pro: Checkout starts a monthly plan, and watching follows it', async () => {
  const { t, me, stripe, slug, uid, app, back, hook, log } = await setup();
  try {
    let a = await app();
    assert.equal(a.cloud.watch.watching, false);
    assert.equal(a.cloud.watch.why, 'not-pro');
    assert.equal(a.cloud.watch.pro.via, 'none');
    assert.deepEqual(a.cloud.pass.pro, { usd: 29, billingPage: false });

    let r = await me.post(`/api/apps/${slug}/pro`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.url, /^https:\/\/checkout\.stripe\.com\//);
    const form = stripe.created.at(-1);
    assert.equal(form.mode, 'subscription');
    assert.equal(form['line_items[0][price_data][unit_amount]'], '2900');
    assert.equal(form['line_items[0][price_data][recurring][interval]'], 'month');
    assert.equal(form['line_items[0][price_data][product_data][name]'], 'Liftoff Pro');
    assert.match(form['line_items[0][price_data][product_data][description]'], /^Liftoff watches /);
    assert.deepEqual([form['subscription_data[metadata][kind]'], form['subscription_data[metadata][uid]'], form['subscription_data[metadata][slug]']], ['pro', uid, slug]);
    assert.equal(form['subscription_data[trial_end]'], undefined, 'no Launch Pass, so nothing to wait for');
    assert.equal(form.customer, undefined);
    assert.equal(form.cancel_url, `${t.base}/#${slug}`);
    const id = stripe.last().id;

    // Back before paying: nothing yet.
    assert.equal((await back(id)).headers.get('location'), `/?pro=pending#${slug}`);
    assert.equal((await app()).cloud.watch.watching, false);

    const sub = stripe.subscribe(id);
    assert.equal((await back(id)).headers.get('location'), `/?pro=ok#${slug}`);
    a = await app();
    assert.equal(a.cloud.watch.watching, true);
    assert.equal(a.cloud.watch.pro.via, 'pro');
    const periodEnd = new Date(sub.items.data[0].current_period_end * 1000).toISOString();
    assert.deepEqual(a.cloud.watch.pro.plan, { status: 'active', renewsAt: periodEnd, endsAt: null, chargesFrom: null, pastDue: false });
    assert.equal(a.cloud.pass.pro.billingPage, true);
    assert.equal(a.cloud.pass.unlocked, false, 'Pro pays for watching, not for the Launch Pass parts');
    assert.ok(a.log.some((l) => l.msg === 'Pro started'));
    assert.equal((await me.post(`/api/apps/${slug}/pro`)).status, 409, 'one plan per app');

    // Cancel (it runs to the end of the month), then keep it after all.
    assert.equal((await me.post(`/api/apps/${slug}/pro/renew`, { renew: 'no' })).status, 400);
    r = await me.post(`/api/apps/${slug}/pro/renew`, { renew: false });
    assert.equal(r.status, 200, r.text);
    assert.equal(stripe.subs.get(sub.id).cancel_at_period_end, true);
    assert.deepEqual(r.body.cloud.watch.pro.plan, { status: 'active', renewsAt: null, endsAt: periodEnd, chargesFrom: null, pastDue: false });
    assert.equal(r.body.cloud.watch.watching, true, 'still watching until the paid month ends');
    r = await me.post(`/api/apps/${slug}/pro/renew`, { renew: true });
    assert.equal(r.body.cloud.watch.pro.plan.renewsAt, periodEnd);
    assert.equal(r.body.cloud.watch.pro.plan.endsAt, null);

    // Stripe's own page for the card and invoices.
    r = await me.post(`/api/apps/${slug}/pro/billing`);
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.url, /^https:\/\/billing\.stripe\.com\//);
    assert.deepEqual(stripe.portals.at(-1), { customer: sub.customer, return_url: `${t.base}/#${slug}` });

    // A payment fails: watching carries on while Stripe retries. The event's
    // own copy is ignored in favour of what Stripe says now.
    stripe.subs.get(sub.id).status = 'past_due';
    assert.equal((await hook({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: sub.id, status: 'active', metadata: sub.metadata } } })).status, 200);
    a = await app();
    assert.equal(a.cloud.watch.pro.plan.pastDue, true);
    assert.equal(a.cloud.watch.watching, true);

    // Stripe gives up, or the month ends after a cancel: watching stops.
    stripe.subs.get(sub.id).status = 'canceled';
    await hook({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { id: sub.id, status: 'canceled', metadata: sub.metadata } } });
    a = await app();
    assert.equal(a.cloud.watch.watching, false);
    assert.equal(a.cloud.watch.why, 'not-pro');
    assert.ok(a.log.some((l) => l.msg === 'Pro ended'));
    assert.equal((await me.post(`/api/apps/${slug}/pro/renew`, { renew: true })).status, 404);

    // Every step is in the billing log, with ids only.
    const events = log().map((l) => l.event);
    assert.deepEqual(events.filter((e) => e.startsWith('pro')), ['pro-checkout', 'pro', 'pro', 'pro', 'pro', 'pro']);
    assert.deepEqual(log().filter((l) => l.event === 'pro').map((l) => l.status), ['active', 'active', 'active', 'past_due', 'canceled']);
    assert.doesNotMatch(JSON.stringify(log()), /Local developer/);

    // A new plan after the old one ended starts cleanly, on the same Stripe customer.
    r = await me.post(`/api/apps/${slug}/pro`);
    assert.equal(r.status, 200, r.text);
    assert.equal(stripe.created.at(-1).customer, sub.customer);
  } finally {
    await t.stop();
  }
});

test('Pro added during the Launch Pass days charges nothing until they end', async () => {
  const { t, me, stripe, slug, app, back, editBilling } = await setup();
  try {
    await me.post(`/api/apps/${slug}/pass`);
    const passSession = stripe.last().id;
    stripe.pay(passSession);
    await back(passSession);
    let a = await app();
    assert.equal(a.cloud.watch.pro.via, 'pass');
    assert.ok(a.cloud.pass.includes.includes('30 days of Liftoff watching the live app, with alerts'));
    const until = a.cloud.watch.pro.until;

    // With under two days of the pass's watching left, Pro just starts.
    editBilling((b) => { b.passes[slug].at = new Date(Date.now() - 29 * DAY).toISOString(); });
    assert.equal((await me.post(`/api/apps/${slug}/pro`)).status, 200);
    assert.equal(stripe.created.at(-1)['subscription_data[trial_end]'], undefined);
    editBilling((b) => { b.passes[slug].at = new Date(Date.parse(until) - 30 * DAY).toISOString(); });

    assert.equal((await me.post(`/api/apps/${slug}/pro`)).status, 200);
    const form = stripe.created.at(-1);
    assert.equal(form['subscription_data[trial_end]'], String(Math.floor(Date.parse(until) / 1000)));
    const id = stripe.last().id;
    stripe.subscribe(id);
    assert.equal((await back(id)).headers.get('location'), `/?pro=ok#${slug}`);
    a = await app();
    assert.equal(a.cloud.watch.pro.via, 'pro');
    assert.equal(a.cloud.watch.pro.plan.status, 'trialing');
    assert.equal(a.cloud.watch.pro.plan.chargesFrom, new Date(Math.floor(Date.parse(until) / 1000) * 1000).toISOString());
  } finally {
    await t.stop();
  }
});

test("Stripe's webhook starts Pro when the tab was closed, and ignores what isn't this app's", async () => {
  const { t, me, stripe, slug, app, hook, log } = await setup();
  try {
    await me.post(`/api/apps/${slug}/pro`);
    const first = stripe.last();
    const sub = stripe.subscribe(first.id);
    const unsigned = await fetch(`${t.base}/billing/stripe-webhook`, { method: 'POST', body: '{}', headers: { 'stripe-signature': 't=1,v1=00' } });
    assert.equal(unsigned.status, 400);
    assert.equal((await hook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: first } })).status, 200);
    assert.equal((await app()).cloud.watch.pro.via, 'pro');

    // A plan whose subscription says it's for someone else changes nothing.
    stripe.subs.set('sub_test_someoneelse01', { ...sub, id: 'sub_test_someoneelse01', metadata: { kind: 'pro', uid: 'u_someoneelse01', slug } });
    assert.equal((await hook({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_test_someoneelse01', metadata: { kind: 'pro', uid: 'u_someoneelse01', slug } } } })).status, 200);
    // Nor does an event whose subscription Stripe doesn't have: Stripe is asked to retry it.
    assert.equal((await hook({ id: 'evt_3', type: 'customer.subscription.updated', data: { object: { id: 'sub_test_madeup00000', metadata: sub.metadata } } })).status, 502);

    // A second plan for the same app (two Checkout tabs): the first stays,
    // and the second is in the log to refund.
    stripe.sessions.set('cs_test_secondtab0000001', { ...first, id: 'cs_test_secondtab0000001', form: first.form });
    const second = stripe.subscribe('cs_test_secondtab0000001');
    await hook({ id: 'evt_4', type: 'checkout.session.completed', data: { object: stripe.sessions.get('cs_test_secondtab0000001') } });
    assert.ok(log().some((l) => l.event === 'pro-duplicate' && l.sub === second.id && l.keeps === sub.id));
    second.status = 'canceled';
    await hook({ id: 'evt_5', type: 'customer.subscription.deleted', data: { object: { id: second.id, metadata: second.metadata } } });
    const a = await app();
    assert.equal(a.cloud.watch.pro.via, 'pro', 'the duplicate ending leaves the first plan alone');
    assert.equal(a.cloud.watch.watching, true);
  } finally {
    await t.stop();
  }
});

test("removing an app stops its Pro renewing, and isn't done when Stripe can't be told", async () => {
  const { t, me, stripe, slug, uid, back } = await setup();
  try {
    await me.post(`/api/apps/${slug}/pro`);
    const sub = stripe.subscribe(stripe.last().id);
    await back(stripe.last().id);
    stripe.failSubUpdates = true;
    const r = await me.del(`/api/apps/${slug}`);
    assert.equal(r.status, 502);
    assert.match(r.body.error, /Pro still renews/);
    assert.ok(t.ctx.store.loadApp(uid, slug), 'the app is still there');
    stripe.failSubUpdates = false;
    assert.equal((await me.del(`/api/apps/${slug}`)).status, 200);
    assert.equal(stripe.subs.get(sub.id).cancel_at_period_end, true);
    assert.equal(t.ctx.billing.subscription(uid, slug).cancelAt !== null, true, 'the month paid for is kept, in case the app comes back');
  } finally {
    await t.stop();
  }
});

test('Pro stays on a few days past the paid month if Stripe goes quiet, then stops', async () => {
  const { t, me, stripe, slug, uid, back, editBilling } = await setup();
  try {
    await me.post(`/api/apps/${slug}/pro`);
    stripe.subscribe(stripe.last().id);
    await back(stripe.last().id);
    editBilling((b) => { b.pro[slug].periodEnd = new Date(Date.now() - 2 * DAY).toISOString(); });
    assert.equal(t.ctx.billing.pro(uid, slug).via, 'pro');
    editBilling((b) => { b.pro[slug].periodEnd = new Date(Date.now() - 4 * DAY).toISOString(); });
    assert.equal(t.ctx.billing.pro(uid, slug).via, 'none');
  } finally {
    await t.stop();
  }
});

test('free accounts and servers without payments never see Pro checkout', async () => {
  let { t, me, slug } = await setup({ env: { ...PAID, LIFTOFF_FREE_LOGINS: 'you' } });
  try {
    const r = await me.post(`/api/apps/${slug}/pro`);
    assert.equal(r.status, 409);
    assert.equal((await me.get(`/api/apps/${slug}`)).body.cloud.watch.pro.via, 'free');
  } finally {
    await t.stop();
  }
  ({ t, me, slug } = await setup({ env: {} }));
  try {
    assert.equal((await me.post(`/api/apps/${slug}/pro`)).status, 404);
    assert.equal((await me.post(`/api/apps/${slug}/pro/billing`)).status, 404);
    assert.equal((await me.get(`/api/apps/${slug}`)).body.cloud.watch.pro.via, 'open');
  } finally {
    await t.stop();
  }
});
