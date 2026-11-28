// The Launch Pass: Liftoff Cloud charges once per app, through Liftoff's own
// Stripe account (not the person's), for the parts that cost money to run or
// that only Liftoff can grant:
//
//   - cloud runs, with a set amount of tokens included (Claude time,
//     counted in Liftoff's own unit: see lib/brand.mjs)
//   - Liftoff's purchase test in its own browser
//   - launch reports and the "Launch certified" badge
//
// Importing, the scan, verify, Pulse, the Flight Board and the readiness
// score stay free: they're how people see what's left before they pay.
//
// Billing is off until LIFTOFF_STRIPE_SECRET_KEY is set, and then everything
// above needs a pass. Stripe Checkout takes the payment; the pass is granted
// when the person comes back from Checkout (the server reads the session from
// Stripe) or when Stripe's webhook says so, whichever is first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './http.mjs';
import { toTokens, tokenWord } from './brand.mjs';
import { stripeConnected } from './accounts.mjs';
import { sellsWithStripe } from '../../lib/verify.mjs';

const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const KIND = 'launch_pass';
const OPEN_RUN = new Set(['starting', 'running', 'needs-you', 'budget']);
const MAX_SKEW_S = 300;
// Watching (lib/watch.mjs) is what Pro pays for. Every Launch Pass comes
// with this many days of it, so people see it work before they're asked to pay.
export const PRO_DAYS_WITH_PASS = 30;
const DAY = 86_400_000;

// What the pass adds for one app. The purchase test runs on web apps that
// take payments through Stripe, and only web apps can be certified so far,
// so an app the pass can't fully serve yet isn't sold those parts.
export const passIncludes = (name, { web = true, purchaseTest = true } = {}) => [
  `${name} runs the launch steps in the cloud`,
  purchaseTest ? 'Liftoff’s own purchase test, with screenshots' : null,
  web ? 'Launch reports and the “Launch certified” badge' : 'A launch report to share, with every check and a score',
].filter(Boolean);

// What the pass doesn't do for this app yet, said before anyone pays.
export function passLater({ web = true, purchaseTest = true } = {}) {
  if (!web) return 'For App Store and Google Play apps, Liftoff’s purchase test and the “Launch certified” badge come later. Web apps get them now.';
  if (!purchaseTest) return 'Liftoff’s purchase test is for apps that take payments through Stripe. It opens for this app once it does.';
  return null;
}

const money = (n) => Math.round(n * 100) / 100;

