// `liftoff verify`: checks readiness items against the real services instead
// of trusting what was ticked. Each check returns
//   { id, ok: true | false | null, detail }
// where null means "couldn't check" (no live URL, account not connected, setting
// missing). Passing checks are ticked as verified; failing ones are unticked,
// so the checklist never claims something that isn't true.
import path from 'node:path';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { scanSecrets } from './scan.mjs';
import { ACCOUNTS, checklistFor, usesOf } from './catalog.mjs';
import { googleToken, serviceAccount } from './google.mjs';
import { featuresOf, knownFeatures } from './profile.mjs';

const PLATFORM_HOSTS = /\.(vercel\.app|pages\.dev|workers\.dev|netlify\.app|onrender\.com|fly\.dev|herokuapp\.com)$/;

const skip = (id, detail) => ({ id, ok: null, detail });
const pass = (id, detail) => ({ id, ok: true, detail });
const fail = (id, detail) => ({ id, ok: false, detail });

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};

// Web apps that take payments through Stripe have their purchase flow proven
// from Stripe's own records (the pay-e2e check below), so Claude can't tick
// it by hand. Apps that sell through the app stores, Paddle or Lemon Squeezy
// still record their own test run until Liftoff can check those. An app that
// takes no payments (lib/profile.mjs) has no purchase flow to prove, even
// when Stripe is connected for another app.
export function purchaseProvenByStripe(state, { stripeConnected = false, uses = null } = {}) {
  if (!(state.platforms || []).includes('web') || !knownFeatures(state).payments) return false;
  const provider = state.steps?.payments?.provider;
  if (provider) return /stripe/i.test(provider);
  // The code sells through another provider (or the user named their own).
  const seller = uses?.payments || OTHER_SELLERS.find((p) => (state.payments || []).includes(p));
  if (seller && seller !== 'stripe' && !(state.payments || []).includes('stripe')) return false;
  return stripeConnected;
}
const OTHER_SELLERS = ['paddle', 'polar', 'lemonsqueezy'];

// A web app that takes payments through Stripe: the payments step says so,
// the code uses Stripe, or (before either) Stripe is connected.
export function sellsWithStripe(state, { stripeConnected = false, uses = null } = {}) {
  if (purchaseProvenByStripe(state, { stripeConnected, uses })) return true;
  return (state.platforms || []).includes('web') && knownFeatures(state).payments && !state.steps?.payments?.provider && (state.payments || []).includes('stripe');
}

// Checks that ask the service the app uses for a category (usesOf in
// lib/catalog.mjs). A category nobody named falls back to the default, as
// before: Stripe, Supabase, Resend.
const DEFAULT_USE = { payments: 'stripe', database: 'supabase', email: 'resend' };
const BY_PROVIDER = {
  'pay-products': { cat: 'payments', on: ['stripe', 'paddle', 'polar', 'lemonsqueezy'] },
  'pay-webhook': { cat: 'payments', on: ['stripe', 'paddle', 'polar', 'lemonsqueezy'] },
  'pay-live': { cat: 'payments', on: ['stripe', 'paddle', 'polar'] },
  'sec-rls': { cat: 'database', on: ['supabase', 'firebase'] },
  'sec-backup': { cat: 'database', on: ['supabase', 'neon'] },
};

// Whether Liftoff can prove this item for this app. Items it can prove are
// never ticked by hand; items it can't (a service it has no check for, like
// the user's own) are ticked by whoever tested them and show as reported.
export function canProve(state, id, { uses = usesOf(state), stripeConnected = false } = {}) {
  if (!VERIFIABLE.includes(id)) return false;
  const web = (state.platforms || []).includes('web');
  if (id === 'pay-e2e') {
    const p = uses.payments || 'stripe';
    if (p === 'stripe') return purchaseProvenByStripe(state, { stripeConnected, uses });
    return web && !!knownFeatures(state).payments && (p === 'paddle' || p === 'polar');
  }
  const rule = BY_PROVIDER[id];
  return !rule || rule.on.includes(uses[rule.cat] || DEFAULT_USE[rule.cat]);
}

// Where the app runs: its live URL, its web deploys and the preview the
// purchase flow test ran against.
export function appHosts(state) {
  const urls = [state.liveUrl, state.config?.['preview.url'], ...(state.deploys || []).filter((d) => d.platform === 'web').map((d) => d.url)];
  return new Set(urls.map((u) => u && hostOf(u)).filter(Boolean));
}

// A host belongs to the app when it is one of the app's hosts, a subdomain of
// one (Cloudflare Pages previews), or a preview of the same project on the
// same platform: my-app-git-main-me.vercel.app and my-app-3fa9c1-me.vercel.app
// for my-app.vercel.app, deploy-preview-4--my-app.netlify.app for my-app.netlify.app.
export function sameApp(host, known) {
  if (!host) return false;
  if (host === known || host.endsWith(`.${known}`)) return true;
  const [label, ...rest] = host.split('.');
  const [knownLabel, ...knownRest] = known.split('.');
  const domain = rest.join('.');
  if (domain !== knownRest.join('.') || !PLATFORM_HOSTS.test(host)) return false;
  const project = knownLabel.replace(/-git-.*$/, '');
  if (domain === 'vercel.app') return label.startsWith(`${project}-`);
  if (domain === 'netlify.app') return label.endsWith(`--${project}`);
  return false;
}

const listensFor = (endpoint, type) => endpoint.status === 'enabled' && ['*', type].some((t) => (endpoint.enabled_events || []).includes(t));

async function get(ctx, url, opts = {}) {
  const res = await ctx.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(ctx.timeout), ...opts });
  return res;
}

async function json(ctx, url, headers, opts = {}) {
  const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(ctx.timeout), ...opts });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

const bearer = (key) => ({ authorization: `Bearer ${key}` });
const short = (id) => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
const dayOf = (t) => new Date(typeof t === 'number' ? t * 1000 : t).toISOString().slice(0, 10);
const liveHost = (ctx) => (ctx.liveUrl ? hostOf(ctx.liveUrl) : null);
const nameOf = (ctx, id) => ctx.names?.[id] || ACCOUNTS[id]?.label || id;
const useOf = (ctx, cat) => ctx.uses[cat] || DEFAULT_USE[cat];
const cantCheck = (ctx, id, provider) => skip(id, `Liftoff can't check ${nameOf(ctx, provider)} for this yet; tick it once it's tested`);

