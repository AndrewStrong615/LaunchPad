// Liftoff's own purchase test, from the cloud side: the Flight Board and
// Claude start it, a (fake) test browser runs it, this server cancels the
// subscription in (fake) Stripe, and Stripe's records decide pay-e2e.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { zipDirectory } from '../lib/archive.mjs';
import { runTool } from '../lib/tools.mjs';
import { checkSignature, HEADER } from '../../proof/protocol.mjs';
import { FIXTURES, signIn, startTest, until } from './helpers.mjs';

const SECRET = 'proof-secret-proof-secret-proof-secret';
const PREVIEW = 'https://invoicely-git-main-me.vercel.app';
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');

// A stand-in for proof/server.mjs that checks signatures and plays a script.
// outcome: 'pass' | 'no-pro' | 'live' | 'still-pro' (Pro stays on after the cancel)
async function fakeBrowser() {
  const b = { outcome: 'pass', jobs: new Map(), continued: [], seen: [], unsigned: 0 };
  const steps = (names) => names.map((name) => ({ name, ok: true, detail: `did ${name}`, shot: name === 'cancel' ? null : JPEG }));
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (!checkSignature(SECRET, req.headers[HEADER], req.method, url.pathname, raw).ok) {
      b.unsigned++;
      return send(401, { error: 'bad signature' });
    }
    b.seen.push(`${req.method} ${url.pathname}`);
    const body = raw ? JSON.parse(raw) : {};
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'POST' && parts.length === 1) {
      const id = `j_${String(b.jobs.size + 1).padStart(16, '0')}`;
      const job = { id, body, polls: 0, phase: 'running', sessionId: null };
      b.jobs.set(id, job);
      return send(202, { id });
    }
    const job = b.jobs.get(parts[1]);
    if (!job) return send(404, { error: 'No such job' });
    if (req.method === 'GET') {
      job.polls++;
      if (b.outcome === 'live' && job.polls > 1) {
        return send(200, { id: job.id, phase: 'done', steps: [], result: { ok: false, failedAt: 'checkout', refused: true, detail: 'Upgrade opened a LIVE Stripe Checkout.', steps: [...steps(['open', 'sign-up']), { name: 'checkout', ok: false, detail: 'live', shot: JPEG }] } });
      }
      if (b.outcome === 'no-pro' && job.polls > 1) {
        return send(200, { id: job.id, phase: 'done', steps: [], result: { ok: false, failedAt: 'pro', detail: 'Paid, but data-testid="pro-active" didn\'t appear', sessionId: 'cs_test_a1fresh0001', steps: [...steps(['open', 'sign-up', 'checkout']), { name: 'pro', ok: false, detail: 'no Pro', shot: JPEG }] } });
      }
      if (job.phase === 'running' && job.polls > 1 && !job.answer) {
        job.phase = 'waiting';
        job.sessionId = 'cs_test_a1fresh0001';
      }
      if (job.phase === 'waiting') return send(200, { id: job.id, phase: 'waiting', sessionId: job.sessionId, steps: steps(['open', 'sign-up', 'checkout', 'pro']).map(({ shot, ...s }) => ({ ...s, shot: !!shot })) });
      if (job.answer && b.outcome === 'still-pro') {
        const all = steps(['open', 'sign-up', 'checkout', 'pro', 'cancel']);
        all.push({ name: 'locked', ok: false, detail: 'Pro was still on after the cancel', shot: JPEG });
        return send(200, { id: job.id, phase: 'done', steps: [], result: { ok: false, failedAt: 'locked', detail: 'Cancelled in Stripe, but the app kept Pro switched on', sessionId: job.sessionId, steps: all } });
      }
      if (job.answer) {
        const names = job.answer.cancelled ? ['open', 'sign-up', 'checkout', 'pro', 'cancel', 'locked'] : ['open', 'sign-up', 'checkout', 'pro', 'cancel'];
        const all = steps(names);
        if (job.answer.detail) all[4].detail = job.answer.detail;
        all.push({ name: '../../evil', ok: true, detail: 'x', shot: JPEG }); // never trusted
        all[5].shot = Buffer.from('<svg onload=alert(1)>').toString('base64'); // not a JPEG: dropped
        return send(200, { id: job.id, phase: 'done', steps: [], result: { ok: !job.answer.error, failedAt: job.answer.error ? 'cancel' : undefined, detail: job.answer.error || 'Bought, Pro unlocked, cancelled, Pro locked again', sessionId: job.sessionId, steps: all } });
      }
      return send(200, { id: job.id, phase: 'running', steps: steps(['open']).map(({ shot, ...s }) => ({ ...s, shot: !!shot })) });
    }
    if (parts[2] === 'continue') {
      b.continued.push(body);
      job.answer = body;
      job.phase = 'running';
      return send(200, { id: job.id, phase: 'running' });
    }
    if (parts[2] === 'stop') return send(200, { id: job.id, stopping: true });
    return send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  b.url = `http://127.0.0.1:${server.address().port}`;
  b.close = () => new Promise((r) => server.close(() => r()));
  return b;
}