// Stripe's webhook signature: t=<unix>,v1=<hex hmac of "<t>.<body>">.
export function checkStripeSignature(secret, header, raw, now = Date.now()) {
  const parts = {};
  for (const kv of String(header || '').split(',')) {
    const [k, v] = kv.split('=');
    if (k && v) (parts[k.trim()] ||= []).push(v.trim());
  }
  const t = Number(parts.t?.[0]);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > MAX_SKEW_S) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest();
  return (parts.v1 || []).some((sig) => {
    const got = Buffer.from(sig, 'hex');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}

export class Billing {
  constructor(ctx, fetch = globalThis.fetch) {
    this.ctx = ctx;
    this.cfg = ctx.config.billing;
    this.fetch = fetch;
  }

  get enabled() {
    return !!this.cfg.secretKey;
  }

  // ---------- records ----------

  file(uid) {
    return path.join(this.ctx.store.userDir(uid), 'billing.json');
  }

  load(uid) {
    try {
      const b = JSON.parse(fs.readFileSync(this.file(uid), 'utf8'));
      return { passes: b.passes || {}, sessions: b.sessions || [] };
    } catch {
      return { passes: {}, sessions: [] };
    }
  }

  save(uid, b) {
    const file = this.file(uid);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(b, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // Every checkout and payment, one JSON line each, kept for the books (and
  // the free scan to Launch Pass numbers). User ids only, no names or emails.
  log(entry) {
    try {
      const dir = path.join(this.ctx.config.dataDir, 'billing');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
    } catch (e) {
      console.error('[liftoff-cloud] billing log:', e.message);
    }
  }

  // GitHub logins that get every pass free (the team, testers).
  free(uid) {
    const login = String(this.ctx.store.getUser(uid)?.login || '').toLowerCase();
    return !!login && this.cfg.freeLogins.includes(login);
  }

  pass(uid, slug) {
    return this.load(uid).passes[slug] || null;
  }

  // Whether the paid parts are open for this app.
  unlocked(uid, slug) {
    return !this.enabled || this.free(uid) || !!this.pass(uid, slug);
  }

  // Whether Liftoff watches this app: { active, via, until }. via is 'open'
  // (payments off, so everything is free), 'free' (a LIFTOFF_FREE_LOGINS
  // login), 'pass' (the days that come with the Launch Pass), 'ended' (those
  // days are over) or 'none' (no pass yet).
  pro(uid, slug, now = Date.now()) {
    if (!this.enabled) return { active: true, via: 'open', until: null };
    if (this.free(uid)) return { active: true, via: 'free', until: null };
    const p = this.pass(uid, slug);
    if (!p) return { active: false, via: 'none', until: null };
    const until = Date.parse(p.at) + PRO_DAYS_WITH_PASS * DAY;
    return { active: now < until, via: now < until ? 'pass' : 'ended', until: new Date(until).toISOString() };
  }

  // Claude time on the pass, in dollars: what's included, what finished runs
  // cost, and what open runs may still spend (their budget), so a new run
  // never takes more than is left. used = spent + held, where held is what
  // open runs may still spend. People see it in tokens (tokensOf).
  claudeTime(uid, slug) {
    const p = this.pass(uid, slug);
    if (!p) return null;
    let spent = p.spentBefore || 0;
    let held = 0;
    for (const r of this.ctx.store.listRuns(uid, slug)) {
      const live = this.ctx.runs?.live?.get(r.id) || r;
      const cost = live.cost ?? 0;
      spent += cost;
      if (OPEN_RUN.has(live.status)) held += Math.max(0, (live.budgetUsd ?? 0) - cost);
    }
    const included = p.claudeUsd;
    const used = spent + held;
    return { included, used: money(used), left: money(Math.max(0, included - used)), spent: money(spent), held: money(held) };
  }

  get rate() {
    return this.ctx.config.tokensPerUsd;
  }

  // The pass's Claude time as people see it: tokens spent, tokens held for
  // runs still going, and what's left.
  tokensOf(t) {
    const tokens = (usd) => toTokens(usd, this.rate);
    return { included: tokens(t.included), used: tokens(t.spent), held: tokens(t.held), left: tokens(t.left), usedUp: t.left < 1 };
  }

  usedUpError(t) {
    return new HttpError(402, `The ${tokenWord(toTokens(t.included, this.rate))} that came with this app's Launch Pass are used up.`);
  }

  // ---------- what the paid parts check ----------

  require(uid, slug, what) {
    if (this.unlocked(uid, slug)) return;
    throw new HttpError(402, `${what} is part of the Launch Pass for this app ($${this.cfg.passUsd}, once). Get it on the app's page.`);
  }

  // The budget a new run gets: the usual per-run budget, or what's left of
  // the pass's Claude time if that's less.
  runBudget(uid, slug) {
    this.require(uid, slug, 'Running a launch in the cloud');
    const usual = this.ctx.config.runBudgetUsd;
    if (!this.enabled || this.free(uid)) return usual;
    const t = this.claudeTime(uid, slug);
    if (t.left < 1) throw this.usedUpError(t);
    return Math.min(usual, t.left);
  }

  // How much a paused run may add to its budget.
  raiseLimit(uid, slug, add) {
    if (!this.enabled || this.free(uid)) return add;
    this.require(uid, slug, 'Running a launch in the cloud');
    const t = this.claudeTime(uid, slug);
    if (t.left < 1) throw this.usedUpError(t);
    return Math.min(add, t.left);
  }

  // When an app is removed, what its runs cost stays counted against its pass,
  // so removing and importing it again doesn't reset its tokens.
  appRemoved(uid, slug) {
    const b = this.load(uid);
    const p = b.passes[slug];
    if (!p) return;
    const used = this.ctx.store.listRuns(uid, slug).reduce((n, r) => n + (r.cost ?? 0), 0);
    p.spentBefore = money((p.spentBefore || 0) + used);
    this.save(uid, b);
  }

  // Which parts of the pass this app can use now.
  fit(uid, state) {
    return {
      web: (state.platforms || []).includes('web'),
      purchaseTest: sellsWithStripe(state, { stripeConnected: stripeConnected(this.ctx.store, uid) }),
    };
  }

  // What the Flight Board shows.
  view(uid, state) {
    if (!this.enabled) return { enabled: false, unlocked: true };
    const free = this.free(uid);
    const p = this.pass(uid, state.slug);
    const fit = this.fit(uid, state);
    return {
      enabled: true,
      unlocked: free || !!p,
      free,
      // runTokens: what one run may use before it checks with the person.
      price: { usd: this.cfg.passUsd, tokens: toTokens(this.cfg.claudeUsd, this.rate), runTokens: toTokens(this.ctx.config.runBudgetUsd, this.rate) },
      includes: passIncludes(this.ctx.config.assistant, fit),
      later: passLater(fit),
      testMode: /^(sk|rk)_test_/.test(this.cfg.secretKey),
      pass: p ? { at: p.at, tokens: this.tokensOf(this.claudeTime(uid, state.slug)) } : null,
    };
  }

  // ---------- Stripe ----------

  async stripe(method, pathname, form = null) {
    const res = await this.fetch(`${this.cfg.api}/v1/${pathname}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.secretKey}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[liftoff-cloud] Stripe ${method} ${pathname}: ${res.status} ${body.error?.message || ''}`);
      throw new HttpError(502, "Stripe didn't take the request just now. Try again in a minute.");
    }
    return body;
  }

  // The line on Stripe's Checkout page and receipt: what this app gets.
  description(uid, state) {
    const { web, purchaseTest } = this.fit(uid, state);
    const parts = [`cloud runs with ${this.ctx.config.assistant} and ${tokenWord(toTokens(this.cfg.claudeUsd, this.rate))}`];
    if (purchaseTest) parts.push('the purchase test');
    parts.push(web ? 'the launch report and badge' : 'a launch report');
    return `For ${String(state.name).slice(0, 80)}: ${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}.`;
  }

  // A Checkout page for this app's pass. Returns where to send the browser.
  async checkout(uid, slug) {
    if (!this.enabled) throw new HttpError(404, 'Payments are off on this server.');
    const state = this.ctx.store.loadApp(uid, slug);
    if (!state) throw new HttpError(404, 'No such app');
    // Once the pass's tokens are used up, another pass adds the same again.
    if (this.free(uid) || (this.pass(uid, slug) && this.claudeTime(uid, slug).left >= 1)) throw new HttpError(409, 'This app already has its Launch Pass.');
    const base = this.ctx.config.publicUrl;
    const session = await this.stripe('POST', 'checkout/sessions', {
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(Math.round(this.cfg.passUsd * 100)),
      'line_items[0][price_data][product_data][name]': 'Liftoff Launch Pass',
      'line_items[0][price_data][product_data][description]': this.description(uid, state),
      allow_promotion_codes: 'true',
      client_reference_id: uid,
      'metadata[kind]': KIND,
      'metadata[uid]': uid,
      'metadata[slug]': slug,
      'payment_intent_data[metadata][kind]': KIND,
      'payment_intent_data[metadata][uid]': uid,
      'payment_intent_data[metadata][slug]': slug,
      success_url: `${base}/billing/done?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#${encodeURIComponent(slug)}`,
    });
    this.log({ event: 'checkout', uid, slug, session: session.id, usd: this.cfg.passUsd });
    if (typeof session.url !== 'string' || !/^https:\/\//.test(session.url)) throw new HttpError(502, "Stripe didn't return a checkout page.");
    return { url: session.url };
  }

  // Back from Checkout: read the session from Stripe (never trust the URL)
  // and grant the pass if it's this person's and paid. Returns the app's slug.
  async confirm(uid, sessionId) {
    if (!this.enabled) throw new HttpError(404, 'Payments are off on this server.');
    if (!SESSION.test(String(sessionId || ''))) throw new HttpError(400, 'Bad checkout id');
    const s = await this.stripe('GET', `checkout/sessions/${sessionId}`);
    if (s.metadata?.kind !== KIND || s.metadata?.uid !== uid) throw new HttpError(404, 'No such checkout');
    this.grantFrom(s, 'return');
    return { slug: s.metadata.slug, paid: this.isPaid(s) };
  }

  isPaid(s) {
    return s.status === 'complete' && ['paid', 'no_payment_required'].includes(s.payment_status);
  }

  // Record the pass from a Checkout session, once per session.
  grantFrom(s, via) {
    const { uid, slug } = s.metadata || {};
    if (s.metadata?.kind !== KIND || !this.isPaid(s)) return false;
    if (!this.ctx.store.getUser(uid) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug || '')) return false;
    const b = this.load(uid);
    if (b.sessions.includes(s.id)) return false;
    b.sessions.push(s.id);
    const prev = b.passes[slug];
    b.passes[slug] = {
      at: prev?.at || new Date().toISOString(),
      claudeUsd: money((prev?.claudeUsd || 0) + this.cfg.claudeUsd),
      spentBefore: prev?.spentBefore || 0,
      paid: [...(prev?.paid || []), { session: s.id, amount: s.amount_total ?? null, currency: s.currency || null, livemode: !!s.livemode, at: new Date().toISOString() }],
    };
    this.save(uid, b);
    this.log({ event: 'paid', via, uid, slug, session: s.id, amount: s.amount_total ?? null, currency: s.currency || null, livemode: !!s.livemode });
    if (this.ctx.store.loadApp(uid, slug)) {
      this.ctx.store.updateApp(uid, slug, (st) => st.log.push({ at: new Date().toISOString(), msg: 'Launch Pass bought' }));
    }
    return true;
  }

  // Stripe's webhook, for when the person closes the tab before coming back.
  webhook(raw, signature) {
    if (!this.enabled || !this.cfg.webhookSecret) throw new HttpError(404, 'Not found');
    if (!checkStripeSignature(this.cfg.webhookSecret, signature, raw)) throw new HttpError(400, 'Bad signature');
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'Bad JSON');
    }
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type)) {
      const s = ev.data?.object || {};
      if (typeof s.id === 'string' && SESSION.test(s.id)) this.grantFrom(s, 'webhook');
    }
    return { received: true };
  }
}