// A webhook route that takes an unsigned request would believe anyone.
async function rejectsUnsigned(ctx, id, url, who) {
  const res = await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(ctx.timeout) });
  if (res.status === 404 || res.status === 405) return fail(id, `${url} answered ${res.status}: route missing`);
  if (res.ok) return fail(id, `${url} accepted an unsigned request: verify the ${who} signature`);
  return pass(id, `${url} exists and rejects unsigned requests (${res.status})`);
}

// No test purchase to judge: a proof from the last 30 days still stands.
function noPurchase(ctx, id, what, where) {
  const prev = ctx.state.checklist?.[id];
  if (prev?.by === 'verified' && prev.at) return skip(id, `no ${what}${where} in the last 30 days; last proven ${prev.at.slice(0, 10)}`);
  return fail(id, `no ${what}${where} in the last 30 days: run the purchase flow test`);
}

// ---------- payments through Paddle, Polar and Lemon Squeezy ----------

const PADDLE_LIVE = 'https://api.paddle.com';
const PADDLE_SANDBOX = 'https://sandbox-api.paddle.com';
const POLAR_LIVE = 'https://api.polar.sh';
const POLAR_SANDBOX = 'https://sandbox-api.polar.sh';
const LEMON = 'https://api.lemonsqueezy.com/v1';

// Sandbox and live are separate hosts. New Paddle keys say which they are;
// older Paddle keys and Polar tokens are tried against live first.
function apiBase(ctx, provider) {
  ctx.memo[provider] ||= (async () => {
    if (provider === 'paddle') {
      const key = ctx.env.PADDLE_API_KEY;
      if (/^pdl_sdbx_/.test(key) || ctx.modes?.paddle === 'sandbox') return PADDLE_SANDBOX;
      if (/^pdl_live_/.test(key) || ctx.modes?.paddle === 'live') return PADDLE_LIVE;
      const res = await ctx.fetch(`${PADDLE_LIVE}/event-types`, { headers: bearer(key), signal: AbortSignal.timeout(ctx.timeout) });
      return res.status === 401 || res.status === 403 ? PADDLE_SANDBOX : PADDLE_LIVE;
    }
    if (ctx.modes?.polar) return ctx.modes.polar === 'sandbox' ? POLAR_SANDBOX : POLAR_LIVE;
    const res = await ctx.fetch(`${POLAR_LIVE}/v1/products/?limit=1`, { headers: bearer(ctx.env.POLAR_ACCESS_TOKEN), signal: AbortSignal.timeout(ctx.timeout) });
    return res.status === 401 ? POLAR_SANDBOX : POLAR_LIVE;
  })();
  return ctx.memo[provider];
}

const lemonList = (r) => (Array.isArray(r.data) ? r.data : r.data ? [r.data] : []);
const lemonHeaders = (key) => ({ ...bearer(key), accept: 'application/vnd.api+json' });

