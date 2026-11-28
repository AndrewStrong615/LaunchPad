// The "Launch certified" badge stays true: it follows the newest report for
// 30 days, and Liftoff's daily checks for as long as the app is watched
// (Pro, or the days that come with the Launch Pass).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { zipDirectory } from '../lib/archive.mjs';
import { badgeSvg } from '../lib/report.mjs';
import { FIXTURES, signIn, startTest } from './helpers.mjs';

const MIN = 60_000;
const DAY = 86_400_000;

// The live site as verify and the uptime checks see it.
function fakeSite() {
  const site = { status: 200, legal: 200 };
  site.fetch = async (url) => {
    const u = new URL(url);
    if (u.host !== 'invoicely.app' && u.host !== 'www.invoicely.app') return new Response('nope', { status: 404 });
    if (u.protocol === 'http:') return new Response(null, { status: 301, headers: { location: `https://invoicely.app${u.pathname}` } });
    if (u.host === 'www.invoicely.app') return new Response(null, { status: 301, headers: { location: 'https://invoicely.app/' } });
    if (u.pathname === '/privacy' || u.pathname === '/terms') return new Response('legal', { status: site.legal });
    return new Response('<title>Invoicely</title><h1>Invoices</h1>', { status: site.status });
  };
  return site;
}

async function setup(env = {}) {
  const site = fakeSite();
  const clock = { t: Date.now() };
  const probes = {
    cert: async () => ({ validTo: new Date(clock.t + 60 * DAY).toISOString(), issuer: "Let's Encrypt", trusted: true, problem: null }),
    domain: async () => new Date(clock.t + 200 * DAY).toISOString(),
  };
  const t = await startTest({ env, safeFetch: site.fetch, watch: { now: () => clock.t, probes } });
  const me = await signIn(t.base);
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'), { prefix: 'next-saas/' });
  const slug = (await me.call('POST', '/api/import/zip?name=invoicely.zip', zip, { 'content-type': 'application/zip' })).body.slug;
  const uid = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
  t.ctx.store.updateApp(uid, slug, (s) => { s.liveUrl = 'https://invoicely.app'; });
  const report = async () => {
    const r = await me.post(`/api/apps/${slug}/report`);
    assert.equal(r.status, 200, r.text);
    return r.body.cloud.report;
  };
  const svg = async (r) => (await fetch(`${t.base}${new URL(r.badge.image).pathname}`)).text();
  const page = async (url) => (await fetch(`${t.base}${new URL(url).pathname}`)).text();
  const says = async () => (await me.get(`/api/apps/${slug}`)).body.cloud.report.badge.says;
  // Move the newest report back in time.
  const age = (days) => t.ctx.store.updateApp(uid, slug, (s) => { s.report.history[0].at = new Date(Date.now() - days * DAY).toISOString(); });
  return { t, me, site, clock, slug, uid, report, svg, page, says, age, w: t.ctx.watch };
}

