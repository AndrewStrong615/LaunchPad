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
// still record their own test run until Liftoff can check those.
export function purchaseProvenByStripe(state, { stripeConnected = false } = {}) {
  if (!(state.platforms || []).includes('web')) return false;
  const provider = state.steps?.payments?.provider;
  return provider ? /stripe/i.test(provider) : stripeConnected;
}

// A web app that takes payments through Stripe: the payments step says so,
// the code uses Stripe, or (before either) Stripe is connected.
export function sellsWithStripe(state, { stripeConnected = false } = {}) {
  if (purchaseProvenByStripe(state, { stripeConnected })) return true;
  return (state.platforms || []).includes('web') && !state.steps?.payments?.provider && (state.payments || []).includes('stripe');
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

  // Payments: ask Stripe.
  async 'pay-products'(ctx) {
    const key = ctx.env.STRIPE_SECRET_KEY;
    if (!key) return skip('pay-products', 'Stripe not connected');
    const r = await json(ctx, 'https://api.stripe.com/v1/prices?active=true&limit=10&type=recurring', { authorization: `Bearer ${key}` });
    return r.data?.length ? pass('pay-products', `${r.data.length} active recurring price(s)`) : fail('pay-products', 'no active recurring prices in Stripe');
  },
  async 'pay-webhook'(ctx) {
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
    const res = await ctx.fetch(match.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(ctx.timeout) });
    if (res.status === 404 || res.status === 405) return fail('pay-webhook', `${match.url} answered ${res.status}: route missing`);
    if (res.ok) return fail('pay-webhook', `${match.url} accepted an unsigned request: verify the Stripe signature`);
    return pass('pay-webhook', `${match.url} exists and rejects unsigned requests (${res.status})`);
  },
  async 'pay-live'(ctx) {
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
  async 'pay-e2e'(ctx) {
    const key = ctx.env.STRIPE_SECRET_KEY;
    if (!purchaseProvenByStripe(ctx.state, { stripeConnected: !!key })) return skip('pay-e2e', "proven by Stripe for web apps; this app's own test run stands");
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

  // Analytics: ask PostHog which events exist.
  async 'ana-events'(ctx) {
    const key = ctx.env.POSTHOG_PERSONAL_API_KEY;
    const proj = ctx.config['posthog.project'];
    if (!key || !proj) return skip('ana-events', 'set posthog.project to check events arrive');
    const host = ctx.config['posthog.host'] || 'https://us.posthog.com';
    const r = await json(ctx, `${host}/api/projects/${proj}/event_definitions/?limit=200`, { authorization: `Bearer ${key}` });
    const names = new Set((r.results || []).map((e) => e.name));
    const needed = ['signed_up', 'upgraded_to_pro'];
    const missing = needed.filter((n) => !names.has(n));
    return missing.length ? fail('ana-events', `PostHog has never seen ${missing.join(', ')}`) : pass('ana-events', 'signed_up and upgraded_to_pro arrive');
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

  // Database: ask Supabase which public tables have RLS off.
  async 'sec-rls'(ctx) {
    const token = ctx.env.SUPABASE_ACCESS_TOKEN;
    const ref = ctx.config['supabase.ref'];
    if (!token || !ref) return skip('sec-rls', 'set supabase.ref to check row-level security');
    const sql = "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity";
    const rows = await json(ctx, `https://api.supabase.com/v1/projects/${ref}/database/query`, { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ query: sql }) });
    return rows.length ? fail('sec-rls', `RLS off on: ${rows.map((r) => r.relname).join(', ')}`) : pass('sec-rls', 'RLS on for every public table');
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
    const candidates = [domain, `send.${domain}`];
    let spf = false;
    for (const c of candidates) if ((await txt(c)).some((r) => r.startsWith('v=spf1'))) spf = true;
    const dkim = (await txt(`resend._domainkey.${domain}`)).some((r) => r.includes('p='));
    if (!spf || !dkim) return fail('email-domain', `${!spf ? 'SPF' : ''}${!spf && !dkim ? ' and ' : ''}${!dkim ? 'DKIM' : ''} missing on ${domain}`);
    return pass('email-domain', `SPF and DKIM found on ${domain}`);
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
    ...overrides,
  };
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
  const ids = VERIFIABLE.filter((id) => state.checklist[id] && (!only || only.includes(id)));
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
