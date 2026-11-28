// Liftoff runs the app's purchase flow test itself. Its test browser (proof/,
// a private service that holds no keys) signs up on the app's test-mode
// deploy, buys Pro with Stripe's 4242 card and checks Pro unlocks. Then this
// server cancels the subscription with the user's Stripe test key, and the
// browser checks Pro locks again. The tick still comes from Stripe's own
// records for that one checkout (pay-e2e in lib/verify.mjs), never from the
// browser's word. Screenshots of each step are kept with the app.
//
// One test runs at a time across the server; the rest wait in a queue.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HEADER, signRequest, STEPS } from '../../proof/protocol.mjs';
import { applyVerify, sellsWithStripe } from '../../lib/verify.mjs';
import { stripeConnected, userEnv } from './accounts.mjs';
import { verifyApp } from './tools.mjs';
import { HttpError } from './http.mjs';

export const PROOF_ID = /^p_[a-f0-9]{12}$/;
const SHOT_FILE = /^\d{2}-[a-z-]{1,20}\.jpg$/;
const STEP_NAMES = new Set(STEPS.map(([id]) => id));
const LABEL = Object.fromEntries(STEPS);
const OPEN = new Set(['queued', 'running']);
// Failures in these steps are the app's own; they untick pay-e2e.
const APP_FAULT = new Set(['sign-up', 'checkout', 'pro', 'locked']);
const KEEP_RUNS = 5;
const MAX_SHOT = 2 * 1048576;
const MAX_QUEUE = 10;
const MAX_PER_HOUR = 10; // per app, however they're started

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (id) => `${id.slice(0, 8)}…${id.slice(-4)}`;
const isTestKey = (k) => /^(sk|rk)_test_/.test(k || '');

export class ProofRunner {
  constructor(ctx, { fetch = globalThis.fetch, pollMs = 2000, timeoutMs = 10 * 60000, settleMs = 3000 } = {}) {
    this.ctx = ctx;
    this.fetch = fetch;
    this.base = ctx.config.proof?.url || null;
    this.secret = ctx.config.proof?.secret || null;
    Object.assign(this, { pollMs, timeoutMs, settleMs });
    this.queue = Promise.resolve();
    this.jobs = new Map(); // `${uid}:${slug}` → { rec, done }
  }

  get enabled() {
    return !!(this.base && this.secret);
  }

  running(uid, slug) {
    return this.jobs.has(`${uid}:${slug}`);
  }

  // Where the test starts: the test-mode deploy (or the live site), at the sign-up page.
  target(state) {
    const base = state.config?.['preview.url'] || state.liveUrl;
    if (!base) return null;
    try {
      return new URL(state.config?.['signup.path'] || '/', base).href;
    } catch {
      return null;
    }
  }

  // A web app that pays through Stripe (sellsWithStripe in lib/verify.mjs).
  applies(uid, state) {
    return sellsWithStripe(state, { stripeConnected: stripeConnected(this.ctx.store, uid) });
  }

  // Why a test can't start for this app now, or null.
  blocker(uid, state) {
    if (!this.enabled) return "Liftoff's test browser isn't set up on this server.";
    if (!this.applies(uid, state)) return 'Liftoff runs the purchase test for web apps that take payments through Stripe.';
    const key = userEnv(this.ctx.store, uid, ['stripe']).STRIPE_SECRET_KEY;
    if (!key) return 'Connect Stripe with a test-mode key on the Accounts page.';
    if (!isTestKey(key)) return 'The connected Stripe key is a live key. Connect a test-mode key (sk_test_…) so the test never charges a real card.';
    if (!this.target(state)) return 'Set preview.url to a deploy that uses Stripe test keys (or record the live deploy first).';
    return null;
  }

  // What the Flight Board shows.
  view(uid, state) {
    const p = state.proof || {};
    let latest = p.latest || null;
    if (latest && OPEN.has(latest.status) && !this.running(uid, state.slug)) {
      latest = { ...latest, status: 'error', detail: 'The server restarted during the test. Run it again.' };
    }
    const applies = this.applies(uid, state);
    return {
      enabled: this.enabled,
      applies,
      blocker: applies ? this.blocker(uid, state) : null,
      url: this.target(state),
      latest: latest ? publicRecord(latest, state.slug) : null,
      history: (p.history || []).slice(0, 5),
    };
  }