const PAY = {
  paddle: {
    key: 'PADDLE_API_KEY',
    async products(ctx, id, key) {
      const base = await apiBase(ctx, 'paddle');
      const r = await json(ctx, `${base}/prices?status=active&per_page=50`, bearer(key));
      const prices = r.data || [];
      const recurring = prices.filter((p) => p.billing_cycle).length;
      return prices.length ? pass(id, `${prices.length} active Paddle price(s)${recurring ? `, ${recurring} recurring` : ''}`) : fail(id, 'no active prices in Paddle');
    },
    async webhook(ctx, id, key) {
      const base = await apiBase(ctx, 'paddle');
      const r = await json(ctx, `${base}/notification-settings?active=true&per_page=200`, bearer(key));
      const live = liveHost(ctx);
      const dests = (r.data || []).filter((n) => n.type === 'url' && n.active !== false && n.traffic_source !== 'simulation');
      const match = live ? dests.find((n) => hostOf(n.destination) === live) : dests[0];
      if (!match) return fail(id, live ? `no active Paddle notification destination points at ${live}` : 'no active Paddle notification destination');
      const ev = (match.subscribed_events || []).map((e) => e?.name || e);
      const missing = ['transaction.completed', 'subscription.updated', 'subscription.canceled'].filter((n) => !ev.includes(n));
      if (missing.length) return fail(id, `Paddle destination is missing ${missing.join(', ')}`);
      return rejectsUnsigned(ctx, id, match.destination, 'Paddle-Signature');
    },
    async live(ctx, id, key) {
      const base = await apiBase(ctx, 'paddle');
      if (base === PADDLE_SANDBOX) return fail(id, 'Paddle key is still a sandbox key');
      await json(ctx, `${base}/event-types`, bearer(key));
      return pass(id, 'live Paddle key that Paddle accepts');
    },
    // A completed sandbox transaction whose transaction.completed notification
    // the app accepted, then its subscription cancelled and subscription.canceled
    // accepted too: Paddle keeps each notification's delivery status.
    async e2e(ctx, id, key) {
      const base = await apiBase(ctx, 'paddle');
      if (base !== PADDLE_SANDBOX) return skip(id, 'checked in the Paddle sandbox only; the last result stands');
      const auth = bearer(key);
      const since = new Date(ctx.now - 30 * 86_400_000).toISOString();
      const [txns, settings] = await Promise.all([
        json(ctx, `${base}/transactions?status=completed&created_at[GTE]=${encodeURIComponent(since)}&order_by=created_at[DESC]&per_page=50`, auth),
        json(ctx, `${base}/notification-settings?active=true&per_page=200`, auth),
      ]);
      const listens = (type) => (settings.data || []).some((n) => n.type === 'url' && n.active !== false && (n.subscribed_events || []).some((e) => (e?.name || e) === type));
      if (!listens('transaction.completed')) return fail(id, 'no active Paddle notification destination listens for transaction.completed, so the app never hears about a purchase');
      const hosts = appHosts(ctx.state);
      const onThisApp = (t) => !hosts.size || !t.checkout?.url || [...hosts].some((k) => sameApp(hostOf(t.checkout.url), k));
      const bought = (txns.data || []).filter(onThisApp);
      if (!bought.length) return noPurchase(ctx, id, 'completed Paddle sandbox transaction', hosts.size ? ` on ${[...hosts].join(' or ')}` : '');
      const accepted = async (entity, type) => {
        const r = await json(ctx, `${base}/notifications?filter=${encodeURIComponent(entity)}&status=delivered&per_page=50`, auth);
        return (r.data || []).some((n) => n.type === type);
      };
      let firstProblem = null;
      for (const t of bought.slice(0, 5)) {
        const what = `test transaction ${short(t.id)} on ${dayOf(t.created_at)}`;
        if (!(await accepted(t.id, 'transaction.completed'))) {
          firstProblem ||= fail(id, `${what} completed, but your webhook hasn't accepted transaction.completed (Paddle is still retrying it)`);
          continue;
        }
        if (!t.subscription_id) return pass(id, `${what}: paid, and your webhook accepted it`);
        const sub = (await json(ctx, `${base}/subscriptions/${encodeURIComponent(t.subscription_id)}`, auth)).data;
        if (sub?.status !== 'canceled') {
          firstProblem ||= fail(id, `${what} was paid and your webhook accepted it, but the subscription was never cancelled, so "Pro locks again" wasn't tested`);
          continue;
        }
        if (!listens('subscription.canceled')) return fail(id, 'no active Paddle notification destination listens for subscription.canceled, so a cancelled user keeps Pro');
        if (!(await accepted(sub.id, 'subscription.canceled'))) {
          firstProblem ||= fail(id, `${what} was paid and cancelled, but your webhook hasn't accepted subscription.canceled (Paddle is still retrying it)`);
          continue;
        }
        return pass(id, `${what}: paid, cancelled, and your webhook accepted both`);
      }
      return firstProblem;
    },
  },

  polar: {
    key: 'POLAR_ACCESS_TOKEN',
    async products(ctx, id, key) {
      const base = await apiBase(ctx, 'polar');
      const r = await json(ctx, `${base}/v1/products/?is_archived=false&limit=100`, bearer(key));
      const n = (r.items || []).length;
      return n ? pass(id, `${n} active Polar product(s)`) : fail(id, 'no active products in Polar');
    },
    async webhook(ctx, id, key) {
      const base = await apiBase(ctx, 'polar');
      const r = await json(ctx, `${base}/v1/webhooks/endpoints?limit=100`, bearer(key));
      const live = liveHost(ctx);
      const eps = (r.items || []).filter((e) => e.enabled !== false && (!e.format || e.format === 'raw'));
      const match = live ? eps.find((e) => hostOf(e.url) === live) : eps[0];
      if (!match) return fail(id, live ? `no enabled Polar webhook points at ${live}` : 'no enabled Polar webhook');
      const ev = match.events || [];
      const missing = [];
      if (!ev.includes('order.paid')) missing.push('order.paid');
      if (!ev.includes('subscription.revoked') && !ev.includes('subscription.canceled')) missing.push('subscription.revoked');
      if (missing.length) return fail(id, `Polar webhook is missing ${missing.join(', ')}`);
      return rejectsUnsigned(ctx, id, match.url, 'webhook');
    },
    async live(ctx, id) {
      const base = await apiBase(ctx, 'polar');
      return base === POLAR_SANDBOX ? fail(id, 'Polar token is still a sandbox token') : pass(id, 'production Polar token');
    },
    // A paid sandbox order whose order.paid delivery the app accepted, then its
    // subscription cancelled and that delivery accepted too (Polar lists every
    // delivery with whether it succeeded). Polar orders don't carry the
    // checkout's address, so the newest orders of the organization count.
    async e2e(ctx, id, key) {
      const base = await apiBase(ctx, 'polar');
      if (base !== POLAR_SANDBOX) return skip(id, 'checked in the Polar sandbox only; the last result stands');
      const auth = bearer(key);
      const since = new Date(ctx.now - 30 * 86_400_000).toISOString();
      const [orders, endpoints] = await Promise.all([
        json(ctx, `${base}/v1/orders/?limit=100&sorting=-created_at&created_after=${encodeURIComponent(since)}`, auth),
        json(ctx, `${base}/v1/webhooks/endpoints?limit=100`, auth),
      ]);
      const listens = (type) => (endpoints.items || []).some((e) => e.enabled !== false && (e.events || []).includes(type));
      if (!listens('order.paid')) return fail(id, 'no enabled Polar webhook listens for order.paid, so the app never hears about a purchase');
      const paid = (orders.items || []).filter((o) => o.paid || o.status === 'paid');
      if (!paid.length) return noPurchase(ctx, id, 'paid Polar sandbox order', '');
      const seen = {};
      const accepted = async (type, entity) => {
        seen[type] ||= json(ctx, `${base}/v1/webhooks/deliveries?event_type=${type}&succeeded=true&limit=100&start_timestamp=${encodeURIComponent(since)}`, auth);
        return ((await seen[type]).items || []).some((d) => d.succeeded && String(d.webhook_event?.payload || '').includes(entity));
      };
      let firstProblem = null;
      for (const o of paid.slice(0, 5)) {
        const what = `test order ${short(o.id)} on ${dayOf(o.created_at)}`;
        if (!(await accepted('order.paid', o.id))) {
          firstProblem ||= fail(id, `${what} was paid, but your webhook hasn't accepted order.paid`);
          continue;
        }
        if (!o.subscription_id) return pass(id, `${what}: paid, and your webhook accepted it`);
        const sub = await json(ctx, `${base}/v1/subscriptions/${encodeURIComponent(o.subscription_id)}`, auth);
        if (sub?.status !== 'canceled') {
          firstProblem ||= fail(id, `${what} was paid and your webhook accepted it, but the subscription was never cancelled, so "Pro locks again" wasn't tested`);
          continue;
        }
        if (!listens('subscription.revoked') && !listens('subscription.canceled')) return fail(id, 'no enabled Polar webhook listens for subscription.revoked, so a cancelled user keeps Pro');
        if (!(await accepted('subscription.revoked', sub.id)) && !(await accepted('subscription.canceled', sub.id))) {
          firstProblem ||= fail(id, `${what} was paid and cancelled, but your webhook hasn't accepted the cancellation`);
          continue;
        }
        return pass(id, `${what}: paid, cancelled, and your webhook accepted both`);
      }
      return firstProblem;
    },
  },

  // Lemon Squeezy's API doesn't say whether a key is in test mode or show
  // webhook deliveries, so live mode and the purchase test are reported, not proven.
  lemonsqueezy: {
    key: 'LEMONSQUEEZY_API_KEY',
    async products(ctx, id, key) {
      const r = await json(ctx, `${LEMON}/products?page[size]=50`, lemonHeaders(key));
      const n = lemonList(r).filter((p) => p.attributes?.status === 'published').length;
      return n ? pass(id, `${n} published Lemon Squeezy product(s)`) : fail(id, 'no published products in Lemon Squeezy');
    },
    async webhook(ctx, id, key) {
      const r = await json(ctx, `${LEMON}/webhooks?page[size]=50`, lemonHeaders(key));
      const live = liveHost(ctx);
      const hooks = lemonList(r).map((w) => w.attributes || {});
      const match = live ? hooks.find((w) => hostOf(w.url) === live) : hooks[0];
      if (!match) return fail(id, live ? `no Lemon Squeezy webhook points at ${live}` : 'no Lemon Squeezy webhook');
      const ev = match.events || [];
      const missing = [];
      if (!ev.includes('order_created') && !ev.includes('subscription_created')) missing.push('order_created');
      if (ev.includes('subscription_created')) for (const n of ['subscription_updated', 'subscription_expired']) if (!ev.includes(n)) missing.push(n);
      if (missing.length) return fail(id, `Lemon Squeezy webhook is missing ${missing.join(', ')}`);
      return rejectsUnsigned(ctx, id, match.url, 'X-Signature');
    },
  },
};

