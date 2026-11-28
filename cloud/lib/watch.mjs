// Watching launched apps: what Pro pays for (roadmap Phase 2). Once an app
// has a live address, Liftoff keeps checking it without anyone pressing a
// button:
//
//   - uptime: the live site (or its health path) every few minutes
//   - every check again once a day: verify, Pulse, and new code from GitHub
//     (so a key pushed in a new commit is caught), plus the HTTPS
//     certificate and the domain's expiry date
//
// When something breaks Liftoff opens an incident, and closes it when the
// problem goes away; lib/alerts.mjs tells the owner about both. None of this
// uses the assistant, so it costs next to nothing to run.
//
// The schedule runs inside the web server. Render runs one instance of it
// (a service with a disk can't scale out) and stops the old one before the
// new one starts, so no check runs twice. Move to a database and a separate
// worker only when the web app needs more than one instance.
//
// Each app's record lives beside its state, in watch.json, so a check
// doesn't count as the app changing.
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import { checklistFor } from '../../lib/catalog.mjs';
import { readJson, writeJson } from './store.mjs';
import { guardedLookup } from './safe-fetch.mjs';
import { HttpError } from './http.mjs';
import { pulseApp, verifyApp } from './tools.mjs';
import { githubToken, rescan } from './importer.mjs';
import { LIVE } from './runs.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DOWN_AFTER = 2; // failed checks in a row before the site counts as down
const CERT_WARN_DAYS = 14;
const DOMAIN_WARN_DAYS = 30;
const KEEP_INCIDENTS = 50;
const KEEP_DAYS = 90;
const BARS = 48; // the last 24 hours in half-hour bars
const UPTIME_AT_ONCE = 8;
const DAILY_AT_ONCE = 2;
// Hosts whose domain belongs to the platform, not the app: no expiry to watch.
const PLATFORM_HOSTS = /\.(vercel\.app|pages\.dev|workers\.dev|netlify\.app|onrender\.com|fly\.dev|herokuapp\.com|github\.io|web\.app|firebaseapp\.com|railway\.app|up\.railway\.app)$/;
// Second-level suffixes where the registered name is three labels (myapp.co.uk).
const THREE_LABEL = /\.(co|com|net|org|gov|ac|edu|ltd|plc|me)\.[a-z]{2}$/;

const day = (t) => new Date(t).toISOString().slice(0, 10);
const pct = (up, total) => (total ? Math.round((1000 * up) / total) / 10 : null);
const clip = (s, n = 300) => String(s ?? '').slice(0, n);

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

export function registrableDomain(host) {
  if (!host || net.isIP(host) || PLATFORM_HOSTS.test(host) || !host.includes('.')) return null;
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  return labels.slice(-(THREE_LABEL.test(host) ? 3 : 2)).join('.');
}

// Why a browser wouldn't trust a certificate, in words.
const CERT_PROBLEMS = {
  CERT_HAS_EXPIRED: 'it has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'it is self-signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'it is signed by an untrusted authority',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its chain is incomplete',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'its chain is incomplete',
  ERR_TLS_CERT_ALTNAME_INVALID: 'it was issued for a different name',
  CERT_NOT_YET_VALID: 'it is not valid yet',
};

// The certificate the site serves: when it runs out, and whether a browser trusts it.
export function readCertificate(host, { allowPrivate = false, timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, lookup: allowPrivate ? undefined : guardedLookup, timeout });
    sock.once('secureConnect', () => {
      const c = sock.getPeerCertificate();
      const out = { validTo: c?.valid_to ? new Date(c.valid_to).toISOString() : null, issuer: c?.issuer?.O || c?.issuer?.CN || null, trusted: sock.authorized, problem: sock.authorized ? null : CERT_PROBLEMS[String(sock.authorizationError)] || String(sock.authorizationError || 'not trusted') };
      sock.end();
      resolve(out);
    });
    sock.once('timeout', () => sock.destroy(new Error('timed out')));
    sock.once('error', reject);
  });
}