  // Start (or join) the test for this app. Returns { rec, done }; `done`
  // resolves with the finished record and never rejects.
  start(uid, slug) {
    const key = `${uid}:${slug}`;
    if (this.jobs.has(key)) return this.jobs.get(key);
    const state = this.ctx.store.loadApp(uid, slug);
    if (!state) throw new HttpError(404, 'No such app');
    const why = this.blocker(uid, state);
    if (why) throw new HttpError(400, why);
    if (this.jobs.size >= MAX_QUEUE) throw new HttpError(429, `Liftoff's test browser already has ${MAX_QUEUE} tests waiting. Try again in a few minutes.`);
    const lastHour = (state.proof?.history || []).filter((x) => Date.now() - Date.parse(x.at) < 3600000).length;
    if (lastHour >= MAX_PER_HOUR) throw new HttpError(429, `This app has had ${MAX_PER_HOUR} purchase tests in the last hour. Try again later.`);
    const rec = { id: `p_${crypto.randomBytes(6).toString('hex')}`, status: 'queued', url: this.target(state), createdAt: new Date().toISOString(), steps: [] };
    this.save(uid, slug, rec);
    const done = this.queue.then(() => this.run(uid, slug, rec));
    this.queue = done;
    const job = { rec, done };
    this.jobs.set(key, job);
    done.then(() => this.jobs.delete(key));
    return job;
  }

  save(uid, slug, rec, final = false) {
    this.ctx.store.updateApp(uid, slug, (s) => {
      s.proof ||= { latest: null, history: [] };
      s.proof.latest = rec;
      if (final) {
        s.proof.history = [{ id: rec.id, at: rec.endedAt, status: rec.status, detail: rec.detail }, ...(s.proof.history || [])].slice(0, 10);
        s.log.push({ at: rec.endedAt, msg: `Purchase test ${rec.status}: ${rec.detail}` });
      }
    });
  }