async function payCheck(ctx, id, kind) {
  const p = useOf(ctx, 'payments');
  if (p === 'stripe') return STRIPE[kind](ctx);
  const impl = PAY[p]?.[kind];
  if (!impl) return cantCheck(ctx, id, p);
  const key = ctx.env[PAY[p].key];
  if (!key) return skip(id, `${nameOf(ctx, p)} not connected`);
  return impl(ctx, id, key);
}

// ---------- databases: Firebase rules, Neon and Supabase backups ----------

// Firestore and Storage rules that leave data open: no condition or "if true",
// test-mode rules that open everything until a date, or a catch-all match that
// lets any signed-in user read and write every document.
export function openRules(source, now = Date.now()) {
  const text = String(source || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const found = [];
  const ops = (m) => m.replace(/\s+/g, '').split(',').filter(Boolean).join(', ');
  for (const m of text.matchAll(/allow\s+([a-z,\s]+?)\s*(?::\s*if\s+([^;]*))?;/g)) {
    const cond = (m[2] || '').replace(/\s+/g, ' ').trim();
    if (!cond || cond === 'true') found.push(`anyone can ${ops(m[1])}`);
    const t = cond.match(/^request\.time < timestamp\.date\((\d{4}), ?(\d{1,2}), ?(\d{1,2})\)$/);
    if (t && Date.UTC(+t[1], +t[2] - 1, +t[3]) > now) found.push(`test-mode rules let anyone ${ops(m[1])} until ${t[1]}-${t[2].padStart(2, '0')}-${t[3].padStart(2, '0')}`);
  }
  for (const m of text.matchAll(/match\s+\/\{\w+=\*\*\}\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0, i++;
    for (const a of text.slice(start, i).matchAll(/allow\s+([a-z,\s]+?)\s*:\s*if\s+([^;]*);/g)) {
      if (/^request\.auth\s*!=\s*null$/.test(a[2].trim()) && /write|create|update|delete/.test(a[1])) found.push(`any signed-in user can ${ops(a[1])} every document`);
    }
  }
  return [...new Set(found)];
}

const RULES_API = 'https://firebaserules.googleapis.com/v1';

async function firebaseRules(ctx, id) {
  const sa = serviceAccount(ctx.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!sa) return skip(id, 'Firebase not connected');
  const project = ctx.config['firebase.project'] || sa.project_id;
  if (!project) return skip(id, 'set firebase.project');
  const auth = bearer(await googleToken(ctx, sa, 'https://www.googleapis.com/auth/firebase.readonly'));
  const r = await json(ctx, `${RULES_API}/projects/${encodeURIComponent(project)}/releases?pageSize=100`, auth);
  const releases = (r.releases || []).filter((x) => /\/releases\/(cloud\.firestore|firebase\.storage)/.test(x.name) && /^projects\/[\w.-]+\/rulesets\/[\w-]+$/.test(x.rulesetName || ''));
  if (!releases.length) return skip(id, `no Firestore or Storage rules deployed in ${project}`);
  const problems = [];
  const kinds = new Set();
  for (const rel of releases.slice(0, 6)) {
    const kind = rel.name.includes('firebase.storage') ? 'Storage' : 'Firestore';
    kinds.add(kind);
    const set = await json(ctx, `${RULES_API}/${rel.rulesetName}`, auth);
    for (const p of openRules((set.source?.files || []).map((f) => f.content || '').join('\n'), ctx.now)) problems.push(`${kind}: ${p}`);
  }
  return problems.length ? fail(id, [...new Set(problems)].slice(0, 3).join('; ')) : pass(id, `${[...kinds].join(' and ')} rules don't leave data open`);
}

async function supabaseRls(ctx, id) {
  const token = ctx.env.SUPABASE_ACCESS_TOKEN;
  const ref = ctx.config['supabase.ref'];
  if (!token || !ref) return skip(id, 'set supabase.ref to check row-level security');
  const sql = "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity";
  const rows = await json(ctx, `https://api.supabase.com/v1/projects/${ref}/database/query`, { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ query: sql }) });
  return rows.length ? fail(id, `RLS off on: ${rows.map((r) => r.relname).join(', ')}`) : pass(id, 'RLS on for every public table');
}

