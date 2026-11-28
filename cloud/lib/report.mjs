// Launch reports: a dated snapshot of what Liftoff proved about an app, on a
// page anyone with the link can open, and the "Launch certified by Liftoff"
// badge for the app's own site, which links back to it.
//
// Certified means every required check ran on Liftoff's server and passed in
// the last 30 days. Items Claude or the owner ticked by hand are listed as
// reported, never as proven, and a skipped check never counts as a pass.
// Other checks that fail are listed (without details) and lower the score,
// but don't block: pay-live, for one, fails on the test key the purchase
// test needs.
import fs from 'node:fs';
import path from 'node:path';
import { checklistFor } from '../../lib/catalog.mjs';
import { sellsWithStripe, VERIFIABLE } from '../../lib/verify.mjs';
import { STEPS } from '../../proof/protocol.mjs';
import { stripeConnected as hasStripe } from './accounts.mjs';
import { DEFAULT_ASSISTANT } from './brand.mjs';
import { HttpError } from './http.mjs';
import { verifyApp } from './tools.mjs';

export const PROOF_MAX_AGE_DAYS = 30;
const DAY = 86_400_000;
const KEEP_REPORTS = 20;
const REPORT_ID = /^rp_[A-Za-z0-9_-]{20}$/;
const SHOT = /^\d{2}-[a-z-]{1,20}\.jpg$/;
const LABEL = Object.fromEntries(STEPS);

// What must be proven for a certificate: the site is up on HTTPS with its
// legal pages, ships no secret keys, and (when it sells through Stripe) the
// webhook and the whole purchase flow work. Supabase apps also need RLS on.
export function requiredChecks(state, { stripeConnected = false } = {}) {
  const ids = ['host-deploy', 'host-https', 'land-legal', 'sec-keys'];
  if (sellsWithStripe(state, { stripeConnected })) ids.push('pay-webhook', 'pay-e2e');
  if (state.integrations?.supabase) ids.push('sec-rls');
  return ids;
}

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

function statusOf(item, now) {
  if (item.verify?.ok === false) return 'failed';
  if (item.done && item.by === 'verified') return item.at && now - Date.parse(item.at) <= PROOF_MAX_AGE_DAYS * DAY ? 'proven' : 'stale';
  if (item.done) return 'reported';
  return VERIFIABLE.includes(item.id) ? 'unproven' : 'open';
}

// The report for an app as it stands. Pure: the caller runs verify first.
export function assess(state, { now = Date.now(), stripeConnected = false } = {}) {
  const required = new Set(requiredChecks(state, { stripeConnected }));
  const checks = checklistFor(state.platforms || []).map((c) => {
    const cur = state.checklist?.[c.id] || { done: false };
    const status = statusOf({ id: c.id, ...cur }, now);
    const ticked = status === 'proven' || status === 'stale' || status === 'reported';
    return {
      id: c.id,
      title: c.title,
      category: c.category,
      required: required.has(c.id),
      status,
      by: cur.done ? cur.by || null : null,
      at: ticked ? cur.at || null : cur.verify?.at || null,
      // What the check found. A later skip keeps an earlier proof but says
      // nothing about it, so a proven item only shows a passing run's words.
      detail: (ticked ? cur.verify?.ok === true : true) ? cur.verify?.detail || null : null,
    };
  });
  const count = (s) => checks.filter((c) => c.status === s).length;
  const counts = { proven: count('proven'), reported: count('reported'), failed: count('failed'), unproven: count('unproven') + count('stale'), open: count('open'), total: checks.length };
  // Proven counts fully, reported half, everything else nothing.
  const score = checks.length ? Math.round((100 * (counts.proven + counts.reported / 2)) / checks.length) : 0;

  const missing = [];
  if (!(state.platforms || []).includes('web')) missing.push('Liftoff certifies web apps for now. App Store and Google Play checks come next.');
  for (const c of checks.filter((x) => x.required && x.status !== 'proven')) {
    if (c.status === 'failed') missing.push(`${c.title}: didn't pass`);
    else if (c.status === 'stale') missing.push(`${c.title}: last proven ${day(c.at)}, more than ${PROOF_MAX_AGE_DAYS} days ago`);
    else if (c.status === 'reported') missing.push(`${c.title}: marked done by hand, not proven by Liftoff`);
    else missing.push(`${c.title}: not proven by Liftoff yet`);
  }
  return { certified: missing.length === 0, missing, score, counts, checks };
}