  async call(method, pathname, body) {
    const text = body === undefined ? '' : JSON.stringify(body);
    let res;
    try {
      res = await this.fetch(`${this.base}${pathname}`, {
        method,
        headers: { 'content-type': 'application/json', [HEADER]: signRequest(this.secret, method, pathname, text) },
        body: text || undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error(`Couldn't reach Liftoff's test browser (${e.cause?.code || e.message})`);
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(res.status === 409 ? "Liftoff's test browser is busy" : `Liftoff's test browser answered ${res.status}: ${out.error || 'no details'}`), { status: res.status });
    return out;
  }

  async stripe(key, method, pathname) {
    const res = await this.ctx.safeFetch(`https://api.stripe.com/v1/${pathname}`, { method, headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Stripe answered ${res.status}${out.error?.message ? `: ${out.error.message}` : ''}`);
    return out;
  }

  // Cancel the test subscription, as the Billing Portal would. The answer goes
  // to the browser: { cancelled, detail } or { error }.
  async cancel(uid, sessionId) {
    const key = userEnv(this.ctx.store, uid, ['stripe']).STRIPE_SECRET_KEY;
    if (!isTestKey(key)) return { error: 'The connected Stripe key is no longer a test-mode key, so Liftoff stopped before cancelling.' };
    if (!/^cs_test_[A-Za-z0-9]{1,200}$/.test(sessionId || '')) return { error: 'The browser reported a checkout that is not in test mode.' };
    let sess;
    try {
      sess = await this.stripe(key, 'GET', `checkout/sessions/${sessionId}`);
    } catch (e) {
      return { error: `Couldn't read the checkout from Stripe: ${e.message}` };
    }
    if (sess.status !== 'complete') return { error: `Stripe shows the checkout as ${sess.status || 'unknown'}, not complete` };
    if (sess.mode !== 'subscription') return { cancelled: false, detail: 'One-time purchase: nothing to cancel' };
    const sub = typeof sess.subscription === 'string' ? sess.subscription : sess.subscription?.id;
    if (!/^sub_[A-Za-z0-9]{1,200}$/.test(sub || '')) return { error: 'Stripe shows no subscription for this checkout' };
    try {
      await this.stripe(key, 'DELETE', `subscriptions/${sub}`);
    } catch (e) {
      return { error: `Stripe wouldn't cancel ${short(sub)}: ${e.message}` };
    }
    return { cancelled: true, detail: `Liftoff cancelled ${short(sub)} in Stripe, as the Billing Portal would` };
  }

  async run(uid, slug, rec) {
    const t0 = Date.now();
    const finish = (status, detail, extra = {}) => {
      Object.assign(rec, { status, detail: String(detail).slice(0, 500), endedAt: new Date().toISOString(), ms: Date.now() - t0 }, extra);
      this.save(uid, slug, rec, true);
      return rec;
    };
    let jobId = null;
    try {
      Object.assign(rec, { status: 'running', startedAt: new Date().toISOString() });
      this.save(uid, slug, rec);
      const job = { url: rec.url, email: `liftoff+${rec.id.slice(2)}@example.com`, password: `Lf-${crypto.randomBytes(9).toString('base64url')}-9!` };
      // The browser can still be finishing a test from before a restart.
      for (;;) {
        try {
          jobId = (await this.call('POST', '/jobs', job)).id;
          break;
        } catch (e) {
          if (e.status !== 409 || Date.now() - t0 > this.timeoutMs / 2) throw e;
          await sleep(this.pollMs * 5);
        }
      }
      let answered = false;
      let cur;
      for (;;) {
        if (Date.now() - t0 > this.timeoutMs) throw new Error(`The test took longer than ${Math.round(this.timeoutMs / 60000)} minutes, so Liftoff stopped it`);
        await sleep(this.pollMs);
        cur = await this.call('GET', `/jobs/${jobId}`);
        rec.steps = (cur.steps || []).filter((s) => STEP_NAMES.has(s?.name)).slice(0, 10).map((s) => ({ name: s.name, ok: s.ok === true, detail: String(s.detail || '').slice(0, 400) }));
        if (cur.phase === 'waiting' && !answered) {
          answered = true;
          const answer = await this.cancel(uid, cur.sessionId);
          await this.call('POST', `/jobs/${jobId}/continue`, answer);
        }
        if (cur.phase === 'done') break;
        this.save(uid, slug, rec);
      }

      const r = cur.result || {};
      rec.steps = this.keep(uid, slug, rec.id, Array.isArray(r.steps) ? r.steps : []);
      if (/^cs_test_/.test(r.sessionId || '')) rec.checkout = short(r.sessionId);
      if (Array.isArray(r.blocked) && r.blocked.length) rec.blocked = r.blocked.slice(0, 5).map((b) => String(b).slice(0, 200));
      const detail = String(r.detail || 'no details');
      if (!r.ok) {
        // A live checkout, a browser crash or a failed cancel aren't the app's fault.
        if (r.refused || r.crashed || r.failedAt === 'cancel') return finish('error', detail, { failedAt: r.failedAt });
        if (APP_FAULT.has(r.failedAt)) this.ctx.store.updateApp(uid, slug, (s) => applyVerify(s, [{ id: 'pay-e2e', ok: false, detail: `Liftoff's purchase test failed: ${detail}` }]));
        return finish('failed', detail, { failedAt: r.failedAt });
      }

      // The browser got through. Stripe's records for this checkout decide.
      let v = null;
      for (let i = 0; i < 4; i++) {
        if (i) await sleep(this.settleMs); // webhooks can take a moment to settle
        const { results } = await verifyApp(this.ctx, uid, slug, ['pay-e2e'], { checkout: r.sessionId });
        v = results.find((x) => x.id === 'pay-e2e') || null;
        if (!v || v.ok !== false) break;
      }
      if (!v) return finish('error', 'The purchase check does not apply to this app');
      rec.steps.push({ name: 'stripe', ok: v.ok === true, detail: v.detail, shot: null });
      if (v.ok === true) return finish('passed', v.detail);
      if (v.ok === null) return finish('error', `The browser got through, but Liftoff couldn't check Stripe: ${v.detail}`);
      return finish('failed', `The browser got through, but Stripe's records don't back it up: ${v.detail}`, { failedAt: 'stripe' });
    } catch (e) {
      if (jobId) this.call('POST', `/jobs/${jobId}/stop`).catch(() => {});
      return finish('error', e.message || String(e));
    }
  }

  // Save the browser's screenshots; keep the last few tests' worth.
  keep(uid, slug, id, steps) {
    const root = path.join(this.ctx.store.appDir(uid, slug), 'proof');
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = steps.filter((s) => STEP_NAMES.has(s?.name)).slice(0, 10).map((s, i) => {
      const { name } = s;
      let shot = null;
      if (typeof s.shot === 'string' && s.shot) {
        const buf = Buffer.from(s.shot, 'base64');
        const file = `${String(i + 1).padStart(2, '0')}-${name}.jpg`;
        // JPEG only, and not too big: the browser's word is not trusted either.
        if (buf.length <= MAX_SHOT && buf[0] === 0xff && buf[1] === 0xd8 && SHOT_FILE.test(file)) {
          fs.writeFileSync(path.join(dir, file), buf, { mode: 0o600 });
          shot = file;
        }
      }
      return { name, ok: s.ok === true, detail: String(s.detail || '').slice(0, 400), shot };
    });
    try {
      const old = fs.readdirSync(root).filter((d) => PROOF_ID.test(d)).map((d) => ({ d, t: fs.statSync(path.join(root, d)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { d } of old.slice(KEEP_RUNS)) fs.rmSync(path.join(root, d), { recursive: true, force: true });
    } catch {}
    return out;
  }

  shot(uid, slug, id, file) {
    if (!PROOF_ID.test(id || '') || !SHOT_FILE.test(file || '')) throw new HttpError(404, 'No such screenshot');
    try {
      return fs.readFileSync(path.join(this.ctx.store.appDir(uid, slug), 'proof', id, file));
    } catch {
      throw new HttpError(404, 'No such screenshot');
    }
  }
}

function publicRecord(rec, slug) {
  return {
    ...rec,
    steps: (rec.steps || []).map((s) => ({
      ...s,
      label: LABEL[s.name] || s.name,
      shot: typeof s.shot === 'string' && s.shot ? `/api/apps/${encodeURIComponent(slug)}/proof/${rec.id}/${s.shot}` : null,
    })),
  };
}