// When the domain's registration runs out, from RDAP (the registries' own
// public records). null when the registry doesn't say.
export async function readDomainExpiry(domain, fetch) {
  const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { accept: 'application/rdap+json, application/json' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`the registry answered ${res.status}`);
  const body = await res.json();
  const ev = (body.events || []).find((e) => e.eventAction === 'expiration');
  const t = Date.parse(ev?.eventDate || '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export class Watcher {
  // probes: stand-ins for the certificate and domain lookups in tests.
  constructor(ctx, { now = () => Date.now(), tickMs = MIN, probes = {} } = {}) {
    this.ctx = ctx;
    this.cfg = ctx.config.watch || { on: false };
    this.now = now;
    this.tickMs = tickMs;
    this.probes = {
      cert: (host) => readCertificate(host, { allowPrivate: ctx.config.allowPrivateFetch }),
      domain: (domain) => readDomainExpiry(domain, ctx.safeFetch),
      ...probes,
    };
    this.listeners = [];
    this.daily = new Map(); // `${uid}:${slug}` → promise of its daily check
    this.ticking = null;
    this.timer = null;
    this.prs = null; // the pull request pass that's out, if any
  }

  get uptimeMs() {
    return this.cfg.uptimeMinutes * MIN;
  }

  get dailyMs() {
    return this.cfg.dailyHours * HOUR;
  }

  // Something opened or closed an incident: fn(uid, slug, { type, incident, app }).
  on(fn) {
    this.listeners.push(fn);
  }

  start() {
    if (!this.cfg.on || this.timer) return;
    const tick = () => this.tick().catch((e) => console.error('[liftoff-cloud] watch:', e?.stack || e));
    this.timer = setInterval(tick, this.tickMs);
    this.timer.unref();
    this.first = setTimeout(tick, 10_000);
    this.first.unref();
  }

  async stop() {
    clearInterval(this.timer);
    clearTimeout(this.first);
    this.timer = null;
    // Let checks that are out finish, but don't hold up a shutdown for long:
    // every write is atomic, and an unfinished daily check runs again next time.
    const wait = new Promise((r) => setTimeout(r, 5000).unref());
    await Promise.race([Promise.allSettled([this.ticking, ...this.daily.values(), this.prs, this.ctx.prs?.idle()]), wait]);
  }

  // ---------- records ----------

  file(uid, slug) {
    return path.join(this.ctx.store.appDir(uid, slug), 'watch.json');
  }

  load(uid, slug) {
    const w = readJson(this.file(uid, slug), {}) || {};
    return { paused: !!w.paused, uptime: w.uptime || null, samples: w.samples || [], days: w.days || {}, daily: w.daily || null, incidents: w.incidents || [], since: w.since || null };
  }

  // Read, change and write in one go (no await in between), and never for an
  // app that was removed while a check was out.
  update(uid, slug, fn) {
    if (!fs.existsSync(path.join(this.ctx.store.appDir(uid, slug), 'state.json'))) return null;
    const w = this.load(uid, slug);
    const events = fn(w) || [];
    writeJson(this.file(uid, slug), w);
    // What opened and closed shows in the app's activity too.
    const said = events.filter((ev) => !ev.quiet);
    if (said.length) {
      this.ctx.store.updateApp(uid, slug, (s) => {
        for (const ev of said) s.log.push({ at: ev.type === 'opened' ? ev.incident.openedAt : ev.incident.closedAt, msg: ev.type === 'opened' ? `${ev.incident.title}: ${ev.incident.detail}` : `Fixed: ${ev.incident.title.replace(/: stopped passing$/, '')}` });
      });
    }
    for (const ev of events) this.emit(uid, slug, ev);
    return w;
  }

  emit(uid, slug, ev) {
    for (const fn of this.listeners) {
      try {
        const r = fn(uid, slug, ev);
        if (r?.catch) r.catch((e) => console.error('[liftoff-cloud] watch listener:', e?.message || e));
      } catch (e) {
        console.error('[liftoff-cloud] watch listener:', e?.message || e);
      }
    }
  }

  // Open an incident unless one with this key is open. Returns the events.
  open(w, key, kind, title, detail, at) {
    const cur = w.incidents.find((i) => i.key === key && !i.closedAt);
    if (cur) {
      cur.detail = clip(detail);
      return [];
    }
    const incident = { id: `i_${crypto.randomBytes(5).toString('hex')}`, key, kind, title: clip(title, 160), detail: clip(detail), openedAt: new Date(at).toISOString(), closedAt: null };
    w.incidents = [incident, ...w.incidents].slice(0, KEEP_INCIDENTS);
    return [{ type: 'opened', incident }];
  }

  close(w, key, at, detail = null) {
    const cur = w.incidents.find((i) => i.key === key && !i.closedAt);
    if (!cur) return [];
    cur.closedAt = new Date(at).toISOString();
    if (detail) cur.closeDetail = clip(detail);
    return [{ type: 'closed', incident: cur }];
  }

  // ---------- who is watched ----------

  // Whether Liftoff watches this app now, and why not when it doesn't.
  status(uid, state, w = this.load(uid, state.slug)) {
    const pro = this.ctx.billing.pro(uid, state.slug, this.now());
    let why = null;
    if (!this.cfg.on) why = 'off';
    else if (!state.liveUrl) why = 'no-live-url';
    else if (!pro.active) why = 'not-pro';
    else if (w.paused) why = 'paused';
    return { watching: !why, why, pro };
  }

  // The address the uptime check asks for: the health path when one is set.
  target(state) {
    if (!state.liveUrl) return null;
    try {
      return new URL(state.config?.['health.path'] || '/', state.liveUrl).href;
    } catch {
      return state.liveUrl;
    }
  }

  // Every app that's watched, with what's due for it.
  due() {
    const { store } = this.ctx;
    const t = this.now();
    const out = { uptime: [], daily: [] };
    for (const uid of store.listUsers()) {
      for (const slug of store.listApps(uid)) {
        const state = store.loadApp(uid, slug);
        if (!state) continue;
        const w = this.load(uid, slug);
        if (!this.status(uid, state, w).watching) continue;
        // A little early is fine: ticks are a minute apart.
        if (!w.uptime || t - Date.parse(w.uptime.at) >= this.uptimeMs - 5000) out.uptime.push({ uid, slug });
        if ((!w.daily || t - Date.parse(w.daily.at) >= this.dailyMs - 5000) && !this.daily.has(`${uid}:${slug}`)) out.daily.push({ uid, slug });
      }
    }
    return out;
  }

  // One pass of the schedule. Uptime checks finish before it returns; daily
  // checks carry on in the background (runDue waits for them too).
  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        const { uptime, daily } = this.due();
        for (const app of daily) this.startDaily(app.uid, app.slug);
        // Pull requests (lib/prs.mjs) carry on in the background like daily checks.
        if (this.cfg.on && this.ctx.prs && !this.prs) this.prs = this.ctx.prs.runDue().catch((e) => console.error('[liftoff-cloud] pull requests:', e?.stack || e)).finally(() => { this.prs = null; });
        await pool(uptime, UPTIME_AT_ONCE, ({ uid, slug }) => this.checkUptime(uid, slug).catch((e) => console.error(`[liftoff-cloud] uptime ${slug}:`, e?.message || e)));
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  async runDue() {
    await this.tick();
    await Promise.allSettled([...this.daily.values(), this.prs]);
  }

  startDaily(uid, slug) {
    const key = `${uid}:${slug}`;
    if (this.daily.has(key)) return this.daily.get(key);
    // At most a couple at once; the rest wait their turn.
    const ahead = [...this.daily.values()];
    const wait = ahead.length >= DAILY_AT_ONCE ? Promise.race(ahead) : Promise.resolve();
    const job = wait
      .then(() => this.checkDaily(uid, slug))
      .catch((e) => console.error(`[liftoff-cloud] daily check ${slug}:`, e?.stack || e))
      .finally(() => this.daily.delete(key));
    this.daily.set(key, job);
    return job;
  }

  // ---------- uptime ----------

  async checkUptime(uid, slug) {
    const state = this.ctx.store.loadApp(uid, slug);
    if (!state) return null;
    const url = this.target(state);
    const t0 = this.now();
    let ok = false;
    let status = null;
    let detail;
    const started = Date.now();
    try {
      const res = await this.ctx.safeFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      status = res.status;
      ok = res.status < 400;
      detail = `answered ${res.status}`;
    } catch (e) {
      detail = `didn't answer (${clip(e.cause?.code || e.code || e.message, 120)})`;
    }
    const ms = ok ? Date.now() - started : null;
    const host = new URL(url).host;
    return this.update(uid, slug, (w) => {
      const before = w.uptime;
      const streak = ok ? 0 : (before?.ok === false ? before.streak || 1 : 0) + 1;
      w.uptime = { at: new Date(t0).toISOString(), ok, status, ms, detail, url, streak };
      if (!before || before.ok !== ok) w.since = w.uptime.at;
      const tSec = Math.floor(t0 / 1000);
      w.samples = [...w.samples.filter((s) => s[0] > tSec - 86_400), [tSec, ok ? 1 : 0, ms]];
      const d = day(t0);
      const cur = w.days[d] || [0, 0];
      w.days[d] = [cur[0] + (ok ? 1 : 0), cur[1] + 1];
      const keep = Object.keys(w.days).sort().slice(-KEEP_DAYS);
      w.days = Object.fromEntries(keep.map((k) => [k, w.days[k]]));
      if (ok) {
        const open = w.incidents.find((i) => i.key === 'down' && !i.closedAt);
        return this.close(w, 'down', t0, open ? `${host} answered again` : null);
      }
      if (streak >= DOWN_AFTER) {
        // The incident starts at the first failed check, not the one that confirmed it.
        let first = t0;
        for (let i = w.samples.length - 1; i >= 0 && w.samples[i][1] === 0; i--) first = w.samples[i][0] * 1000;
        return this.open(w, 'down', 'down', `${host} is down`, `${url} ${detail}`, first);
      }
      return [];
    });
  }

  // ---------- every check again, once a day ----------

  async checkDaily(uid, slug) {
    const { ctx } = this;
    let state = ctx.store.loadApp(uid, slug);
    if (!state || !this.status(uid, state).watching) return null;
    const t0 = this.now();
    const notes = [];

    // New code on GitHub: fetch it, so verify and the key scan see what's
    // shipping now. Not while a run is working on the app.
    if (state.source?.type === 'github') {
      try {
        const busy = ctx.runs.list(uid, slug).some((r) => LIVE.has(r.status) || r.status === 'budget');
        const token = !busy && githubToken(ctx.store, uid);
        if (token) {
          const { owner, repo, ref } = state.source;
          const sha = await ctx.github.latestCommit(token, owner, repo, ref);
          if (sha && sha !== state.source.commit) {
            await rescan(ctx, uid, slug);
            notes.push(`fetched new code (${sha.slice(0, 7)})`);
          }
        }
      } catch (e) {
        notes.push(`couldn't fetch new code: ${clip(e.message, 120)}`);
      }
    }

    // Every check, against the live services.
    const before = ctx.store.loadApp(uid, slug)?.checklist || {};
    let results = [];
    try {
      ({ results } = await verifyApp(ctx, uid, slug));
    } catch (e) {
      notes.push(`verify stopped: ${clip(e.message, 120)}`);
    }
    try {
      await pulseApp(ctx, uid, slug);
    } catch (e) {
      notes.push(`Pulse stopped: ${clip(e.message, 120)}`);
    }
    state = ctx.store.loadApp(uid, slug);
    if (!state?.liveUrl) return null;
    const titles = Object.fromEntries(checklistFor(state.platforms || []).map((c) => [c.id, c.title]));

    // The certificate and the domain.
    let cert = null;
    let domain = null;
    const host = new URL(state.liveUrl).hostname;
    if (state.liveUrl.startsWith('https://')) {
      try {
        const c = await this.probes.cert(host);
        cert = { ...c, days: c.validTo ? Math.floor((Date.parse(c.validTo) - t0) / DAY) : null };
      } catch (e) {
        cert = { error: clip(e.code || e.message, 120) };
      }
    }
    const reg = registrableDomain(host);
    if (reg) {
      try {
        const expires = await this.probes.domain(reg);
        domain = { name: reg, expires, days: expires ? Math.floor((Date.parse(expires) - t0) / DAY) : null };
      } catch (e) {
        domain = { name: reg, error: clip(e.message, 120) };
      }
    }

    return this.update(uid, slug, (w) => {
      const events = [];
      // A check that passed before and fails now broke; one that never passed is
      // still on the launch list, not news. A skip says nothing either way.
      for (const r of results) {
        const key = `check:${r.id}`;
        const was = before[r.id];
        const passedBefore = was?.verify?.ok === true || was?.by === 'verified';
        if (r.ok === true) events.push(...this.close(w, key, t0, 'passes again'));
        else if (r.ok === false && (passedBefore || w.incidents.some((i) => i.key === key && !i.closedAt))) {
          events.push(...this.open(w, key, 'check', `${titles[r.id] || r.id}: stopped passing`, r.detail, t0));
        }
      }
      if (cert && !cert.error) {
        const bad = cert.trusted === false || (cert.days !== null && cert.days <= CERT_WARN_DAYS);
        if (bad) {
          const what = cert.trusted === false ? `browsers won't trust it: ${cert.problem}` : cert.days < 0 ? 'it has expired' : `it expires in ${cert.days} day${cert.days === 1 ? '' : 's'}`;
          events.push(...this.open(w, 'cert', 'cert', `HTTPS certificate for ${host}`, `${what}${cert.validTo ? `, valid until ${cert.validTo.slice(0, 10)}` : ''}`, t0));
        } else events.push(...this.close(w, 'cert', t0, `renewed, valid until ${cert.validTo?.slice(0, 10)}`));
      }
      if (domain?.days !== null && domain?.days !== undefined) {
        if (domain.days <= DOMAIN_WARN_DAYS) events.push(...this.open(w, 'domain', 'domain', `Domain ${domain.name} needs renewing`, domain.days < 0 ? `it expired on ${domain.expires.slice(0, 10)}` : `it expires in ${domain.days} day${domain.days === 1 ? '' : 's'}, on ${domain.expires.slice(0, 10)}`, t0));
        else events.push(...this.close(w, 'domain', t0, `renewed until ${domain.expires.slice(0, 10)}`));
      }
      const count = (ok) => results.filter((r) => r.ok === ok).length;
      w.daily = { at: new Date(t0).toISOString(), passed: count(true), failed: count(false), skipped: count(null), cert, domain, notes };
      return events;
    });
  }

  // ---------- what the person does ----------

  setPaused(uid, slug, paused) {
    return this.update(uid, slug, (w) => {
      w.paused = !!paused;
      // Paused watching has nothing to report, so what's open is closed.
      if (paused) return w.incidents.filter((i) => !i.closedAt).flatMap((i) => this.close(w, i.key, this.now(), 'watching paused')).map((e) => ({ ...e, quiet: true }));
      return [];
    });
  }

  // "Check now": the uptime check, right away.
  async checkNow(uid, slug) {
    const state = this.ctx.store.loadApp(uid, slug);
    if (!state) throw new HttpError(404, 'No such app');
    const s = this.status(uid, state);
    if (!s.watching) throw new HttpError(400, s.why === 'no-live-url' ? 'Add the live address under Deployments first.' : s.why === 'paused' ? 'Watching is paused for this app.' : 'Liftoff isn’t watching this app.');
    return this.checkUptime(uid, slug);
  }

  // ---------- what the Flight Board shows ----------

  view(uid, state) {
    const w = this.load(uid, state.slug);
    const st = this.status(uid, state, w);
    const t = this.now();
    const tSec = Math.floor(t / 1000);
    const recent = w.samples.filter((s) => s[0] > tSec - 86_400);
    const bars = Array.from({ length: BARS }, (_, i) => {
      const from = tSec - 86_400 + i * 1800;
      const inBar = recent.filter((s) => s[0] > from && s[0] <= from + 1800);
      if (!inBar.length) return 'none';
      const up = inBar.filter((s) => s[1]).length;
      return up === inBar.length ? 'up' : up === 0 ? 'down' : 'part';
    });
    const month = Object.entries(w.days).filter(([d]) => Date.parse(d) > t - 30 * DAY);
    const msList = recent.filter((s) => s[2] !== null).map((s) => s[2]).sort((a, b) => a - b);
    const open = w.incidents.filter((i) => !i.closedAt);
    const u = w.uptime;
    return {
      enabled: !!this.cfg.on,
      watching: st.watching,
      why: st.why,
      pro: st.pro,
      paused: w.paused,
      everyMinutes: this.cfg.uptimeMinutes,
      target: this.target(state),
      status: !st.watching ? 'off' : !u ? 'pending' : open.some((i) => i.key === 'down') ? 'down' : u.ok ? 'up' : 'checking',
      since: w.since,
      uptime: u ? {
        at: u.at,
        ok: u.ok,
        detail: u.detail,
        ms: u.ms,
        typicalMs: msList.length ? msList[Math.floor(msList.length / 2)] : null,
        day: pct(recent.filter((s) => s[1]).length, recent.length),
        month: pct(month.reduce((n, [, v]) => n + v[0], 0), month.reduce((n, [, v]) => n + v[1], 0)),
        next: st.watching ? new Date(Date.parse(u.at) + this.uptimeMs).toISOString() : null,
      } : null,
      bars,
      daily: w.daily ? { ...w.daily, next: st.watching ? new Date(Date.parse(w.daily.at) + this.dailyMs).toISOString() : null } : null,
      incidents: { open, recent: w.incidents.filter((i) => i.closedAt).slice(0, 5) },
    };
  }
}
