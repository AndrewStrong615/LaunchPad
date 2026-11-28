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
// Pro is the monthly plan, per app, for watching it once it's live
// (lib/watch.mjs): uptime, every check again each day, and alerts. Every
// Launch Pass comes with its first 30 days, and Pro started during those
// days charges nothing until they end. It's a Stripe subscription on the same
// account, which the person cancels or manages from the app's page.
//
// Billing is off until LIFTOFF_STRIPE_SECRET_KEY is set, and then everything
// above needs a pass. Stripe Checkout takes the payment; the pass is granted
// when the person comes back from Checkout (the server reads the session from
// Stripe) or when Stripe's webhook says so, whichever is first. Pro follows
// the subscription as Stripe's webhook reports it, read again from Stripe each
// time so events arriving out of order can't leave it wrong.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './http.mjs';
import { toTokens, tokenWord } from './brand.mjs';
import { stripeConnected } from './accounts.mjs';
import { sellsWithStripe } from '../../lib/verify.mjs';

const SESSION = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const SUB = /^sub_[A-Za-z0-9_]{8,200}$/;
const CUSTOMER = /^cus_[A-Za-z0-9_]{6,200}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KIND = 'launch_pass';
const PRO = 'pro';
// The subscription states that keep Pro on. past_due: a payment failed and
// Stripe is retrying it, so watching carries on while it does.
const PRO_ON = new Set(['active', 'trialing', 'past_due']);
// If Stripe's word about a renewal never arrives, Pro stays on this long past
// the end of the paid month before it stops.
const PRO_GRACE = 3 * 86_400_000;
// Stripe wants a trial to end at least 48 hours after Checkout opens.
const MIN_TRIAL_S = 49 * 3600;
const SUB_EVENTS = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed']);
const OPEN_RUN = new Set(['starting', 'running', 'needs-you', 'budget']);
const MAX_SKEW_S = 300;
// Watching (lib/watch.mjs) is what Pro pays for. Every Launch Pass comes
// with this many days of it, so people see it work before they're asked to pay.
export const PRO_DAYS_WITH_PASS = 30;
const DAY = 86_400_000;

// What the pass adds for one app. The purchase test runs on web apps that
// take payments through Stripe, and only web apps can be certified so far,
// so an app the pass can't fully serve yet isn't sold those parts.
export const passIncludes = (name, { web = true, purchaseTest = true, watch = true } = {}) => [
  `${name} runs the launch steps in the cloud`,
  purchaseTest ? 'Liftoff’s own purchase test, with screenshots' : null,
  web ? 'Launch reports and the “Launch certified” badge' : 'A launch report to share, with every check and a score',
  watch ? `${PRO_DAYS_WITH_PASS} days of Liftoff watching the live app, with alerts` : null,
].filter(Boolean);

// What the pass doesn't do for this app yet, said before anyone pays.
export function passLater({ web = true, purchaseTest = true } = {}) {
  if (!web) return 'For App Store and Google Play apps, Liftoff’s purchase test and the “Launch certified” badge come later. Web apps get them now.';
  if (!purchaseTest) return 'Liftoff’s purchase test is for apps that take payments through Stripe. It opens for this app once it does.';
  return null;
}

