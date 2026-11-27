// Pulse: live numbers after launch, pulled from the accounts that are already
// connected. Every source is optional; a source that isn't set up is simply
// absent, and a source that errors is reported under `errors`.
const DAY = 86_400_000;

async function getJson(ctx, url, headers, opts = {}) {
  const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(ctx.timeout), ...opts });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

function monthly(price, quantity = 1) {
  const amt = (price?.unit_amount || 0) * quantity;
  const r = price?.recurring;
  if (!r) return 0;
  const n = r.interval_count || 1;
  const perMonth = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 }[r.interval] ?? 1;
  return (amt * perMonth) / n;
}

const SOURCES = {
  async stripe(ctx) {
    const key = ctx.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    const auth = { authorization: `Bearer ${key}` };
    let mrr = 0;
    let active = 0;
    let newSubs = 0;
    let currency = 'usd';
    let after = null;
    const since = Math.floor((ctx.now - 7 * DAY) / 1000);
    for (let page = 0; page < 10; page++) {
      const q = `https://api.stripe.com/v1/subscriptions?status=active&limit=100&expand[]=data.items.data.price${after ? `&starting_after=${after}` : ''}`;
      const r = await getJson(ctx, q, auth);
      for (const sub of r.data || []) {
        active++;
        if (sub.created >= since) newSubs++;
        for (const item of sub.items?.data || []) {
          mrr += monthly(item.price, item.quantity);
          currency = item.price?.currency || currency;
        }
      }
      if (!r.has_more) break;
      after = r.data.at(-1).id;
    }
    const trials = await getJson(ctx, 'https://api.stripe.com/v1/subscriptions?status=trialing&limit=100', auth);
    const churn = await getJson(ctx, `https://api.stripe.com/v1/events?type=customer.subscription.deleted&limit=100&created[gte]=${since}`, auth);
    const failed = await getJson(ctx, `https://api.stripe.com/v1/events?type=invoice.payment_failed&limit=100&created[gte]=${since}`, auth);
    return {
      mrr: Math.round(mrr) / 100,
      currency,
      activeSubscriptions: active,
      trials: trials.data?.length || 0,
      newSubscriptions7d: newSubs,
      cancellations7d: churn.data?.length || 0,
      failedPayments7d: failed.data?.length || 0,
    };
  },

  async revenuecat(ctx) {
    const key = ctx.env.REVENUECAT_API_KEY;
    const proj = ctx.config['revenuecat.project'];
    if (!key || !proj) return null;
    const r = await getJson(ctx, `https://api.revenuecat.com/v2/projects/${proj}/metrics/overview`, { authorization: `Bearer ${key}` });
    const m = Object.fromEntries((r.metrics || []).map((x) => [x.id, x.value]));
    return {
      mrr: m.mrr ?? null,
      currency: 'usd',
      activeSubscriptions: m.active_subscriptions ?? null,
      trials: m.active_trials ?? null,
      revenue28d: m.revenue ?? null,
      newCustomers28d: m.new_customers ?? null,
      activeUsers28d: m.active_users ?? null,
    };
  },

  async posthog(ctx) {
    const key = ctx.env.POSTHOG_PERSONAL_API_KEY;
    const proj = ctx.config['posthog.project'];
    if (!key || !proj) return null;
    const host = ctx.config['posthog.host'] || 'https://us.posthog.com';
    const query = async (sql) =>
      (await getJson(ctx, `${host}/api/projects/${proj}/query/`, { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, {
        method: 'POST',
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } }),
      })).results || [];
    const rows = await query(
      "select event, countIf(timestamp > now() - interval 7 day), countIf(timestamp <= now() - interval 7 day) from events where timestamp > now() - interval 14 day and event in ('signed_up', 'activated', 'paywall_viewed', 'upgraded_to_pro') group by event",
    );
    const ev = Object.fromEntries(rows.map(([e, cur, prev]) => [e, { cur: Number(cur), prev: Number(prev) }]));
    const [[users] = [0]] = await query('select count(distinct person_id) from events where timestamp > now() - interval 7 day');
    const c = (e) => ev[e]?.cur ?? 0;
    const p = (e) => ev[e]?.prev ?? 0;
    return {
      activeUsers7d: Number(users),
      signups7d: c('signed_up'),
      signupsPrev7d: p('signed_up'),
      activations7d: c('activated'),
      paywallViews7d: c('paywall_viewed'),
      upgrades7d: c('upgraded_to_pro'),
      upgradesPrev7d: p('upgraded_to_pro'),
    };
  },

  async sentry(ctx) {
    const token = ctx.env.SENTRY_AUTH_TOKEN;
    const org = ctx.config['sentry.org'];
    const slug = ctx.config['sentry.project'];
    if (!token || !org || !slug) return null;
    const auth = { authorization: `Bearer ${token}` };
    const proj = await getJson(ctx, `https://sentry.io/api/0/projects/${org}/${slug}/`, auth);
    let crashFree = null;
    try {
      const s = await getJson(ctx, `https://sentry.io/api/0/organizations/${org}/sessions/?project=${proj.id}&field=crash_free_rate(session)&statsPeriod=7d&interval=7d`, auth);
      crashFree = s.groups?.[0]?.totals?.['crash_free_rate(session)'] ?? null;
    } catch {
      // Web projects without release health have no sessions; leave it empty.
    }
    const issues = await getJson(ctx, `https://sentry.io/api/0/projects/${org}/${slug}/issues/?query=${encodeURIComponent('is:unresolved firstSeen:-7d')}&sort=freq&limit=25`, auth);
    const top = issues[0];
    return {
      crashFreeSessions: crashFree,
      newIssues7d: issues.length,
      topIssue: top ? { title: top.title, events: Number(top.count), users: top.userCount, url: top.permalink } : null,
    };
  },

  async uptime(ctx) {
    if (!ctx.liveUrl) return null;
    const t = Date.now();
    try {
      const res = await ctx.fetch(ctx.liveUrl, { redirect: 'follow', signal: AbortSignal.timeout(ctx.timeout) });
      return { up: res.ok, status: res.status, ms: Date.now() - t };
    } catch (e) {
      return { up: false, status: null, ms: null, error: e.message };
    }
  },
};