// ---------- storing reports ----------

const reportsDir = (ctx, uid, slug) => path.join(ctx.store.appDir(uid, slug), 'reports');

// Run every check again, snapshot the result and give it a shareable link.
export async function createReport(ctx, uid, slug) {
  const { state } = await verifyApp(ctx, uid, slug);
  const now = Date.now();
  const a = assess(state, { now, stripeConnected: hasStripe(ctx.store, uid) });
  const id = ctx.store.newPublicId('rp');
  const dir = path.join(reportsDir(ctx, uid, slug), id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Liftoff's latest purchase test is the evidence for pay-e2e, screenshots
  // included, when it passed inside the proof window.
  let purchase = null;
  const proof = state.proof?.latest;
  const payE2e = a.checks.find((c) => c.id === 'pay-e2e');
  if (proof?.status === 'passed' && payE2e?.status === 'proven' && now - Date.parse(proof.endedAt) <= PROOF_MAX_AGE_DAYS * DAY) {
    const from = path.join(ctx.store.appDir(uid, slug), 'proof', proof.id);
    purchase = {
      at: proof.endedAt,
      checkout: proof.checkout || null,
      steps: (proof.steps || []).map((s) => {
        let shot = null;
        if (typeof s.shot === 'string' && SHOT.test(s.shot)) {
          try {
            fs.copyFileSync(path.join(from, s.shot), path.join(dir, s.shot));
            shot = s.shot;
          } catch {}
        }
        return { label: LABEL[s.name] || s.name, ok: !!s.ok, detail: s.detail, shot };
      }),
    };
  }

  const report = {
    id,
    createdAt: new Date(now).toISOString(),
    app: { name: state.name, framework: state.framework, platforms: state.platforms, liveUrl: state.liveUrl || null },
    certified: a.certified,
    missing: a.missing,
    score: a.score,
    counts: a.counts,
    // Only what a passing check found is kept: a failure can point at a weakness.
    checks: a.checks.map((c) => ({ ...c, detail: c.status === 'proven' ? c.detail : null })),
    purchase,
  };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1), { mode: 0o600 });
  ctx.store.publish(id, { uid, slug });

  let dropped = [];
  ctx.store.updateApp(uid, slug, (s) => {
    s.report ||= { badgeId: null, history: [] };
    if (!s.report.badgeId) {
      s.report.badgeId = ctx.store.newPublicId('bd');
      ctx.store.publish(s.report.badgeId, { uid, slug });
    }
    s.report.history = [{ id, at: report.createdAt, certified: report.certified, score: report.score }, ...(s.report.history || [])];
    dropped = s.report.history.slice(KEEP_REPORTS);
    s.report.history = s.report.history.slice(0, KEEP_REPORTS);
    s.log.push({ at: report.createdAt, msg: `Launch report: ${report.certified ? 'certified' : 'not certified yet'}, score ${report.score}` });
  });
  for (const old of dropped) removeFiles(ctx, uid, slug, old.id);
  return report;
}

function removeFiles(ctx, uid, slug, id) {
  ctx.store.unpublish(id);
  if (REPORT_ID.test(id)) fs.rmSync(path.join(reportsDir(ctx, uid, slug), id), { recursive: true, force: true });
}