// Stripe test mode as the cancel and the pay-e2e check see it.
function fakeStripe() {
  const s = { cancelled: [], keys: [], delivered: true, successUrl: 'https://somewhere-else.example.com/thanks' };
  s.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.host !== 'api.stripe.com') return json({ error: { message: `fake stripe: ${u.host}` } }, 404);
    s.keys.push(opts.headers?.authorization);
    const p = u.pathname.replace('/v1/', '');
    const subStatus = s.cancelled.includes('sub_fresh') ? 'canceled' : 'active';
    const session = { id: 'cs_test_a1fresh0001', status: 'complete', mode: 'subscription', payment_status: 'paid', created: Math.floor(Date.now() / 1000) - 60, success_url: s.successUrl, subscription: { id: 'sub_fresh', status: subStatus } };
    if (p === 'checkout/sessions/cs_test_a1fresh0001') return json({ ...session, subscription: 'sub_fresh' });
    if (p === 'subscriptions/sub_fresh' && opts.method === 'DELETE') {
      s.cancelled.push('sub_fresh');
      return json({ id: 'sub_fresh', status: 'canceled' });
    }
    if (p === 'checkout/sessions') return json({ data: [session] });
    if (p === 'webhook_endpoints') return json({ data: [{ status: 'enabled', enabled_events: ['checkout.session.completed', 'customer.subscription.deleted'] }] });
    if (p === 'events') {
      const type = u.searchParams.get('type');
      const id = type === 'checkout.session.completed' ? session.id : 'sub_fresh';
      if (type === 'customer.subscription.deleted' && subStatus !== 'canceled') return json({ data: [] });
      return json({ data: [{ type, pending_webhooks: s.delivered ? 0 : 1, data: { object: { id } } }] });
    }
    return json({ error: { message: `fake stripe: no route ${p}` } }, 404);
  };
  return s;
}

const FAST = { pollMs: 20, settleMs: 20, timeoutMs: 20000 };

async function setup({ env = {} } = {}) {
  const browser = await fakeBrowser();
  const stripe = fakeStripe();
  const t = await startTest({ env: { LIFTOFF_PROOF_URL: browser.url.replace('http://', ''), LIFTOFF_PROOF_SECRET: SECRET, ...env }, safeFetch: stripe.fetch, proof: FAST });
  const me = await signIn(t.base);
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'), { prefix: 'next-saas/' });
  const r = await me.call('POST', '/api/import/zip?name=next-saas.zip', zip, { 'content-type': 'application/zip' });
  return { t, me, browser, stripe, slug: r.body.slug, close: async () => { await t.stop(); await browser.close(); } };
}

