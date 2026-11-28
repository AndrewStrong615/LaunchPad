// Launch reports and the "Launch certified" badge: what counts as proven,
// what the public page leaves out, and the shared links end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { zipDirectory } from '../lib/archive.mjs';
import { assess, badgeSvg, renderReport, requiredChecks } from '../lib/report.mjs';
import { FIXTURES, signIn, startTest } from './helpers.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-28T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * DAY).toISOString();
const proven = (d = 1, detail = 'it passed') => ({ done: true, by: 'verified', at: daysAgo(d), verify: { ok: true, detail, at: daysAgo(d) } });
const BASE = ['host-deploy', 'host-https', 'land-legal', 'sec-keys'];

function app(over = {}) {
  return { name: 'Invoicely', slug: 'invoicely', framework: 'nextjs', platforms: ['web'], liveUrl: 'https://invoicely.app', steps: {}, payments: [], integrations: {}, checklist: {}, ...over };
}
const allProven = (ids = BASE) => Object.fromEntries(ids.map((id) => [id, proven()]));
const statusOf = (a, id) => a.checks.find((c) => c.id === id);

test('the checks a certificate needs', () => {
  assert.deepEqual(requiredChecks(app()), BASE);
  assert.deepEqual(requiredChecks(app({ steps: { payments: { provider: 'Stripe' } } })), [...BASE, 'pay-webhook', 'pay-e2e']);
  assert.deepEqual(requiredChecks(app({ payments: ['stripe'] })), [...BASE, 'pay-webhook', 'pay-e2e'], 'the code uses Stripe');
  assert.deepEqual(requiredChecks(app(), { stripeConnected: true }), [...BASE, 'pay-webhook', 'pay-e2e'], 'Stripe connected, no provider chosen yet');
  assert.deepEqual(requiredChecks(app({ steps: { payments: { provider: 'Paddle' } } })), BASE);
  assert.deepEqual(requiredChecks(app({ integrations: { supabase: true } })), [...BASE, 'sec-rls']);
});