export function loadReport(ctx, uid, slug, id) {
  if (!REPORT_ID.test(id || '')) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(reportsDir(ctx, uid, slug), id, 'report.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function reportShot(ctx, uid, slug, id, file) {
  if (!REPORT_ID.test(id || '') || !SHOT.test(file || '')) return null;
  try {
    return fs.readFileSync(path.join(reportsDir(ctx, uid, slug), id, file));
  } catch {
    return null;
  }
}

// Take a report down: its link stops working.
export function deleteReport(ctx, uid, slug, id) {
  const state = ctx.store.loadApp(uid, slug);
  if (!state?.report?.history?.some((r) => r.id === id)) throw new HttpError(404, 'No such report');
  removeFiles(ctx, uid, slug, id);
  return ctx.store.updateApp(uid, slug, (s) => {
    s.report.history = s.report.history.filter((r) => r.id !== id);
  });
}

// The badge shows the newest report: certified with its date, or a plain
// "launch report" that claims nothing.
export function latestReport(state) {
  return state.report?.history?.[0] || null;
}

// Badge clicks are kept beside the reports, not in the app's state, so a
// click doesn't count as the app changing.
const clicksFile = (ctx, uid, slug) => path.join(reportsDir(ctx, uid, slug), 'clicks.json');

export function badgeClicks(ctx, uid, slug) {
  try {
    const n = JSON.parse(fs.readFileSync(clicksFile(ctx, uid, slug), 'utf8')).clicks;
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function countClick(ctx, uid, slug) {
  const file = clicksFile(ctx, uid, slug);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ clicks: badgeClicks(ctx, uid, slug) + 1, at: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// What the Flight Board shows.
export function reportView(ctx, uid, state) {
  const a = assess(state, { stripeConnected: hasStripe(ctx.store, uid) });
  const base = ctx.config.publicUrl;
  const badgeId = state.report?.badgeId || null;
  const history = (state.report?.history || []).map((r) => ({ ...r, url: `${base}/r/${r.id}` }));
  return {
    now: { certified: a.certified, missing: a.missing, score: a.score, counts: a.counts },
    latest: history[0] || null,
    history,
    badge: badgeId ? { url: `${base}/b/${badgeId}`, image: `${base}/b/${badgeId}.svg`, clicks: badgeClicks(ctx, uid, state.slug) } : null,
  };
}

// ---------- the badge ----------

const textWidth = (s) => Math.round([...s].reduce((w, ch) => w + (/[il.,:'|!]/.test(ch) ? 3.2 : /[mwMW]/.test(ch) ? 9.5 : /[A-Z0-9]/.test(ch) ? 7.4 : 6.3), 0));

export function badgeSvg(latest) {
  const left = 'Liftoff';
  const right = latest?.certified ? `launch certified · ${new Date(latest.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}` : 'launch report';
  const lw = textWidth(left) + 16;
  const rw = textWidth(right) + 16;
  const w = lw + rw;
  const color = latest?.certified ? '#0c9466' : '#6b7280';
  const label = latest?.certified ? `Liftoff: ${right}` : 'Liftoff launch report';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}"><title>${label}</title>`
    + `<clipPath id="r"><rect width="${w}" height="20" rx="4" fill="#fff"/></clipPath><g clip-path="url(#r)">`
    + `<rect width="${lw}" height="20" fill="#1f2328"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/></g>`
    + `<g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">`
    + `<text x="${lw / 2}" y="14">${left}</text><text x="${lw + rw / 2}" y="14">${right}</text></g></svg>`;
}

// ---------- the public page ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const longDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
// Who ticked an item by hand. 'claude' is the assistant, shown by its Liftoff name.
const BY = { you: 'the owner', auto: 'detected in the code', verified: 'Liftoff' };
const TICK = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 7 10 16l-4-4"/></svg>';
const CROSS = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const DOT = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/></svg>';

function section(title, intro, rows, { folded = false } = {}) {
  if (!rows.length) return '';
  const head = `${esc(title)} <span class="n">${rows.length}</span>`;
  const list = `${intro ? `<p class="intro">${esc(intro)}</p>` : ''}<ul class="checks">${rows.join('')}</ul>`;
  return folded ? `<section><details><summary><h2>${head}</h2></summary>${list}</details></section>` : `<section><h2>${head}</h2>${list}</section>`;
}

// Failed checks show no details: a public page shouldn't point at a weakness.
export function renderReport(report, { home = '/', assistant = DEFAULT_ASSISTANT } = {}) {
  const r = report;
  const by = (who) => (who === 'claude' ? assistant : BY[who]);
  const { checks } = r;
  const row = (c, icon, cls, note) => `<li class="${cls}">${icon}<div><div class="t">${esc(c.title)}${c.required ? ' <span class="req">Required</span>' : ''}</div>${note ? `<div class="d">${esc(note)}</div>` : ''}</div></li>`;
  const proven = checks.filter((c) => c.status === 'proven').sort((a, b) => b.required - a.required).map((c) => row(c, TICK, 'ok', [c.detail, c.at && `checked ${day(c.at)}`].filter(Boolean).join(' · ')));
  const failed = checks.filter((c) => c.status === 'failed').map((c) => row(c, CROSS, 'bad', `didn't pass on ${day(c.at) || day(r.createdAt)}`));
  const unproven = checks.filter((c) => c.status === 'unproven' || c.status === 'stale').sort((a, b) => b.required - a.required).map((c) => row(c, DOT, 'none', c.status === 'stale' ? `last proven ${day(c.at)}` : c.required ? 'not proven yet' : null));
  const reported = checks.filter((c) => c.status === 'reported').map((c) => row(c, DOT, 'rep', `marked done by ${by(c.by) || 'hand'}${c.at ? ` on ${day(c.at)}` : ''}`));
  const open = checks.filter((c) => c.status === 'open').map((c) => row(c, DOT, 'none', null));

  const purchase = r.purchase ? `<section><h2>Purchase test</h2><p class="intro">Liftoff's own browser bought, cancelled and re-checked a subscription on ${esc(longDate(r.purchase.at))}${r.purchase.checkout ? ` (Stripe test checkout ${esc(r.purchase.checkout)})` : ''}. Stripe's records confirmed it.</p><ol class="steps">${r.purchase.steps.map((s) => `<li class="${s.ok ? 'ok' : 'bad'}">${s.ok ? TICK : CROSS}<div><div class="t">${esc(s.label)}</div><div class="d">${esc(s.detail)}</div></div>${s.shot ? `<a class="shot" href="${esc(`/r/${r.id}/${s.shot}`)}"><img src="${esc(`/r/${r.id}/${s.shot}`)}" alt="${esc(`Screenshot: ${s.label}`)}" loading="lazy"></a>` : ''}</li>`).join('')}</ol></section>` : '';

  const live = r.app.liveUrl && /^https?:\/\//.test(r.app.liveUrl) ? `<a href="${esc(r.app.liveUrl)}" rel="nofollow noopener">${esc(r.app.liveUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>` : '';
  const verdict = r.certified
    ? `<div class="verdict ok">${TICK}<div><div class="v">Launch certified</div><div class="d">Every required check ran on Liftoff's server and passed.</div></div></div>`
    : `<div class="verdict">${DOT}<div><div class="v">Not certified yet</div><div class="d">${esc(r.missing.length)} thing${r.missing.length === 1 ? '' : 's'} still to prove before Liftoff can certify this launch.</div></div></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(r.app.name)}: launch report · Liftoff</title>
<link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/report.css"></head><body><main>
<header class="top"><a class="brand" href="${esc(home)}">Liftoff</a><span>Launch report</span></header>
<h1>${esc(r.app.name)}</h1><p class="meta">${[esc(r.app.framework), esc((r.app.platforms || []).join(', ')), live].filter(Boolean).join(' · ')}</p>
${verdict}
<div class="facts"><div><div class="k">Checked</div><div class="v">${esc(longDate(r.createdAt))}</div></div><div><div class="k">Launch score</div><div class="v">${esc(r.score)}<span>/100</span></div></div><div><div class="k">Proven by Liftoff</div><div class="v">${esc(r.counts.proven)}<span> of ${esc(r.counts.total)}</span></div></div></div>
${section('Proven by Liftoff', "Each of these was checked from Liftoff's own server against the live services, not ticked by hand.", proven)}
${purchase}
${section("Didn't pass", null, failed)}
${section('Not proven yet', null, unproven)}
${section('Reported, not proven', `Done according to the team or ${assistant}. Liftoff counts these as half in the score and never certifies on them.`, reported)}
${section('Still open', 'Steps no one has marked done yet.', open, { folded: true })}
<footer><p>Liftoff certifies a launch only when every required check (the site is live on HTTPS with privacy and terms pages, no secret keys ship in the code, and for apps that sell through Stripe, a webhook and a full test purchase) ran on its server and passed in the ${PROOF_MAX_AGE_DAYS} days before the report. Other checks are shown as they stood and count toward the score. This page is a snapshot from ${esc(longDate(r.createdAt))}.</p>
<p><a class="cta" href="${esc(home)}">Launch your app with Liftoff</a></p></footer>
</main></body></html>`;
}

// A report link that no longer works.
export function renderMissing({ home = '/' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Report not found · Liftoff</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/report.css"></head>
<body><main class="gone"><header class="top"><a class="brand" href="${esc(home)}">Liftoff</a><span>Launch report</span></header>
<h1>This report isn't here</h1><p class="meta">Its owner took it down, or the link is wrong.</p></main></body></html>`;
}