test('the Flight Board starts the purchase test; Stripe\'s records tick it', async () => {
  const { t, me, browser, stripe, slug, close } = await setup();
  try {
    let r = await me.get(`/api/apps/${slug}`);
    let proof = r.body.cloud.proof;
    assert.equal(proof.enabled, true);
    assert.equal(proof.applies, false, 'no sign of Stripe yet, so no card');
    assert.match((await me.post(`/api/apps/${slug}/proof`)).body.error, /web apps that take payments through Stripe/);

    await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_live_nope' } });
    assert.match((await me.get(`/api/apps/${slug}`)).body.cloud.proof.blocker, /live key/);
    await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_proof' } });
    assert.match((await me.get(`/api/apps/${slug}`)).body.cloud.proof.blocker, /preview\.url/);
    await me.post(`/api/apps/${slug}/settings`, { key: 'preview.url', value: `${PREVIEW}/pricing` });
    assert.equal((await me.post(`/api/apps/${slug}/settings`, { key: 'signup.path', value: '/../admin' })).status, 400);
    await me.post(`/api/apps/${slug}/settings`, { key: 'signup.path', value: '/signup' });

    r = await me.post(`/api/apps/${slug}/proof`);
    assert.equal(r.status, 200, r.text);
    assert.ok(['queued', 'running'].includes(r.body.cloud.proof.latest.status));
    assert.equal(r.body.cloud.proof.latest.url, `${PREVIEW}/signup`, 'the preview origin, at the sign-up page');
    // Pressing again joins the same test.
    const again = await me.post(`/api/apps/${slug}/proof`);
    assert.equal(again.body.cloud.proof.latest.id, r.body.cloud.proof.latest.id);
    assert.equal((await me.del(`/api/apps/${slug}`)).status, 409, "an app can't be deleted mid-test");

    proof = await until(async () => {
      const p = (await me.get(`/api/apps/${slug}`)).body.cloud.proof;
      return !['queued', 'running'].includes(p.latest.status) && p;
    }, { timeout: 10000 });
    assert.equal(proof.latest.status, 'passed', proof.latest.detail);
    assert.match(proof.latest.detail, /test purchase cs_test_…0001 .*paid, cancelled, and your webhook accepted both/);
    assert.equal(proof.latest.checkout, 'cs_test_…0001');

    // The browser asked for the job with a fresh test identity, and this server cancelled in Stripe.
    const job = [...browser.jobs.values()][0];
    assert.equal(job.body.url, `${PREVIEW}/signup`);
    assert.match(job.body.email, /^liftoff\+[a-f0-9]{12}@example\.com$/);
    assert.deepEqual(stripe.cancelled, ['sub_fresh']);
    assert.deepEqual(browser.continued, [{ cancelled: true, detail: 'Liftoff cancelled sub_fres…resh in Stripe, as the Billing Portal would' }]);
    assert.ok(stripe.keys.every((k) => k === 'Bearer sk_test_proof'));
    assert.equal(browser.unsigned, 0);

    // Steps, labels and screenshots; Stripe's word is the last step.
    // (The browser's step named ../../evil is dropped.)
    assert.deepEqual(proof.latest.steps.map((s) => s.name), ['open', 'sign-up', 'checkout', 'pro', 'cancel', 'locked', 'stripe']);
    assert.equal(proof.latest.steps[0].label, 'Open the app');
    assert.equal(proof.latest.steps.at(-1).label, 'Stripe’s records agree');
    assert.equal(proof.latest.steps[4].shot, null);
    assert.equal(proof.latest.steps[5].shot, null, 'a screenshot that is not a JPEG is dropped');
    assert.equal(proof.latest.steps[6].shot, null);
    const shot = proof.latest.steps[0].shot;
    assert.match(shot, new RegExp(`^/api/apps/${slug}/proof/p_[a-f0-9]{12}/01-open\\.jpg$`));
    const img = await me.get(shot);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await me.get(shot.replace('01-open', '../state'))).status, 404);
    assert.equal((await me.get(shot.replace(/p_[a-f0-9]+/, 'p_000000000000'))).status, 404);

    // pay-e2e is ticked by verify, not by the browser.
    const item = (await me.get(`/api/apps/${slug}`)).body.checklist.find((c) => c.id === 'pay-e2e');
    assert.equal(item.done, true);
    assert.equal(item.by, 'verified');
    assert.equal(proof.history[0].status, 'passed');
  } finally {
    await close();
  }
});

