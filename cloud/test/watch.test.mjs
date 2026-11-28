// Watching launched apps (lib/watch.mjs): who is watched, uptime and the
// down/up incidents, the daily run of every check, certificate and domain
// expiry, pausing, and what the Flight Board gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { zipDirectory } from '../lib/archive.mjs';
import { registrableDomain } from '../lib/watch.mjs';
import { FIXTURES, signIn, startTest } from './helpers.mjs';

const MIN = 60_000;
const DAY = 86_400_000;
const LIVE = 'https://invoicely.app';

// The live site as the checks see it. `site.status` is what the home page answers.
function fakeSite() {
  const site = { status: 200, legal: 200, calls: [] };
  site.fetch = async (url) => {
    const u = new URL(url);
    site.calls.push(u.href);
    if (u.host !== 'invoicely.app' && u.host !== 'www.invoicely.app') return new Response('nope', { status: 404 });
    if (u.protocol === 'http:') return new Response(null, { status: 301, headers: { location: `https://invoicely.app${u.pathname}` } });
    if (u.host === 'www.invoicely.app') return new Response(null, { status: 301, headers: { location: 'https://invoicely.app/' } });
    if (u.pathname === '/privacy' || u.pathname === '/terms') return new Response('legal', { status: site.legal });
    return new Response('<title>Invoicely</title><h1>Invoices</h1>', { status: site.status });
  };
  return site;
}

async function setup({ env = {}, cert, domain } = {}) {
  const site = fakeSite();
  const clock = { t: Date.parse('2026-11-28T12:00:00Z') };
  const probes = {
    cert: cert || (async () => ({ validTo: new Date(clock.t + 60 * DAY).toISOString(), issuer: "Let's Encrypt", trusted: true, problem: null })),
    domain: domain || (async () => new Date(clock.t + 200 * DAY).toISOString()),
  };
  const t = await startTest({ env, safeFetch: site.fetch, watch: { now: () => clock.t, probes } });
  const me = await signIn(t.base);
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'), { prefix: 'next-saas/' });
  const slug = (await me.call('POST', '/api/import/zip?name=next-saas.zip', zip, { 'content-type': 'application/zip' })).body.slug;
  const events = [];
  t.ctx.watch.on((uid, s, ev) => events.push({ slug: s, type: ev.type, key: ev.incident.key, title: ev.incident.title, quiet: !!ev.quiet }));
  const watch = async () => (await me.get(`/api/apps/${slug}`)).body.cloud.watch;
  const later = (ms) => { clock.t += ms; };
  return { t, me, site, clock, slug, events, watch, later, w: t.ctx.watch };
}

test('an app is watched once it has a live address, and checked every few minutes', async () => {
  const { t, me, site, slug, events, watch, later, w } = await setup();
  try {
    let v = await watch();
    assert.equal(v.enabled, true);
    assert.equal(v.watching, false);
    assert.equal(v.why, 'no-live-url');
    assert.equal(v.pro.via, 'open', 'payments are off, so watching is free');
    await w.runDue();
    assert.equal(site.calls.length, 0, 'nothing to check without a live address');

    await me.post(`/api/apps/${slug}/live`, { url: 'invoicely.app' });
    v = await watch();
    assert.equal(v.watching, true);
    assert.equal(v.status, 'pending');
    assert.equal(v.target, `${LIVE}/`);

    // The first pass checks uptime and runs every check once.
    await w.runDue();
    v = await watch();
    assert.equal(v.status, 'up');
    assert.equal(v.uptime.ok, true);
    assert.equal(v.uptime.day, 100);
    assert.equal(v.bars.length, 48);
    assert.equal(v.bars.at(-1), 'up');
    assert.ok(v.daily, 'the daily check ran');
    assert.ok(v.daily.passed >= 2, JSON.stringify(v.daily));
    assert.equal(v.daily.cert.days, 60);
    assert.equal(v.daily.domain.name, 'invoicely.app');
    assert.equal(v.daily.domain.days, 200);
    assert.deepEqual(v.incidents.open, []);

    // A minute later nothing is due yet.
    const n = site.calls.length;
    later(MIN);
    await w.runDue();
    assert.equal(site.calls.length, n);

    // One failed check is a blip: checking again, no incident.
    site.status = 503;
    later(5 * MIN);
    await w.runDue();
    v = await watch();
    assert.equal(v.status, 'checking');
    assert.equal(v.incidents.open.length, 0);
    const firstFail = v.uptime.at;

    // Two in a row: down, from the first failed check.
    later(5 * MIN);
    await w.runDue();
    v = await watch();
    assert.equal(v.status, 'down');
    assert.equal(v.incidents.open.length, 1);
    assert.equal(v.incidents.open[0].title, 'invoicely.app is down');
    assert.match(v.incidents.open[0].detail, /answered 503/);
    assert.equal(v.incidents.open[0].openedAt, firstFail);
    assert.ok(v.uptime.day < 100);
    assert.deepEqual(events.map((e) => `${e.type} ${e.key}`), ['opened down']);

    // Still down: the same incident, no new event.
    later(5 * MIN);
    await w.runDue();
    assert.equal((await watch()).incidents.open.length, 1);
    assert.equal(events.length, 1);

    // Back up: closed.
    site.status = 200;
    later(5 * MIN);
    await w.runDue();
    v = await watch();
    assert.equal(v.status, 'up');
    assert.equal(v.incidents.open.length, 0);
    assert.equal(v.incidents.recent[0].key, 'down');
    assert.ok(v.incidents.recent[0].closedAt);
    assert.deepEqual(events.map((e) => `${e.type} ${e.key}`), ['opened down', 'closed down']);
    assert.ok(v.bars.includes('down') || v.bars.includes('part'));

    // Check now runs the uptime check straight away.
    const before = site.calls.length;
    const r = await me.post(`/api/apps/${slug}/watch/check`);
    assert.equal(r.status, 200);
    assert.equal(site.calls.length, before + 1);
    assert.equal(r.body.cloud.watch.status, 'up');
  } finally {
    await t.stop();
  }
});