test("without watching, a certified badge lasts 30 days after its report, then claims nothing", async () => {
  const { t, report, svg, page, says, age } = await setup({ LIFTOFF_WATCH: '0' });
  try {
    const r = await report();
    assert.equal(r.latest.certified, true, JSON.stringify(r.now.missing));
    let b = await says();
    assert.equal(b.certified, true);
    assert.equal(b.live, false);
    assert.equal(b.until, new Date(Date.parse(r.latest.at) + 30 * DAY).toISOString());
    assert.match(await svg(r), /launch certified · \d{1,2} \w{3} 2026/);
    assert.doesNotMatch(await page(r.latest.url), /class="since/, 'nothing to add while the report is fresh');

    age(31);
    b = await says();
    assert.equal(b.certified, false);
    assert.ok(b.until, 'it says when the certificate ended');
    assert.match(await svg(r), /launch report/);
    assert.doesNotMatch(await svg(r), /certified/);
    const html = await page(r.latest.url);
    assert.match(html, /Launch certified/, 'the report itself is still the snapshot it was');
    assert.match(html, /This certificate ended on/);
  } finally {
    await t.stop();
  }
});

test('while Liftoff watches the app, the badge follows the daily checks, not the report', async () => {
  const { t, site, clock, slug, uid, report, svg, page, says, age, w } = await setup();
  try {
    const r = await report();
    assert.equal(r.latest.certified, true, JSON.stringify(r.now.missing));
    assert.equal((await says()).live, false, 'until the first uptime check, the report stands');

    await w.runDue(); // uptime, and every check again
    let b = await says();
    assert.equal(b.live, true);
    assert.equal(b.certified, true);
    assert.match(await svg(r), /launch certified · watched/);
    assert.match(await svg(r), /checked again/);
    let html = await page(r.latest.url);
    assert.match(html, /Liftoff is watching [^:]+: every required check passed again on/);
    assert.match(html, /up 100% of the last 30 days/);

    // An old report doesn't matter while every check keeps passing.
    age(45);
    assert.equal((await says()).certified, true);

    // The site goes down: the badge stops claiming, and comes back with it.
    site.status = 503;
    for (let i = 0; i < 2; i++) {
      clock.t += 5 * MIN;
      await w.checkUptime(uid, slug);
    }
    b = await says();
    assert.equal(b.live, true);
    assert.equal(b.certified, false);
    assert.match(await svg(r), /launch report/);
    html = await page(r.latest.url);
    assert.match(html, /Not every required check passes right now/);
    assert.doesNotMatch(html, /503/, "the page doesn't say what broke");
    site.status = 200;
    clock.t += 5 * MIN;
    await w.checkUptime(uid, slug);
    assert.equal((await says()).certified, true);

    // A required check stops passing on the daily run.
    site.legal = 404;
    clock.t += DAY + MIN;
    await w.runDue();
    assert.equal((await says()).certified, false);
    assert.match(await svg(r), /launch report/);
    site.legal = 200;
    clock.t += DAY + MIN;
    await w.runDue();
    assert.equal((await says()).certified, true);

    // An earlier report points to the newest one instead.
    const newer = await report();
    assert.match(await page(r.latest.url), /This is an earlier report\. <a href="\/r\/rp_/);
    assert.match(await page(newer.latest.url), /Liftoff is watching/);
  } finally {
    await t.stop();
  }
});

test('Pro keeps the badge live after the Launch Pass days end', async () => {
  const { t, slug, uid, report, svg, says, age, w } = await setup({ LIFTOFF_STRIPE_SECRET_KEY: 'sk_test_demo' });
  try {
    const b = t.ctx.billing;
    const edit = (fn) => { const x = b.load(uid); fn(x); b.save(uid, x); };
    edit((x) => { x.passes[slug] = { at: new Date().toISOString(), claudeUsd: 50, spentBefore: 0, paid: [] }; });
    const r = await report();
    await w.runDue();
    assert.equal((await says()).live, true, 'watched in the days that come with the pass');

    // The pass's days and the report's 30 days are over: nothing to claim.
    edit((x) => { x.passes[slug].at = new Date(Date.now() - 40 * DAY).toISOString(); });
    age(40);
    let now = await says();
    assert.deepEqual([now.live, now.certified], [false, false]);
    assert.match(await svg(r), /launch report/);

    // On Pro, Liftoff watches it again and the badge is live.
    edit((x) => { x.pro[slug] = { sub: 'sub_test_badge0001', status: 'active', periodEnd: new Date(Date.now() + 20 * DAY).toISOString(), cancelAt: null, trialEnd: null }; });
    await w.runDue();
    now = await says();
    assert.deepEqual([now.live, now.certified], [true, true]);
    assert.match(await svg(r), /launch certified · watched/);
  } finally {
    await t.stop();
  }
});

test('the badge picture', () => {
  assert.match(badgeSvg({ certified: true, live: true, at: '2026-11-28T10:00:00Z' }), /launch certified · watched<\/text>/);
  assert.match(badgeSvg({ certified: true, live: true, at: '2026-11-28T10:00:00Z' }), /<title>Liftoff: launch certified, watched and checked again 28 Nov 2026<\/title>/);
  assert.match(badgeSvg({ certified: true, live: false, at: '2026-11-28T10:00:00Z' }), /launch certified · 28 Nov 2026/);
  assert.match(badgeSvg({ certified: false, live: true, at: '2026-11-28T10:00:00Z' }), /launch report/);
});
