// The test browser: its network guard, the purchase run against a fake app
// and fake Checkout, and the signed job API Liftoff Cloud drives.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { resolveTarget, startGuard } from '../guard.mjs';
import { runPurchase } from '../purchase.mjs';
import { createWorker } from '../server.mjs';
import { signRequest, checkSignature, HEADER } from '../protocol.mjs';
import { startFakeApp } from './fake-app.mjs';

const SECRET = 'test-secret-test-secret-test-secret-42';
const FAST = { page: 8000, checkout: 8000, back: 8000, pro: 8000, cancel: 8000 };
const lookupAs = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

test('the guard lets the browser reach the public web and nothing else', async () => {
  const pub = lookupAs('93.184.215.14');
  assert.equal((await resolveTarget('shop.example.com', 443, { lookup: pub })).address, '93.184.215.14');
  const refused = async (host, port, lookup = pub) => assert.rejects(resolveTarget(host, port, { lookup }));
  await refused('shop.example.com', 25); // no SMTP or other ports
  await refused('shop.example.com', 8080);
  await refused('127.0.0.1', 443);
  await refused('[::1]', 443);
  await refused('169.254.169.254', 80); // cloud metadata
  await refused('::ffff:10.0.0.7', 443);
  await refused('liftoff-cloud', 443); // a Render private-network name
  await refused('db.internal', 443);
  await refused('localhost', 443);
  await refused('rebind.example.com', 443, lookupAs('93.184.215.14', '10.0.0.7'));
  await refused('nowhere.example.com', 443, async () => { throw new Error('ENOTFOUND'); });
  // Tests may reach local addresses on purpose.
  assert.equal((await resolveTarget('127.0.0.1', 8123, { allowPrivate: true })).address, '127.0.0.1');

  // The real proxy refuses a tunnel to a private address.
  const guard = await startGuard();
  const status = await new Promise((resolve) => {
    const { port } = new URL(guard.url);
    http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: '10.0.0.7:443' }).on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    }).on('error', () => resolve(0)).end();
  });
  assert.equal(status, 403);
  assert.match(guard.blocked[0], /10\.0\.0\.7:443: 10\.0\.0\.7 is a private address/);
  await guard.close();
});

test('signatures are tied to the method, path, body and time', () => {
  const sig = signRequest(SECRET, 'POST', '/jobs', '{"a":1}');
  assert.equal(checkSignature(SECRET, sig, 'POST', '/jobs', '{"a":1}').ok, true);
  assert.equal(checkSignature(SECRET, sig, 'POST', '/jobs', '{"a":2}').why, 'bad signature');
  assert.equal(checkSignature(SECRET, sig, 'POST', '/jobs/x/stop', '{"a":1}').why, 'bad signature');
  assert.equal(checkSignature('another-secret-another-secret-123456', sig, 'POST', '/jobs', '{"a":1}').why, 'bad signature');
  assert.equal(checkSignature(SECRET, sig, 'POST', '/jobs', '{"a":1}', Date.now() + 301000).why, 'stale signature');
  assert.equal(checkSignature(SECRET, '', 'GET', '/jobs').why, 'unsigned request');
});

test('a purchase run signs up, pays, sees Pro, waits for the cancel, and sees Pro lock', async () => {
  const app = await startFakeApp();
  try {
    let waitedFor = null;
    const email = 'liftoff+t1@example.com';
    const out = await runPurchase({
      chromium, url: app.url, email, password: 'Lf-test-pass-9!', allowPrivate: true, checkoutHost: app.checkoutHost, timeouts: FAST,
      onWait: async (sessionId) => {
        waitedFor = sessionId;
        app.lock(email);
        return { cancelled: true, detail: 'Liftoff cancelled sub_123 in Stripe' };
      },
    });
    assert.equal(out.ok, true, out.detail);
    assert.deepEqual(out.steps.map((s) => s.name), ['open', 'sign-up', 'checkout', 'pro', 'cancel', 'locked']);
    assert.match(out.sessionId, /^cs_test_a1/);
    assert.equal(waitedFor, out.sessionId);
    assert.equal(app.sessions.get(out.sessionId).paid, true);
    assert.match(out.steps[1].detail, /liftoff\+t1@example\.com/);
    assert.equal(out.steps[4].detail, 'Liftoff cancelled sub_123 in Stripe');
    // Screenshots are JPEGs, except for the cancel (done in Stripe, not the browser).
    for (const s of out.steps) {
      if (s.name === 'cancel') assert.equal(s.shot, undefined);
      else assert.equal(s.shot.subarray(0, 3).toString('hex'), 'ffd8ff', `${s.name} has a JPEG`);
    }
  } finally {
    await app.close();
  }
});