const money = (n) => Math.round(n * 100) / 100;
const cents = (usd) => String(Math.round(usd * 100));
const isoOf = (unix) => (Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toISOString() : null);
const dayOf = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

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
      return { passes: b.passes || {}, sessions: b.sessions || [], pro: b.pro || {}, customer: b.customer || null };
    } catch {
      return { passes: {}, sessions: [], pro: {}, customer: null };
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

  // This app's Pro subscription as last heard from Stripe, or null.
  subscription(uid, slug) {
    return this.load(uid).pro[slug] || null;
  }

  // Whether a subscription keeps Pro on now.
  subOn(sub, now = Date.now()) {
    if (!sub || !PRO_ON.has(sub.status)) return false;
    const end = Date.parse(sub.periodEnd || '');
    return !end || now < end + PRO_GRACE;
  }

  // Whether Liftoff watches this app: { active, via, until, plan }. via is
  // 'open' (payments off, so everything is free), 'free' (a
  // LIFTOFF_FREE_LOGINS login), 'pro' (the monthly plan), 'pass' (the days
  // that come with the Launch Pass), 'ended' (those days are over) or 'none'
  // (no pass yet). plan says where the monthly plan stands, for the page.
  pro(uid, slug, now = Date.now()) {
    if (!this.enabled) return { active: true, via: 'open', until: null, plan: null };
    if (this.free(uid)) return { active: true, via: 'free', until: null, plan: null };
    const sub = this.subscription(uid, slug);
    if (this.subOn(sub, now)) {
      const plan = {
        status: sub.status,
        renewsAt: sub.cancelAt ? null : sub.periodEnd,
        endsAt: sub.cancelAt,
        chargesFrom: sub.status === 'trialing' ? sub.trialEnd : null,
        pastDue: sub.status === 'past_due',
      };
      return { active: true, via: 'pro', until: sub.cancelAt || null, plan };
    }
    const p = this.pass(uid, slug);
    if (!p) return { active: false, via: 'none', until: null, plan: null };
    const until = Date.parse(p.at) + PRO_DAYS_WITH_PASS * DAY;
    return { active: now < until, via: now < until ? 'pass' : 'ended', until: new Date(until).toISOString(), plan: null };
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
  // so removing and importing it again doesn't reset its tokens. Its Pro plan
  // stops renewing first (the month already paid for stays, in case the app
  // comes back); if Stripe can't be reached, the app isn't removed.
  async appRemoved(uid, slug) {
    const sub = this.subscription(uid, slug);
    if (this.enabled && this.subOn(sub) && !sub.cancelAt) await this.setRenewal(uid, slug, false, 'app-removed');
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
      watch: !!this.ctx.config.watch?.on,
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
      // Pro: its price, and whether there's a Stripe billing page to send people to.
      pro: { usd: this.cfg.proUsd, billingPage: !!this.load(uid).customer },
    };
  }

  // ---------- Stripe ----------

  async stripe(method, pathname, form = null, { problem } = {}) {
    const res = await this.fetch(`${this.cfg.api}/v1/${pathname}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.secretKey}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[liftoff-cloud] Stripe ${method} ${pathname}: ${res.status} ${body.error?.message || ''}`);
      throw new HttpError(502, problem || "Stripe didn't take the request just now. Try again in a minute.");
    }
    return body;
  }

  // The line on Stripe's Checkout page and receipt: what this app gets.
  description(uid, state) {
    const { web, purchaseTest, watch } = this.fit(uid, state);
    const parts = [`cloud runs with ${this.ctx.config.assistant} and ${tokenWord(toTokens(this.cfg.claudeUsd, this.rate))}`];
    if (purchaseTest) parts.push('the purchase test');
    parts.push(web ? 'the launch report and badge' : 'a launch report');
    if (watch) parts.push(`${PRO_DAYS_WITH_PASS} days of watching`);
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
  // and grant the pass, or start Pro, if it's this person's and paid.
  // Returns the app's slug, whether it's done, and which it was.
  async confirm(uid, sessionId) {
    if (!this.enabled) throw new HttpError(404, 'Payments are off on this server.');
    if (!SESSION.test(String(sessionId || ''))) throw new HttpError(400, 'Bad checkout id');
    const s = await this.stripe('GET', `checkout/sessions/${sessionId}`);
    if (![KIND, PRO].includes(s.metadata?.kind) || s.metadata?.uid !== uid) throw new HttpError(404, 'No such checkout');
    if (s.metadata.kind === PRO) {
      const sub = await this.proFrom(s, 'return');
      return { slug: s.metadata.slug, paid: !!sub && PRO_ON.has(sub.status), kind: PRO };
    }
    this.grantFrom(s, 'return');
    return { slug: s.metadata.slug, paid: this.isPaid(s), kind: KIND };
  }

  isPaid(s) {
    return s.status === 'complete' && ['paid', 'no_payment_required'].includes(s.payment_status);
  }

  // Record the pass from a Checkout session, once per session.
  grantFrom(s, via) {
    const { uid, slug } = s.metadata || {};
    if (s.metadata?.kind !== KIND || !this.isPaid(s)) return false;
    if (!this.ctx.store.getUser(uid) || !SLUG.test(slug || '')) return false;
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

  // ---------- Pro ----------

  // A Checkout page for this app's Pro plan. During the days that come with
  // the Launch Pass, the first payment waits until they end.
  async proCheckout(uid, slug, now = Date.now()) {
    if (!this.enabled) throw new HttpError(404, 'Payments are off on this server.');
    const state = this.ctx.store.loadApp(uid, slug);
    if (!state) throw new HttpError(404, 'No such app');
    const cur = this.pro(uid, slug, now);
    if (cur.via === 'free') throw new HttpError(409, 'Liftoff watches this account’s apps for free.');
    if (cur.via === 'pro') throw new HttpError(409, 'This app is already on Pro.');
    const base = this.ctx.config.publicUrl;
    const form = {
      mode: 'subscription',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': cents(this.cfg.proUsd),
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': 'Liftoff Pro',
      'line_items[0][price_data][product_data][description]': `Liftoff watches ${String(state.name).slice(0, 80)}: its live site every few minutes, every launch check again each day, and alerts when something breaks.`,
      allow_promotion_codes: 'true',
      client_reference_id: uid,
      'metadata[kind]': PRO,
      'metadata[uid]': uid,
      'metadata[slug]': slug,
      'subscription_data[metadata][kind]': PRO,
      'subscription_data[metadata][uid]': uid,
      'subscription_data[metadata][slug]': slug,
      success_url: `${base}/billing/done?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#${encodeURIComponent(slug)}`,
    };
    const trialEnd = cur.via === 'pass' ? Math.floor(Date.parse(cur.until) / 1000) : 0;
    if (trialEnd - now / 1000 >= MIN_TRIAL_S) form['subscription_data[trial_end]'] = String(trialEnd);
    const customer = this.load(uid).customer;
    if (customer) form.customer = customer;
    const session = await this.stripe('POST', 'checkout/sessions', form);
    this.log({ event: 'pro-checkout', uid, slug, session: session.id, usd: this.cfg.proUsd, trialEnd: isoOf(Number(form['subscription_data[trial_end]'])) });
    if (typeof session.url !== 'string' || !/^https:\/\//.test(session.url)) throw new HttpError(502, "Stripe didn't return a checkout page.");
    return { url: session.url };
  }

  // A finished Pro checkout: the subscription it made, read from Stripe.
  async proFrom(s, via) {
    const { uid, slug } = s.metadata || {};
    if (s.metadata?.kind !== PRO || !this.ctx.store.getUser(uid) || !SLUG.test(slug || '')) return null;
    const id = typeof s.subscription === 'string' ? s.subscription : s.subscription?.id;
    if (!SUB.test(id || '')) return null;
    return this.syncSub(id, via, { uid, slug });
  }

  // Read a subscription from Stripe and keep what it says. `expect` is the
  // person and app the caller already knows it's for.
  async syncSub(id, via, expect = null) {
    const sub = await this.stripe('GET', `subscriptions/${id}`);
    const { kind, uid, slug } = sub.metadata || {};
    if (kind !== PRO || sub.id !== id || !this.ctx.store.getUser(uid) || !SLUG.test(slug || '')) return null;
    if (expect && (expect.uid !== uid || expect.slug !== slug)) return null;
    return this.keepSub(uid, slug, sub, via) ? this.subscription(uid, slug) : null;
  }

  // Save a subscription Stripe sent back. Returns false when it isn't kept.
  keepSub(uid, slug, sub, via) {
    const b = this.load(uid);
    const cur = b.pro[slug];
    const status = String(sub.status || '');
    if (cur && cur.sub !== sub.id && this.subOn(cur)) {
      // A second plan for the same app (two Checkout tabs, say): keep the
      // first, and log it so the second can be refunded and cancelled.
      if (PRO_ON.has(status)) this.log({ event: 'pro-duplicate', via, uid, slug, sub: sub.id, keeps: cur.sub });
      return false;
    }
    const periodEnd = isoOf(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end);
    const at = new Date().toISOString();
    const next = {
      sub: sub.id,
      status,
      periodEnd,
      cancelAt: sub.cancel_at_period_end ? periodEnd : isoOf(sub.cancel_at),
      trialEnd: isoOf(sub.trial_end),
      startedAt: cur?.sub === sub.id ? cur.startedAt : at,
      updatedAt: at,
      livemode: !!sub.livemode,
    };
    b.pro[slug] = next;
    if (CUSTOMER.test(String(sub.customer || ''))) b.customer = sub.customer;
    this.save(uid, b);
    const wasOn = cur?.sub === sub.id && PRO_ON.has(cur.status);
    const isOn = PRO_ON.has(status);
    if (cur?.status !== status || cur?.sub !== sub.id || cur?.cancelAt !== next.cancelAt) this.log({ event: 'pro', via, uid, slug, sub: sub.id, status, cancelAt: next.cancelAt, livemode: next.livemode });
    const note = isOn && !wasOn ? 'Pro started'
      : !isOn && wasOn ? 'Pro ended'
      : isOn && next.cancelAt && !cur?.cancelAt ? `Pro set to end on ${dayOf(next.cancelAt)}`
      : isOn && !next.cancelAt && cur?.cancelAt ? 'Pro set to renew again'
      : status === 'past_due' && cur?.status !== 'past_due' ? 'Pro payment failed: Stripe is retrying it'
      : null;
    if (note && this.ctx.store.loadApp(uid, slug)) this.ctx.store.updateApp(uid, slug, (st) => st.log.push({ at, msg: note }));
    return true;
  }

  // Stop Pro renewing (it runs to the end of the month paid for), or keep it.
  async setRenewal(uid, slug, renew, via = 'app') {
    if (!this.enabled) throw new HttpError(404, 'Payments are off on this server.');
    const cur = this.subscription(uid, slug);
    if (!this.subOn(cur)) throw new HttpError(404, 'This app isn’t on Pro.');
    const sub = await this.stripe('POST', `subscriptions/${cur.sub}`, { cancel_at_period_end: renew ? 'false' : 'true' }, { problem: renew ? "Stripe didn't take that just now, so Pro still ends as planned. Try again in a minute." : "Stripe didn't take that just now, so Pro still renews. Try again in a minute." });
    if (sub.id !== cur.sub) throw new HttpError(502, 'Stripe answered about another plan.');
    this.keepSub(uid, slug, { ...sub, metadata: { kind: PRO, uid, slug } }, via);
    return this.pro(uid, slug);
  }

  // Stripe's own page for the person's card, invoices and plans.
  async billingPage(uid, slug) {
    if (!this.enabled) throw new HttpError(404, 'Payments are off on this server.');
    const customer = this.load(uid).customer;
    if (!customer) throw new HttpError(404, 'Nothing billed by Liftoff yet.');
    const s = await this.stripe('POST', 'billing_portal/sessions', { customer, return_url: `${this.ctx.config.publicUrl}/#${encodeURIComponent(slug)}` }, { problem: "Stripe's billing page didn't open just now. Try again in a minute." });
    if (typeof s.url !== 'string' || !/^https:\/\//.test(s.url)) throw new HttpError(502, "Stripe didn't return a billing page.");
    return { url: s.url };
  }

  // Stripe's webhook: the pass when the person closes the tab before coming
  // back, and every change to a Pro plan (renewed, failed, cancelled, ended).
  async webhook(raw, signature) {
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
      if (typeof s.id === 'string' && SESSION.test(s.id)) {
        if (s.metadata?.kind === PRO) await this.proFrom(s, 'webhook');
        else this.grantFrom(s, 'webhook');
      }
    }
    if (SUB_EVENTS.has(ev.type)) {
      // The event says which plan changed; Stripe itself says how it stands now.
      const sub = ev.data?.object || {};
      if (sub.metadata?.kind === PRO && SUB.test(String(sub.id || ''))) await this.syncSub(sub.id, 'webhook');
    }
    return { received: true };
  }
}