export async function collectPulse(state, { env = process.env, fetch = globalThis.fetch, now = Date.now(), timeout = 10_000 } = {}) {
  const ctx = { env, fetch, now, timeout, config: state.config || {}, liveUrl: state.liveUrl };
  const snapshot = { at: new Date(now).toISOString(), errors: {} };
  await Promise.all(
    Object.entries(SOURCES).map(async ([name, fn]) => {
      try {
        const r = await fn(ctx);
        if (r) snapshot[name] = r;
      } catch (e) {
        snapshot.errors[name] = e.message;
      }
    }),
  );
  return snapshot;
}

// Revenue from whichever payments source exists (RevenueCat includes synced Stripe).
export function revenueOf(snap) {
  return snap?.revenuecat?.mrr ?? snap?.stripe?.mrr ?? null;
}

// Keep one snapshot per day for 90 days, and attach week-over-week change.
export function recordPulse(state, snapshot) {
  state.pulse ||= { latest: null, history: [] };
  const day = snapshot.at.slice(0, 10);
  state.pulse.history = state.pulse.history.filter((h) => h.at.slice(0, 10) !== day);
  state.pulse.history.push(snapshot);
  state.pulse.history = state.pulse.history.slice(-90);
  const weekAgo = [...state.pulse.history].reverse().find((h) => Date.parse(snapshot.at) - Date.parse(h.at) >= 6 * DAY);
  const mrr = revenueOf(snapshot);
  const prevMrr = revenueOf(weekAgo);
  snapshot.change = { mrr: mrr !== null && prevMrr !== null ? Math.round((mrr - prevMrr) * 100) / 100 : null, since: weekAgo?.at || null };
  state.pulse.latest = snapshot;
  return snapshot;
}