test('a purchase run stops at the first broken step and says why', async () => {
  const opts = (app, extra = {}) => ({ chromium, url: app.url, email: 'liftoff+t2@example.com', password: 'Lf-test-pass-9!', allowPrivate: true, checkoutHost: app.checkoutHost, timeouts: FAST, onWait: async () => ({ cancelled: true }), ...extra });

  let app = await startFakeApp({ upgrade: false });
  let out = await runPurchase(opts(app));
  await app.close();
  assert.equal(out.ok, false);
  assert.equal(out.failedAt, 'sign-up');
  assert.match(out.detail, /no data-testid="upgrade-button"/);
  assert.equal(out.steps.at(-1).ok, false);
  assert.ok(out.steps.at(-1).shot, 'the failure has a screenshot');

  // A live Checkout is refused before any card is entered.
  app = await startFakeApp({ live: true });
  out = await runPurchase(opts(app));
  assert.equal(out.failedAt, 'checkout');
  assert.equal(out.refused, true);
  assert.match(out.detail, /LIVE Stripe Checkout/);
  assert.equal([...app.sessions.values()][0].paid, false);
  await app.close();

  // Paid, but the webhook never unlocks Pro.
  app = await startFakeApp({ unlock: false });
  out = await runPurchase(opts(app, { timeouts: { ...FAST, pro: 2500 } }));
  await app.close();
  assert.equal(out.failedAt, 'pro');
  assert.match(out.detail, /pro-active" didn't appear/);

  // Without allowPrivate, the guard keeps the browser off local addresses.
  app = await startFakeApp();
  out = await runPurchase(opts(app, { allowPrivate: false }));
  await app.close();
  assert.equal(out.failedAt, 'open');
  assert.match(out.detail, /Liftoff blocked it .*127\.0\.0\.1/);
});

test('the worker API: signed requests only, one job at a time, a pause for the cancel', async () => {
  const app = await startFakeApp();
  const worker = createWorker({ secret: SECRET, chromium, allowPrivate: true, checkoutHost: app.checkoutHost, timeouts: FAST });
  await new Promise((r) => worker.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${worker.server.address().port}`;
  const call = async (method, path, body, { sign = true, sig } = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = { 'content-type': 'application/json' };
    if (sign) headers[HEADER] = sig || signRequest(SECRET, method, path, text);
    const r = await fetch(`${base}${path}`, { method, headers, body: text || undefined });
    return { status: r.status, body: await r.json() };
  };
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  try {
    assert.deepEqual((await call('GET', '/healthz', undefined, { sign: false })).body, { ok: true, busy: false });
    const email = 'liftoff+t3@example.com';
    const job = { url: app.url, email, password: 'Lf-test-pass-9!' };
    assert.equal((await call('POST', '/jobs', job, { sign: false })).status, 401);
    assert.equal((await call('POST', '/jobs', job, { sig: signRequest('another-secret-another-secret-123456', 'POST', '/jobs', JSON.stringify(job)) })).status, 401);
    assert.equal((await call('POST', '/jobs', { ...job, url: 'ftp://x' })).status, 400);

    const sig = signRequest(SECRET, 'POST', '/jobs', JSON.stringify(job));
    const started = await call('POST', '/jobs', job, { sig });
    assert.equal(started.status, 202);
    const { id } = started.body;
    assert.match(id, /^j_/);
    assert.equal((await call('POST', '/jobs', job, { sig })).body.error, 'replayed request');
    assert.equal((await call('POST', '/jobs', job)).status, 409, 'one job at a time');

    const waiting = await until(async () => {
      const j = (await call('GET', `/jobs/${id}`)).body;
      return j.phase === 'waiting' && j;
    });
    assert.match(waiting.sessionId, /^cs_test_/);
    assert.deepEqual(waiting.steps.map((s) => s.name), ['open', 'sign-up', 'checkout', 'pro']);
    assert.equal(waiting.result, undefined);
    app.lock(email);
    assert.equal((await call('POST', `/jobs/${id}/continue`, { cancelled: true, detail: 'Cancelled sub_9 in Stripe' })).status, 200);
    assert.equal((await call('POST', `/jobs/${id}/continue`, { cancelled: true })).status, 409);

    const finished = await until(async () => {
      const j = (await call('GET', `/jobs/${id}`)).body;
      return j.phase === 'done' && j;
    });
    assert.equal(finished.result.ok, true, finished.result.detail);
    assert.equal(finished.result.steps.length, 6);
    assert.match(finished.result.steps[0].shot, /^\/9j\//, 'screenshots come back as base64 JPEG');
    assert.equal((await call('GET', '/healthz', undefined, { sign: false })).body.busy, false);
    assert.equal((await call('GET', '/jobs/j_AAAAAAAAAAAAAAAA')).status, 404);
  } finally {
    await worker.close();
    await app.close();
  }
  assert.throws(() => createWorker({ secret: 'short' }), /32\+ random characters/);
});