const NEON = 'https://console.neon.tech/api/v2';

async function neonBackup(ctx, id) {
  const key = ctx.env.NEON_API_KEY;
  if (!key) return skip(id, 'Neon not connected');
  let project = ctx.config['neon.project'];
  if (!project) {
    const list = (await json(ctx, `${NEON}/projects?limit=2`, bearer(key))).projects || [];
    if (list.length !== 1) return skip(id, list.length ? 'set neon.project: the key sees more than one project' : 'the Neon key sees no projects');
    project = list[0].id;
  }
  const p = (await json(ctx, `${NEON}/projects/${encodeURIComponent(project)}`, bearer(key))).project || {};
  const secs = Number(p.history_retention_seconds || 0);
  if (!secs) return fail(id, 'Neon history retention is off, so the database can\'t be restored to an earlier point');
  const span = secs >= 86_400 ? `${Math.round(secs / 86_400)} day(s)` : `${Math.round(secs / 3600)} hour(s)`;
  return pass(id, `Neon keeps ${span} of history for point-in-time restore`);
}

async function supabaseBackup(ctx, id) {
  const token = ctx.env.SUPABASE_ACCESS_TOKEN;
  const ref = ctx.config['supabase.ref'];
  if (!token || !ref) return skip(id, 'set supabase.ref to check backups');
  const r = await json(ctx, `https://api.supabase.com/v1/projects/${ref}/database/backups`, bearer(token));
  if (r.pitr_enabled) return pass(id, 'point-in-time recovery on');
  const week = (r.backups || []).filter((b) => /completed/i.test(b.status || '') && ctx.now - Date.parse(b.inserted_at) < 8 * 86_400_000).length;
  return week ? pass(id, `${week} backup(s) in the last week`) : fail(id, 'no Supabase backup in the last week (free projects get none)');
}