test('a broken purchase unticks pay-e2e; a live checkout or a missing browser does not', async () => {
  const { me, browser, slug, close } = await setup();
  try {
    await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_proof' } });
    await me.post(`/api/apps/${slug}/settings`, { key: 'preview.url', value: PREVIEW });
    const finished = () => until(async () => {
      const p = (await me.get(`/api/apps/${slug}`)).body.cloud.proof;
      return !['queued', 'running'].includes(p.latest.status) && p.latest;
    }, { timeout: 10000 });
    const payE2e = async () => (await me.get(`/api/apps/${slug}`)).body.checklist.find((c) => c.id === 'pay-e2e');

    // A first pass ticks it.
    await me.post(`/api/apps/${slug}/proof`);
    assert.equal((await finished()).status, 'passed');
    assert.equal((await payE2e()).done, true);

    // A live Checkout is refused: an error, and the tick stands.
    browser.outcome = 'live';
    await me.post(`/api/apps/${slug}/proof`);
    let rec = await finished();
    assert.equal(rec.status, 'error');
    assert.match(rec.detail, /LIVE Stripe Checkout/);
    assert.equal((await payE2e()).done, true);

    // Pro never unlocking is the app's fault: failed, and pay-e2e is unticked.
    browser.outcome = 'no-pro';
    await me.post(`/api/apps/${slug}/proof`);
    rec = await finished();
    assert.equal(rec.status, 'failed');
    assert.equal(rec.failedAt, 'pro');
    const item = await payE2e();
    assert.equal(item.done, false);
    assert.match(item.verify.detail, /Liftoff's purchase test failed: Paid, but data-testid="pro-active"/);
  } finally {
    await close();
  }

  // No test browser configured: the card says so and nothing starts.
  const t2 = await startTest();
  try {
    const me2 = await signIn(t2.base);
    const zip = zipDirectory(path.join(FIXTURES, 'next-saas'), { prefix: 'next-saas/' });
    const slug2 = (await me2.call('POST', '/api/import/zip?name=next-saas.zip', zip, { 'content-type': 'application/zip' })).body.slug;
    await me2.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_proof' } });
    const p = (await me2.get(`/api/apps/${slug2}`)).body.cloud.proof;
    assert.equal(p.enabled, false);
    assert.match(p.blocker, /isn't set up/);
  } finally {
    await t2.stop();
  }
});

test('a full Verify does not re-tick a purchase the test saw fail, until a test passes again', async () => {
  const { me, browser, stripe, slug, close } = await setup();
  try {
    await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_proof' } });
    await me.post(`/api/apps/${slug}/settings`, { key: 'preview.url', value: PREVIEW });
    // The purchase lands on the app's own preview, so the plain Verify sees it in Stripe too.
    stripe.successUrl = `${PREVIEW}/thanks`;
    const finished = () => until(async () => {
      const p = (await me.get(`/api/apps/${slug}`)).body.cloud.proof;
      return !['queued', 'running'].includes(p.latest.status) && p.latest;
    }, { timeout: 10000 });
    const payE2e = async () => (await me.get(`/api/apps/${slug}`)).body.checklist.find((c) => c.id === 'pay-e2e');

    // Cancelled users keep Pro: Stripe shows paid, cancelled and delivered, but the test failed.
    browser.outcome = 'still-pro';
    await me.post(`/api/apps/${slug}/proof`);
    const rec = await finished();
    assert.equal(rec.status, 'failed');
    assert.equal(rec.failedAt, 'locked');
    assert.equal((await payE2e()).done, false);

    // Pressing Verify again reads those Stripe records, and must not tick it back.
    let item = (await me.post(`/api/apps/${slug}/verify`)).body.checklist.find((c) => c.id === 'pay-e2e');
    assert.equal(item.done, false);
    assert.equal(item.verify.ok, false);
    assert.match(item.verify.detail, /the purchase test failed on \d{4}-\d{2}-\d{2} \(Cancelled in Stripe, but the app kept Pro switched on\), and there's no test purchase since/);

    // Once a test passes again, the plain Verify counts the purchases again.
    browser.outcome = 'pass';
    await me.post(`/api/apps/${slug}/proof`);
    assert.equal((await finished()).status, 'passed');
    item = (await me.post(`/api/apps/${slug}/verify`)).body.checklist.find((c) => c.id === 'pay-e2e');
    assert.equal(item.done, true, item.verify?.detail);
  } finally {
    await close();
  }
});

test('Claude runs the purchase test with liftoff_prove_purchase and reads every step', async () => {
  const { t, me, slug, close } = await setup();
  try {
    await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_proof' } });
    await me.post(`/api/apps/${slug}/settings`, { key: 'preview.url', value: PREVIEW });
    const run = { uid: devUid(t), slug };
    const out = await runTool(t.ctx, run, 'liftoff_prove_purchase', {});
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /^PASSED: test purchase cs_test_…0001/);
    assert.match(out.text, /✓ cancel: Liftoff cancelled sub_fres…resh in Stripe/);
    assert.match(out.text, /pay-e2e is ticked as verified/);

    // A hand tick is still refused, and points at the new tool.
    const tick = await runTool(t.ctx, run, 'liftoff_check', { item: 'pay-e2e' });
    assert.equal(tick.isError, true);
    assert.match(tick.text, /liftoff_prove_purchase/);
  } finally {
    await close();
  }
});

// The dev user's id, from the data folder the test server wrote.
function devUid(t) {
  return JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
}