test('the daily check opens an incident when a check that passed starts failing', async () => {
  const { t, me, site, slug, events, watch, later, w } = await setup({
    cert: async () => ({ validTo: new Date(Date.parse('2026-11-28T12:00:00Z') + 10 * DAY).toISOString(), issuer: 'R3', trusted: true, problem: null }),
    domain: async () => new Date(Date.parse('2026-11-28T12:00:00Z') + 20 * DAY).toISOString(),
  });
  try {
    await me.post(`/api/apps/${slug}/live`, { url: LIVE });
    await w.runDue();
    let v = await watch();
    let item = (await me.get(`/api/apps/${slug}`)).body.checklist.find((c) => c.id === 'land-legal');
    assert.equal(item.done, true, 'verify proved the legal pages');
    // A certificate that runs out in 10 days and a domain in 20 are both news.
    assert.deepEqual(v.incidents.open.map((i) => i.key).sort(), ['cert', 'domain']);
    assert.match(v.incidents.open.find((i) => i.key === 'cert').detail, /expires in 10 days/);
    assert.match(v.incidents.open.find((i) => i.key === 'domain').title, /Domain invoicely\.app needs renewing/);
    // A check that never passed (no uptime workflow, say) is not an incident.
    assert.ok(!v.incidents.open.some((i) => i.key.startsWith('check:')));

    // The terms page goes missing: the next daily check says so.
    site.legal = 404;
    later(24 * 60 * MIN);
    await w.runDue();
    v = await watch();
    const broke = v.incidents.open.find((i) => i.key === 'check:land-legal');
    assert.ok(broke, JSON.stringify(v.incidents));
    assert.match(broke.title, /stopped passing/);
    assert.match(broke.detail, /\/privacy 404/);
    item = (await me.get(`/api/apps/${slug}`)).body.checklist.find((c) => c.id === 'land-legal');
    assert.equal(item.done, false, 'verify unticked it');

    // Fixed: closed the next day.
    site.legal = 200;
    later(24 * 60 * MIN);
    await w.runDue();
    v = await watch();
    assert.ok(!v.incidents.open.some((i) => i.key === 'check:land-legal'));
    assert.ok(events.some((e) => e.type === 'closed' && e.key === 'check:land-legal'));
  } finally {
    await t.stop();
  }
});

test('pausing stops the checks and closes what is open, quietly', async () => {
  const { t, me, site, slug, events, watch, later, w } = await setup();
  try {
    await me.post(`/api/apps/${slug}/live`, { url: LIVE });
    site.status = 500;
    await w.runDue();
    later(5 * MIN);
    await w.runDue();
    assert.equal((await watch()).status, 'down');

    let r = await me.post(`/api/apps/${slug}/watch`, { paused: true });
    assert.equal(r.body.cloud.watch.watching, false);
    assert.equal(r.body.cloud.watch.why, 'paused');
    assert.equal(r.body.cloud.watch.incidents.open.length, 0);
    assert.deepEqual(events.map((e) => `${e.type}${e.quiet ? ' quiet' : ''}`), ['opened', 'closed quiet']);
    const n = site.calls.length;
    later(60 * MIN);
    await w.runDue();
    assert.equal(site.calls.length, n, 'no checks while paused');
    assert.equal((await me.post(`/api/apps/${slug}/watch/check`)).status, 400);
    assert.equal((await me.post(`/api/apps/${slug}/watch`, { paused: 'yes' })).status, 400);

    r = await me.post(`/api/apps/${slug}/watch`, { paused: false });
    assert.equal(r.body.cloud.watch.watching, true);
  } finally {
    await t.stop();
  }
});

test('with payments on, watching comes with the Launch Pass for 30 days', async () => {
  const { t, me, slug, watch, clock, w } = await setup({ env: { LIFTOFF_STRIPE_SECRET_KEY: 'sk_test_liftoff' } });
  try {
    await me.post(`/api/apps/${slug}/live`, { url: LIVE });
    let v = await watch();
    assert.equal(v.watching, false);
    assert.equal(v.why, 'not-pro');
    assert.equal(v.pro.via, 'none');

    const uid = t.ctx.store.listUsers()[0];
    const b = t.ctx.billing.load(uid);
    b.passes[slug] = { at: new Date(clock.t - 5 * DAY).toISOString(), claudeUsd: 50, spentBefore: 0, paid: [] };
    t.ctx.billing.save(uid, b);
    v = await watch();
    assert.equal(v.watching, true);
    assert.equal(v.pro.via, 'pass');
    assert.equal(v.pro.until.slice(0, 10), '2026-12-23');
    await w.runDue();
    assert.equal((await watch()).status, 'up');

    clock.t += 26 * DAY;
    v = await watch();
    assert.equal(v.watching, false);
    assert.equal(v.pro.via, 'ended');
  } finally {
    await t.stop();
  }
});

test('the domain whose expiry is watched', () => {
  assert.equal(registrableDomain('invoicely.app'), 'invoicely.app');
  assert.equal(registrableDomain('www.invoicely.app'), 'invoicely.app');
  assert.equal(registrableDomain('app.shop.co.uk'), 'shop.co.uk');
  assert.equal(registrableDomain('invoicely.vercel.app'), null, "the platform's domain, not the app's");
  assert.equal(registrableDomain('my-app.onrender.com'), null);
  assert.equal(registrableDomain('203.0.113.9'), null);
});