export function githubRepo(state) {
  if (state.config?.['github.repo']) return state.config['github.repo'];
  try {
    const remote = execFileSync('git', ['-C', state.root, 'remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Stripe: the default payments provider.
const STRIPE = {
  async products(ctx) {
    const key = ctx.env.STRIPE_SECRET_KEY;
    if (!key) return skip('pay-products', 'Stripe not connected');
    const r = await json(ctx, 'https://api.stripe.com/v1/prices?active=true&limit=10&type=recurring', { authorization: `Bearer ${key}` });
    return r.data?.length ? pass('pay-products', `${r.data.length} active recurring price(s)`) : fail('pay-products', 'no active recurring prices in Stripe');
  },
  async webhook(ctx) {
    const key = ctx.env.STRIPE_SECRET_KEY;
    if (!key) return skip('pay-webhook', 'Stripe not connected');
    const r = await json(ctx, 'https://api.stripe.com/v1/webhook_endpoints?limit=100', { authorization: `Bearer ${key}` });
    const live = ctx.liveUrl ? new URL(ctx.liveUrl).hostname : null;
    const eps = (r.data || []).filter((e) => e.status === 'enabled');
    const match = live ? eps.find((e) => new URL(e.url).hostname === live) : eps[0];
    if (!match) return fail('pay-webhook', live ? `no enabled Stripe webhook points at ${live}` : 'no enabled Stripe webhook');
    const needed = ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted'];
    const ev = match.enabled_events || [];
    const missing = ev.includes('*') ? [] : needed.filter((n) => !ev.includes(n));
    if (missing.length) return fail('pay-webhook', `webhook is missing ${missing.join(', ')}`);
    // A webhook that exists but rejects deliveries is the classic silent failure.
    return rejectsUnsigned(ctx, 'pay-webhook', match.url, 'Stripe');
  },
  async live(ctx) {
    const key = ctx.env.STRIPE_LIVE_SECRET_KEY || ctx.env.STRIPE_SECRET_KEY;
    if (!key) return skip('pay-live', 'Stripe not connected');
    if (!key.startsWith('sk_live_') && !key.startsWith('rk_live_')) return fail('pay-live', 'Stripe key is still a test key');
    const r = await json(ctx, 'https://api.stripe.com/v1/account', { authorization: `Bearer ${key}` });
    if (!r.charges_enabled) return fail('pay-live', 'Stripe account cannot take live charges yet (finish activation)');
    if (!r.payouts_enabled) return fail('pay-live', 'Stripe payouts are not enabled yet (add a bank account)');
    return pass('pay-live', 'live key, charges and payouts enabled');
  },
  // The purchase flow, proven from Stripe's records instead of a test report:
  // a test-mode Checkout on this app was paid and the app's webhook accepted
  // the event, then the subscription was cancelled and the webhook accepted
  // that too. Wherever the test ran (CI, a laptop, a person clicking), this
  // can't pass unless a purchase really went through the app's own Checkout.
  async e2e(ctx) {
    const key = ctx.env.STRIPE_SECRET_KEY;
    if (!purchaseProvenByStripe(ctx.state, { stripeConnected: !!key, uses: ctx.uses })) return skip('pay-e2e', "proven by Stripe for web apps; this app's own test run stands");
    if (!key) return skip('pay-e2e', 'Stripe not connected');
    if (!/^(sk|rk)_test_/.test(key)) return skip('pay-e2e', 'checked in Stripe test mode only; the last result stands');
    const auth = { authorization: `Bearer ${key}` };
    const since = Math.floor(ctx.now / 1000) - 30 * 86_400; // Stripe keeps events for 30 days
    const [sessions, endpoints, paidEvents, cancelEvents] = await Promise.all([
      json(ctx, `https://api.stripe.com/v1/checkout/sessions?status=complete&limit=100&created[gte]=${since}&expand[]=data.subscription`, auth),
      json(ctx, 'https://api.stripe.com/v1/webhook_endpoints?limit=100', auth),
      json(ctx, `https://api.stripe.com/v1/events?type=checkout.session.completed&limit=100&created[gte]=${since}`, auth),
      json(ctx, `https://api.stripe.com/v1/events?type=customer.subscription.deleted&limit=100&created[gte]=${since}`, auth),
    ]);
    const eps = endpoints.data || [];
    // An event with no webhook waiting on it was delivered, but only if a webhook listens for it.
    if (!eps.some((e) => listensFor(e, 'checkout.session.completed'))) return fail('pay-e2e', 'no enabled Stripe webhook listens for checkout.session.completed, so the app never hears about a purchase');

    const hosts = appHosts(ctx.state);
    const onThisApp = (sess) => !hosts.size || [...hosts].some((k) => sameApp(hostOf(sess.success_url || sess.return_url || ''), k));
    // A purchase test that watched the app itself (Liftoff Cloud's browser)
    // and saw it fail outranks Stripe's records from before it: Stripe can
    // show a purchase paid, cancelled and delivered while the app kept Pro
    // switched on. Only purchases made after that test count.
    const failedAt = ctx.checkout ? null : Date.parse(ctx.failedTest?.at || '') || null;
    const afterFail = (sess) => !failedAt || sess.created * 1000 > failedAt;
    // After Liftoff's own test browser ran the purchase, judge that checkout alone.
    const wanted = ctx.checkout ? (sess) => sess.id === ctx.checkout : (sess) => onThisApp(sess) && afterFail(sess);
    const bought = (sessions.data || [])
      .filter((sess) => sess.status === 'complete' && ['paid', 'no_payment_required'].includes(sess.payment_status) && wanted(sess))
      .sort((a, b) => b.created - a.created);
    if (!bought.length && ctx.checkout) return fail('pay-e2e', `Stripe doesn't list the test checkout ${ctx.checkout.slice(0, 8)}…${ctx.checkout.slice(-4)} as complete and paid`);
    if (!bought.length && failedAt) return fail('pay-e2e', `the purchase test failed on ${new Date(failedAt).toISOString().slice(0, 10)}${ctx.failedTest.detail ? ` (${String(ctx.failedTest.detail).slice(0, 160)})` : ''}, and there's no test purchase since: fix it and run the purchase test again`);
    if (!bought.length) {
      const where = hosts.size ? ` on ${[...hosts].join(' or ')}` : '';
      const prev = ctx.state.checklist?.['pay-e2e'];
      if (prev?.by === 'verified' && prev.at) return skip('pay-e2e', `no test purchase${where} in the last 30 days; last proven ${prev.at.slice(0, 10)}`);
      return fail('pay-e2e', `no paid test checkout${where} in the last 30 days: run the purchase flow test${hosts.size ? ' (set preview.url if it ran somewhere else)' : ''}`);
    }

    const delivered = (list, id) => {
      const ev = (list.data || []).find((e) => e.data?.object?.id === id);
      return !!ev && ev.pending_webhooks === 0;
    };
    let firstProblem = null; // from the newest purchase, which is the one the user just ran
    for (const sess of bought) {
      const what = `test purchase ${sess.id.slice(0, 8)}…${sess.id.slice(-4)} on ${new Date(sess.created * 1000).toISOString().slice(0, 10)}`;
      if (!delivered(paidEvents, sess.id)) {
        firstProblem ||= fail('pay-e2e', `${what} was paid, but your webhook hasn't accepted checkout.session.completed (Stripe is still retrying it)`);
        continue;
      }
      if (sess.mode !== 'subscription') return pass('pay-e2e', `${what}: paid, and your webhook accepted it`);
      const sub = sess.subscription && typeof sess.subscription === 'object' ? sess.subscription : null;
      if (sub?.status !== 'canceled') {
        firstProblem ||= fail('pay-e2e', `${what} was paid and your webhook accepted it, but the subscription was never cancelled, so "Pro locks again" wasn't tested`);
        continue;
      }
      if (!eps.some((e) => listensFor(e, 'customer.subscription.deleted'))) return fail('pay-e2e', 'no enabled Stripe webhook listens for customer.subscription.deleted, so a cancelled user keeps Pro');
      if (!delivered(cancelEvents, sub.id)) {
        firstProblem ||= fail('pay-e2e', `${what} was paid and cancelled, but your webhook hasn't accepted customer.subscription.deleted (Stripe is still retrying it)`);
        continue;
      }
      return pass('pay-e2e', `${what}: paid, cancelled, and your webhook accepted both`);
    }
    return firstProblem;
  },
};

// ---------- the checks ----------

const CHECKS = {
  // Hosting and landing page: hit the live URL.
  async 'host-deploy'(ctx) {
    if (!ctx.liveUrl) return skip('host-deploy', 'no live URL recorded yet');
    const res = await get(ctx, ctx.liveUrl, { redirect: 'follow' });
    return res.ok ? pass('host-deploy', `${ctx.liveUrl} answered ${res.status}`) : fail('host-deploy', `${ctx.liveUrl} answered ${res.status}`);
  },
  async 'host-https'(ctx) {
    if (!ctx.liveUrl) return skip('host-https', 'no live URL recorded yet');
    const u = new URL(ctx.liveUrl);
    if (u.protocol !== 'https:') return fail('host-https', 'live URL is not https');
    const res = await get(ctx, `http://${u.host}/`);
    const loc = res.headers.get('location') || '';
    if (![301, 302, 307, 308].includes(res.status) || !loc.startsWith('https://')) {
      return fail('host-https', `http://${u.host} does not redirect to https (got ${res.status})`);
    }
    if (!PLATFORM_HOSTS.test(u.hostname)) {
      const other = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
      try {
        const r2 = await get(ctx, `https://${other}/`);
        const loc2 = r2.headers.get('location') || '';
        if (![301, 302, 307, 308].includes(r2.status) || !loc2.includes(u.hostname)) {
          return fail('host-https', `https://${other} should redirect to ${u.hostname} (got ${r2.status})`);
        }
      } catch {
        return fail('host-https', `https://${other} doesn't answer; add it and redirect it to ${u.hostname}`);
      }
    }
    return pass('host-https', 'https on, http and www redirect');
  },
  async 'host-domain'(ctx) {
    if (!ctx.liveUrl) return skip('host-domain', 'no live URL recorded yet');
    const host = new URL(ctx.liveUrl).hostname;
    if (PLATFORM_HOSTS.test(host)) return fail('host-domain', `${host} is the host's default domain, not your own`);
    try {
      const ips = await ctx.resolve4(host);
      return ips.length ? pass('host-domain', `${host} resolves`) : fail('host-domain', `${host} has no A record`);
    } catch (e) {
      return fail('host-domain', `${host} doesn't resolve (${e.code || e.message})`);
    }
  },
  async 'land-page'(ctx) {
    if (!ctx.liveUrl) return skip('land-page', 'no live URL recorded yet');
    const html = await ctx.page();
    const title = (html.match(/<title[^>]*>([^<]*)</i) || [])[1]?.trim();
    const h1 = /<h1[\s>]/i.test(html);
    return title && h1 ? pass('land-page', `title "${title}"`) : fail('land-page', 'home page has no <title> or <h1>');
  },
  async 'land-og'(ctx) {
    if (!ctx.liveUrl) return skip('land-og', 'no live URL recorded yet');
    const html = await ctx.page();
    const img = (html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i) || [])[1];
    if (!img) return fail('land-og', 'no og:image meta tag');
    const res = await get(ctx, new URL(img, ctx.liveUrl).href, { redirect: 'follow' });
    return res.ok ? pass('land-og', 'og:image loads') : fail('land-og', `og:image answered ${res.status}`);
  },
  async 'land-legal'(ctx) {
    if (!ctx.liveUrl) return skip('land-legal', 'no live URL recorded yet');
    const bad = [];
    for (const p of ['/privacy', '/terms']) {
      const res = await get(ctx, new URL(p, ctx.liveUrl).href, { redirect: 'follow' });
      if (!res.ok) bad.push(`${p} ${res.status}`);
    }
    return bad.length ? fail('land-legal', bad.join(', ')) : pass('land-legal', '/privacy and /terms load');
  },
  async 'mon-uptime'(ctx) {
    if (!ctx.liveUrl) return skip('mon-uptime', 'no live URL recorded yet');
    const p = ctx.config['health.path'] || '/api/health';
    const res = await get(ctx, new URL(p, ctx.liveUrl).href, { redirect: 'follow' });
    if (!res.ok) return fail('mon-uptime', `${p} answered ${res.status}`);
    const hasWorkflow = ctx.files.some((f) => /\.github\/workflows\/.*uptime.*\.ya?ml$/.test(f.split(path.sep).join('/')));
    return hasWorkflow ? pass('mon-uptime', `${p} ok and uptime workflow present`) : fail('mon-uptime', `${p} ok but no uptime workflow`);
  },

  // Payments: ask the provider the app sells through.
  'pay-products': (ctx) => payCheck(ctx, 'pay-products', 'products'),
  'pay-webhook': (ctx) => payCheck(ctx, 'pay-webhook', 'webhook'),
  'pay-live': (ctx) => payCheck(ctx, 'pay-live', 'live'),
  'pay-e2e': (ctx) => {
    const p = useOf(ctx, 'payments');
    if (PAY[p]?.e2e) return (ctx.state.platforms || []).includes('web') ? payCheck(ctx, 'pay-e2e', 'e2e') : skip('pay-e2e', "checked for web apps; this app's own test run stands");
    return STRIPE.e2e(ctx);
  },

  // Crashes: ask Sentry.
  async 'crash-sdk'(ctx) {
    const token = ctx.env.SENTRY_AUTH_TOKEN;
    const org = ctx.config['sentry.org'];
    const proj = ctx.config['sentry.project'];
    if (!token || !org || !proj) return skip('crash-sdk', 'set sentry.org and sentry.project to check events arrive');
    const r = await json(ctx, `https://sentry.io/api/0/projects/${org}/${proj}/events/?per_page=1`, { authorization: `Bearer ${token}` });
    return r.length ? pass('crash-sdk', 'Sentry has received events') : fail('crash-sdk', 'Sentry has never received an event: send a test error');
  },
  async 'crash-alerts'(ctx) {
    const token = ctx.env.SENTRY_AUTH_TOKEN;
    const org = ctx.config['sentry.org'];
    const proj = ctx.config['sentry.project'];
    if (!token || !org || !proj) return skip('crash-alerts', 'set sentry.org and sentry.project');
    const r = await json(ctx, `https://sentry.io/api/0/projects/${org}/${proj}/rules/`, { authorization: `Bearer ${token}` });
    return r.length ? pass('crash-alerts', `${r.length} alert rule(s)`) : fail('crash-alerts', 'no Sentry alert rules');
  },

  // Analytics: ask PostHog which events exist. Sign-up and upgrade events
  // only count for apps that sign people in and take payments; any app
  // should track its core action.
  async 'ana-events'(ctx) {
    const key = ctx.env.POSTHOG_PERSONAL_API_KEY;
    const proj = ctx.config['posthog.project'];
    if (!key || !proj) return skip('ana-events', 'set posthog.project to check events arrive');
    const host = ctx.config['posthog.host'] || 'https://us.posthog.com';
    const r = await json(ctx, `${host}/api/projects/${proj}/event_definitions/?limit=200`, { authorization: `Bearer ${key}` });
    const names = new Set((r.results || []).map((e) => e.name));
    const f = featuresOf(ctx.state);
    const needed = [f.accounts && 'signed_up', f.payments && 'upgraded_to_pro'].filter(Boolean);
    if (!needed.length) {
      const own = [...names].filter((n) => !n.startsWith('$'));
      return own.length ? pass('ana-events', `PostHog sees the app's own events (${own.slice(0, 3).join(', ')})`) : fail('ana-events', "PostHog has only seen automatic events: track the app's core action");
    }
    const missing = needed.filter((n) => !names.has(n));
    return missing.length ? fail('ana-events', `PostHog has never seen ${missing.join(', ')}`) : pass('ana-events', `${needed.join(' and ')} arrive${needed.length === 1 ? 's' : ''}`);
  },

  // CI: ask GitHub about the latest run on the default branch.
  async 'ci-tests'(ctx) {
    const token = ctx.env.GITHUB_TOKEN;
    const repo = ctx.repo;
    if (!token || !repo) return skip('ci-tests', 'GitHub not connected or no GitHub remote');
    const r = await json(ctx, `https://api.github.com/repos/${repo}/actions/runs?per_page=5&exclude_pull_requests=true`, { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' });
    const run = (r.workflow_runs || []).find((w) => w.status === 'completed');
    if (!run) return fail('ci-tests', 'no finished workflow runs');
    return run.conclusion === 'success' ? pass('ci-tests', `latest run "${run.name}" passed`) : fail('ci-tests', `latest run "${run.name}" ${run.conclusion}`);
  },

  // Database: row-level security (Supabase) or open rules (Firebase), and backups.
  'sec-rls'(ctx) {
    const db = useOf(ctx, 'database');
    if (db === 'supabase') return supabaseRls(ctx, 'sec-rls');
    if (db === 'firebase') return firebaseRules(ctx, 'sec-rls');
    return cantCheck(ctx, 'sec-rls', db);
  },
  'sec-backup'(ctx) {
    const db = useOf(ctx, 'database');
    if (db === 'supabase') return supabaseBackup(ctx, 'sec-backup');
    if (db === 'neon') return neonBackup(ctx, 'sec-backup');
    return cantCheck(ctx, 'sec-backup', db);
  },

  // Secrets in the shipped code: scan locally.
  async 'sec-keys'(ctx) {
    const hits = scanSecrets(ctx.root, ctx.files);
    return hits.length
      ? fail('sec-keys', hits.slice(0, 3).map((h) => `${h.kind} in ${h.file}`).join('; ') + (hits.length > 3 ? ` (+${hits.length - 3} more)` : ''))
      : pass('sec-keys', 'no secret keys in client code or build output');
  },

  // Email: SPF and DKIM records on the sending domain.
  async 'email-domain'(ctx) {
    const domain = ctx.config['email.domain'];
    if (!domain) return skip('email-domain', 'set email.domain');
    const txt = async (name) => {
      try {
        return (await ctx.resolveTxt(name)).map((r) => r.join(''));
      } catch {
        return [];
      }
    };
    const provider = useOf(ctx, 'email');
    // SendGrid says itself whether it has verified the domain's records.
    if (provider === 'sendgrid' && ctx.env.SENDGRID_API_KEY) {
      const list = await json(ctx, `https://api.sendgrid.com/v3/whitelabel/domains?domain=${encodeURIComponent(domain)}&limit=50`, bearer(ctx.env.SENDGRID_API_KEY));
      const d = (Array.isArray(list) ? list : []).find((x) => x.domain === domain);
      if (!d) return fail('email-domain', `${domain} isn't set up for sending in SendGrid`);
      return d.valid ? pass('email-domain', `SendGrid has verified ${domain}'s DNS records`) : fail('email-domain', `SendGrid hasn't verified ${domain}'s DNS records yet`);
    }
    const selector = ctx.config['email.dkim'] || { resend: 'resend', sendgrid: 's1' }[provider];
    if (!selector) return skip('email-domain', `set email.dkim to the DKIM selector ${nameOf(ctx, provider)} gave you`);
    const candidates = [domain, `send.${domain}`];
    let spf = false;
    for (const c of candidates) if ((await txt(c)).some((r) => r.startsWith('v=spf1'))) spf = true;
    // Postmark sends from its own return path, so the domain needs DKIM only.
    if (provider === 'postmark') spf = true;
    const dkim = (await txt(`${selector}._domainkey.${domain}`)).some((r) => r.includes('p='));
    if (!spf || !dkim) return fail('email-domain', `${!spf ? 'SPF' : ''}${!spf && !dkim ? ' and ' : ''}${!dkim ? 'DKIM' : ''} missing on ${domain}`);
    return pass('email-domain', `${provider === 'postmark' ? 'DKIM' : 'SPF and DKIM'} found on ${domain}`);
  },
};

export const VERIFIABLE = Object.keys(CHECKS);

function defaultCtx(state, env, files, overrides) {
  let pageCache = null;
  const ctx = {
    state,
    root: state.root,
    liveUrl: state.liveUrl,
    config: state.config || {},
    env,
    files,
    repo: undefined,
    now: Date.now(),
    checkout: null, // a Checkout Session id: pay-e2e checks only that purchase
    failedTest: null, // { at, detail } of a purchase test that failed: pay-e2e ignores purchases before it
    timeout: 10_000,
    fetch: globalThis.fetch,
    resolve4: dns.resolve4,
    resolveTxt: dns.resolveTxt,
    uses: null, // what the app uses per category (usesOf); Liftoff Cloud adds the user's own services
    names: {}, // labels for the user's own services, by id
    modes: {}, // sandbox or live per account, when the key check found out
    ...overrides,
  };
  ctx.uses ||= usesOf(state);
  ctx.memo = {};
  // Several checks read the home page; fetch it once.
  ctx.page = () => {
    pageCache ||= ctx
      .fetch(ctx.liveUrl, { redirect: 'follow', signal: AbortSignal.timeout(ctx.timeout) })
      .then((res) => (res.ok ? res.text() : ''));
    return pageCache;
  };
  // Liftoff Cloud passes the repo (or null) itself: its copies have no git remote.
  if (ctx.repo === undefined) ctx.repo = githubRepo(state);
  return ctx;
}

// Run every check that applies to the app (or just `only`) and return results.
export async function runVerify(state, { env = process.env, files = [], only = null, ...overrides } = {}) {
  const ctx = defaultCtx(state, env, files, overrides);
  const fit = new Set(checklistFor(state.platforms || [], featuresOf(state)).map((c) => c.id));
  const ids = VERIFIABLE.filter((id) => state.checklist[id] && fit.has(id) && (!only || only.includes(id)));
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return await CHECKS[id](ctx);
      } catch (e) {
        return skip(id, `couldn't check: ${e.message}`);
      }
    }),
  );
  return results;
}

// Write results into the checklist.
export function applyVerify(state, results) {
  const at = new Date().toISOString();
  for (const r of results) {
    const cur = state.checklist[r.id];
    if (!cur) continue;
    cur.verify = { ok: r.ok, detail: r.detail, at };
    if (r.ok === true) Object.assign(cur, { done: true, by: 'verified', at });
    else if (r.ok === false) Object.assign(cur, { done: false, by: null, at: null });
  }
  state.lastVerifiedAt = at;
  return state;
}