test('certified only when every required check was proven by Liftoff in the last 30 days', () => {
  const a = assess(app({ checklist: allProven() }), { now: NOW });
  assert.equal(a.certified, true, a.missing.join('; '));
  assert.deepEqual(a.missing, []);
  assert.equal(a.counts.proven, 4);
  assert.equal(a.score, Math.round((100 * 4) / a.counts.total));
  assert.ok(a.checks.filter((c) => c.required).every((c) => c.status === 'proven'));

  // Ticked by hand: reported, half a point, never a certificate.
  const hand = assess(app({ checklist: { ...allProven(), 'land-legal': { done: true, by: 'you', at: daysAgo(1) } } }), { now: NOW });
  assert.equal(hand.certified, false);
  assert.equal(statusOf(hand, 'land-legal').status, 'reported');
  assert.match(hand.missing.join('\n'), /Privacy policy|legal|terms/i);
  assert.match(hand.missing[0], /marked done by hand, not proven by Liftoff/);
  assert.equal(hand.score, Math.round((100 * 3.5) / hand.counts.total));
  for (const by of ['claude', 'auto']) {
    assert.equal(assess(app({ checklist: { ...allProven(), 'sec-keys': { done: true, by, at: daysAgo(1) } } }), { now: NOW }).certified, false, by);
  }

  // Proven, but too long ago.
  const old = assess(app({ checklist: { ...allProven(), 'host-deploy': proven(31) } }), { now: NOW });
  assert.equal(old.certified, false);
  assert.equal(statusOf(old, 'host-deploy').status, 'stale');
  assert.match(old.missing[0], /last proven 2026-10-28, more than 30 days ago/);

  // Never ran (a skip leaves it unticked): not a pass.
  const skipped = { ...allProven() };
  skipped['host-https'] = { done: false, by: null, at: null, verify: { ok: null, detail: 'no live URL recorded yet', at: daysAgo(0) } };
  const s = assess(app({ checklist: skipped }), { now: NOW });
  assert.equal(s.certified, false);
  assert.equal(statusOf(s, 'host-https').status, 'unproven');
  assert.match(s.missing[0], /not proven by Liftoff yet/);

  // Failing now, even if it passed before.
  const failing = { ...allProven(), 'sec-keys': { done: false, by: null, at: null, verify: { ok: false, detail: 'Stripe secret key in src/pay.js', at: daysAgo(0) } } };
  const f = assess(app({ checklist: failing }), { now: NOW });
  assert.equal(f.certified, false);
  assert.equal(statusOf(f, 'sec-keys').status, 'failed');
  assert.match(f.missing[0], /didn't pass$/);
  assert.doesNotMatch(f.missing.join('\n'), /src\/pay\.js/, 'the reason stays private');

  // Only web apps, for now.
  const ios = assess({ ...app({ platforms: ['ios'] }), checklist: allProven() }, { now: NOW });
  assert.equal(ios.certified, false);
  assert.match(ios.missing[0], /certifies web apps for now/);
});

test("a check that isn't required can fail without blocking, but it costs score", () => {
  const checklist = { ...allProven(), 'pay-live': { done: false, by: null, at: null, verify: { ok: false, detail: 'Stripe key is still a test key', at: daysAgo(0) } } };
  const a = assess(app({ checklist }), { now: NOW });
  assert.equal(a.certified, true);
  assert.equal(a.counts.failed, 1);
});

test('a skip after a pass keeps the proof but not the skip reason', () => {
  const checklist = allProven();
  checklist['host-deploy'] = { ...proven(2, 'https://invoicely.app answered 200'), verify: { ok: null, detail: 'no live URL recorded yet', at: daysAgo(0) } };
  const a = assess(app({ checklist }), { now: NOW });
  assert.equal(statusOf(a, 'host-deploy').status, 'proven');
  assert.equal(statusOf(a, 'host-deploy').detail, null);
  assert.equal(statusOf(a, 'host-deploy').at, daysAgo(2));
  assert.equal(statusOf(a, 'sec-keys').detail, 'it passed');
});

test('the public page escapes everything and leaves out why checks failed', () => {
  const checklist = {
    ...allProven(),
    'sec-rls': { done: false, by: null, at: null, verify: { ok: false, detail: 'RLS off on: secret_admin_notes', at: daysAgo(0) } },
    'pay-live': { done: false, by: null, at: null, verify: { ok: false, detail: 'Stripe key sk_test_123 is a test key', at: daysAgo(0) } },
    'crash-sdk': { done: false, by: null, at: null, verify: { ok: null, detail: 'set sentry.org and sentry.project to check events arrive', at: daysAgo(0) } },
  };
  checklist['land-legal'] = proven(1, '/privacy and /terms load');
  const state = app({ name: '<img src=x onerror=alert(1)>', integrations: { supabase: true }, checklist, liveUrl: 'javascript:alert(1)' });
  const a = assess(state, { now: NOW });
  const html = renderReport({ id: 'rp_AAAAAAAAAAAAAAAAAAAA', createdAt: new Date(NOW).toISOString(), app: { name: state.name, framework: 'nextjs', platforms: ['web'], liveUrl: state.liveUrl }, ...a, purchase: null });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /javascript:/, 'only http(s) live links');
  assert.doesNotMatch(html, /secret_admin_notes/);
  assert.doesNotMatch(html, /sentry\.org/, 'skip reasons are for the owner');
  assert.match(html, /\/privacy and \/terms load/, 'what passed is the evidence');
  assert.match(html, /Not certified yet/);
  assert.match(html, /Didn&#39;t pass/);
  assert.match(html, /Live keys swapped in for production/, 'a check that points at no weakness is named');
  assert.doesNotMatch(html, /sk_test_123/);
  assert.doesNotMatch(html, /<script|style=/, 'no scripts or inline styles (CSP)');
});

test("the public page counts security checks that haven't passed without naming them", () => {
  const checklist = {
    ...allProven(),
    'sec-keys': { done: false, by: null, at: null, verify: { ok: false, detail: 'Stripe secret key in src/pay.js', at: daysAgo(0) } },
    'pay-webhook': { done: false, by: null, at: null, verify: { ok: false, detail: 'no signature check', at: daysAgo(0) } },
    'sec-rate': { done: true, by: 'you', at: daysAgo(1) },
  };
  const state = app({ checklist, payments: ['stripe'] });
  const a = assess(state, { now: NOW });
  assert.equal(a.certified, false);
  const html = renderReport({ id: 'rp_AAAAAAAAAAAAAAAAAAAA', createdAt: new Date(NOW).toISOString(), app: { name: 'Invoicely', framework: 'nextjs', platforms: ['web'], liveUrl: null }, ...a, purchase: null });
  assert.doesNotMatch(html, /No secret keys in the client bundle/);
  assert.doesNotMatch(html, /Webhook endpoint verifies signatures/);
  assert.doesNotMatch(html, /Spend caps|Database backups/, 'open security checks are counted too');
  assert.match(html, /\d+ security checks<\/div><div class="d">Not named on this page until Liftoff proves them/);
  assert.match(html, /Rate limits on auth and paid endpoints/, 'what the team says is done is still listed, as reported');
  assert.doesNotMatch(html, /Didn&#39;t pass/, 'no other check failed');
  const n = a.checks.filter((c) => ['sec-keys', 'pay-webhook', 'sec-rls', 'sec-spend', 'sec-backup', 'pay-entitlement', 'ci-secrets'].includes(c.id) && c.status !== 'proven' && c.status !== 'reported').length;
  assert.match(html, new RegExp(`${n} security checks`));
});

test('the badge claims only what the newest report says', () => {
  const yes = badgeSvg({ certified: true, at: '2026-11-28T10:00:00Z' });
  assert.match(yes, /launch certified · 28 Nov 2026/);
  assert.match(yes, /#0c9466/);
  const no = badgeSvg({ certified: false, at: '2026-11-28T10:00:00Z' });
  assert.match(no, /launch report/);
  assert.doesNotMatch(no, /certified|#0c9466/);
  assert.match(badgeSvg(null), /launch report/);
  for (const svg of [yes, no]) assert.doesNotMatch(svg, /<script|on\w+=|href/);
});

// ---------- over HTTP ----------

// The app's live site as verify sees it.
function fakeSite() {
  const site = { legal: true };
  site.fetch = async (url) => {
    const u = new URL(url);
    const page = (status, body = '', headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
    if (u.host !== 'invoicely-demo.vercel.app') return page(404);
    if (u.protocol === 'http:') return page(301, '', { location: `https://${u.host}${u.pathname}` });
    if (u.pathname === '/') return page(200, '<title>Invoicely</title><h1>Invoices</h1>');
    if (['/privacy', '/terms'].includes(u.pathname)) return page(site.legal ? 200 : 404);
    return page(404);
  };
  return site;
}

const BROWSER = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36' };

test('make a report, share it, badge it, take it down', async () => {
  const site = fakeSite();
  const t = await startTest({ safeFetch: site.fetch });
  try {
    const me = await signIn(t.base);
    const zip = zipDirectory(path.join(FIXTURES, 'next-saas'), { prefix: 'next-saas/' });
    const slug = (await me.call('POST', '/api/import/zip?name=next-saas.zip', zip, { 'content-type': 'application/zip' })).body.slug;
    const uid = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
    t.ctx.store.updateApp(uid, slug, (s) => { s.liveUrl = 'https://invoicely-demo.vercel.app'; });

    let r = (await me.get(`/api/apps/${slug}`)).body.cloud.report;
    assert.equal(r.now.certified, false);
    assert.equal(r.latest, null);
    assert.equal(r.badge, null);

    // A report runs every check again first.
    let res = await me.post(`/api/apps/${slug}/report`);
    assert.equal(res.status, 200, res.text);
    r = res.body.cloud.report;
    assert.equal(r.latest.certified, true, JSON.stringify(r.now.missing));
    assert.match(r.latest.url, /\/r\/rp_[A-Za-z0-9_-]{20}$/);
    assert.match(r.badge.url, /\/b\/bd_[A-Za-z0-9_-]{20}$/);
    assert.equal(r.badge.image, `${r.badge.url}.svg`);
    const first = r.latest;
    const item = (id) => res.body.checklist.find((c) => c.id === id);
    assert.equal(item('host-deploy').by, 'verified');
    assert.equal(item('host-domain').verify.ok, false, 'the host\'s own domain fails, but isn\'t required');

    // Anyone with the link can open it, signed in or not.
    const page = await fetch(new URL(first.url).pathname.replace(/^/, t.base));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(page.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(page.headers.get('x-robots-tag'), 'noindex');
    assert.match(page.headers.get('content-security-policy'), /style-src 'self'/);
    assert.match(html, /<h1>next-saas<\/h1>|<h1>invoicely<\/h1>/i);
    assert.match(html, /Launch certified/);
    assert.match(html, /invoicely-demo\.vercel\.app answered 200/);
    assert.doesNotMatch(html, /host's default domain/, "a failure's reason isn't public");
    const css = await fetch(`${t.base}/report.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    // The badge, and a visit through it.
    const svg = await fetch(`${t.base}${new URL(r.badge.image).pathname}`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(svg.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.match(await svg.text(), /launch certified/);
    const badgePath = new URL(r.badge.url).pathname;
    const click = (headers = BROWSER) => fetch(`${t.base}${badgePath}`, { redirect: 'manual', headers });
    let go = await click();
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), new URL(first.url).pathname);
    await click(); // the same visitor again inside 10 minutes
    await click({ 'user-agent': 'Twitterbot/1.0' });
    await click({ ...BROWSER, 'x-forwarded-for': '203.0.113.9' });
    assert.equal((await me.get(`/api/apps/${slug}`)).body.cloud.report.badge.clicks, 2);
    assert.equal((await me.get(`/api/apps/${slug}`)).body.updatedAt, res.body.updatedAt, "a click doesn't count as the app changing");

    // The privacy page breaks: the next report isn't certified and the badge stops saying so.
    site.legal = false;
    res = await me.post(`/api/apps/${slug}/report`);
    r = res.body.cloud.report;
    assert.equal(r.latest.certified, false);
    assert.equal(r.history.length, 2);
    assert.match(r.now.missing.join('\n'), /didn't pass/);
    assert.match(await (await fetch(`${t.base}${new URL(r.badge.image).pathname}`)).text(), /launch report/);
    go = await click({ ...BROWSER, 'x-forwarded-for': '203.0.113.10' });
    assert.equal(go.headers.get('location'), new URL(r.latest.url).pathname);
    const second = r.latest;
    assert.match(await (await fetch(`${t.base}${new URL(second.url).pathname}`)).text(), /Not certified yet/);
    assert.equal((await fetch(`${t.base}${new URL(first.url).pathname}`)).status, 200, 'earlier reports keep their links');

    // Taking the newest down brings the badge back to the certified one.
    assert.equal((await me.del(`/api/apps/${slug}/report/rp_AAAAAAAAAAAAAAAAAAAA`)).status, 404);
    res = await me.del(`/api/apps/${slug}/report/${second.id}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.cloud.report.latest.id, first.id);
    const gone = await fetch(`${t.base}${new URL(second.url).pathname}`);
    assert.equal(gone.status, 404);
    assert.match(await gone.text(), /This report isn't here/);
    assert.match(await (await fetch(`${t.base}${new URL(r.badge.image).pathname}`)).text(), /launch certified/);

    // Links that were never made.
    for (const p of ['/r/rp_AAAAAAAAAAAAAAAAAAAA', '/r/rp_short', '/b/bd_AAAAAAAAAAAAAAAAAAAA.svg', '/b/bd_AAAAAAAAAAAAAAAAAAAA', `${new URL(first.url).pathname}/../state.json`, `${new URL(first.url).pathname}/report.json`]) {
      assert.equal((await fetch(`${t.base}${p}`, { redirect: 'manual' })).status, 404, p);
    }

    // Removing the app takes every link down with it.
    assert.equal((await me.del(`/api/apps/${slug}`)).status, 200);
    assert.equal((await fetch(`${t.base}${new URL(first.url).pathname}`)).status, 404);
    assert.equal((await fetch(`${t.base}${new URL(r.badge.image).pathname}`)).status, 404);
    assert.deepEqual(fs.readdirSync(path.join(t.dataDir, 'public')).filter((f) => f.startsWith(first.id) || f.startsWith(r.badge.url.split('/').pop())), []);
  } finally {
    await t.stop();
  }
});

test("Liftoff's purchase test goes in the report, screenshots and all", async () => {
  const site = fakeSite();
  const t = await startTest({ safeFetch: site.fetch });
  try {
    const me = await signIn(t.base);
    const zip = zipDirectory(path.join(FIXTURES, 'next-saas'), { prefix: 'next-saas/' });
    const slug = (await me.call('POST', '/api/import/zip?name=next-saas.zip', zip, { 'content-type': 'application/zip' })).body.slug;
    const uid = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
    const at = new Date().toISOString();
    const dir = path.join(t.ctx.store.appDir(uid, slug), 'proof', 'p_0123456789ab');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-open.jpg'), Buffer.from('ffd8ffd9', 'hex'));
    t.ctx.store.updateApp(uid, slug, (s) => {
      s.liveUrl = 'https://invoicely-demo.vercel.app';
      s.checklist['pay-e2e'] = { done: true, by: 'verified', at, verify: { ok: true, detail: 'test purchase cs_test_…0001: paid, cancelled, and your webhook accepted both', at } };
      s.proof = { latest: { id: 'p_0123456789ab', status: 'passed', endedAt: at, checkout: 'cs_test_…0001', steps: [
        { name: 'open', ok: true, detail: 'Opened invoicely-demo.vercel.app', shot: '01-open.jpg' },
        { name: 'checkout', ok: true, detail: 'Paid cs_test_…0001 with the 4242 test card', shot: '../../state.json' },
        { name: 'stripe', ok: true, detail: 'paid, cancelled, and your webhook accepted both', shot: null },
      ] }, history: [] };
    });
    const r = (await me.post(`/api/apps/${slug}/report`)).body.cloud.report;
    const reportPath = new URL(r.latest.url).pathname;
    const html = await (await fetch(`${t.base}${reportPath}`)).text();
    assert.match(html, /Purchase test/);
    assert.match(html, /Stripe test checkout cs_test_…0001/);
    assert.match(html, /Pay with Stripe’s test card/);
    assert.match(html, new RegExp(`src="${reportPath}/01-open\\.jpg"`));
    assert.doesNotMatch(html, /state\.json/);
    const img = await fetch(`${t.base}${reportPath}/01-open.jpg`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(`${t.base}${reportPath}/02-checkout.jpg`)).status, 404);
  } finally {
    await t.stop();
  }
});
