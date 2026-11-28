// Pull request checks (roadmap Phase 2): while Liftoff watches an app that
// comes from GitHub, and its owner turned this on, the code of every open
// pull request is checked before it merges:
//
//   - secret keys in the files the pull request changes
//   - launch checks Liftoff can read from code alone (the App Store pre-scan
//     for mobile apps) that pass on the app's branch but fail with it
//
// The answer goes back to GitHub as a commit status named "Liftoff", next to
// the repository's other checks, and problems go to the owner's alert
// channel. It uses the GitHub sign-in Liftoff already has (the repo scope
// covers commit statuses), so there's no GitHub App to install.
//
// Each app's record is prs.json beside its state. New pull requests and new
// commits are picked up every few minutes by the watcher's tick.
import fs from 'node:fs';
import path from 'node:path';
import { checklistFor } from '../../lib/catalog.mjs';
import { scanSecrets, storeScan } from '../../lib/scan.mjs';
import { extractTarGz } from './archive.mjs';
import { HttpError } from './http.mjs';
import { githubToken } from './importer.mjs';
import { readJson, writeJson } from './store.mjs';

const MIN = 60_000;
const LIST = 20; // open pull requests looked at per app, newest first
const PER_PASS = 3; // pull requests checked per app per pass
const AT_ONCE = 2; // apps checked at the same time
const FILE_PAGES = 3; // changed files read per pull request, 100 a page
const CONTEXT = 'Liftoff';
const clip = (s, n) => String(s ?? '').slice(0, n);
const enc = encodeURIComponent;

// What a commit status says: GitHub keeps 140 characters.
export function statusText(problems) {
  if (!problems.length) return 'No secret keys added, and no launch checks broken';
  const first = `${problems[0].title}: ${problems[0].detail}`;
  return clip(problems.length === 1 ? first : `${problems.length} problems. ${first}`, 140);
}

export class PullChecks {
  constructor(ctx, { now = () => Date.now() } = {}) {
    this.ctx = ctx;
    this.now = now;
    this.running = new Map(); // `${uid}:${slug}` → promise of its check
  }

  get everyMs() {
    return (this.ctx.config.watch?.prMinutes || 10) * MIN;
  }

  file(uid, slug) {
    return path.join(this.ctx.store.appDir(uid, slug), 'prs.json');
  }

  load(uid, slug) {
    const r = readJson(this.file(uid, slug), {}) || {};
    return { on: !!r.on, onAt: r.onAt || null, checkedAt: r.checkedAt || null, error: r.error || null, prs: Array.isArray(r.prs) ? r.prs : [] };
  }

  // Read, change and write, never for an app that was removed meanwhile.
  update(uid, slug, fn) {
    if (!fs.existsSync(path.join(this.ctx.store.appDir(uid, slug), 'state.json'))) return null;
    const r = this.load(uid, slug);
    fn(r);
    writeJson(this.file(uid, slug), r);
    return r;
  }

  repo(state) {
    const s = state?.source;
    return s?.type === 'github' && s.owner && s.repo ? { owner: s.owner, repo: s.repo } : null;
  }

  // Whether pull requests are checked for this app now, and why not.
  status(uid, state, r = this.load(uid, state.slug)) {
    let why = null;
    if (!this.repo(state)) why = 'not-github';
    else if (!r.on) why = 'off';
    else if (!this.ctx.watch.status(uid, state).watching) why = 'not-watched';
    else if (!githubToken(this.ctx.store, uid)) why = 'no-token';
    return { checking: !why, why };
  }

  // Turn it on or off for one app. Turning it on checks the open pull
  // requests straight away, in the background.
  setOn(uid, slug, on) {
    const state = this.ctx.store.loadApp(uid, slug);
    if (!state) throw new HttpError(404, 'No such app');
    if (on && !this.repo(state)) throw new HttpError(400, 'Pull request checks are for apps imported from GitHub.');
    if (on && !githubToken(this.ctx.store, uid)) throw new HttpError(400, 'Connect GitHub first, under Connections.');
    this.update(uid, slug, (r) => {
      r.on = !!on;
      r.onAt = on ? new Date(this.now()).toISOString() : null;
      if (!on) r.prs = [];
      r.checkedAt = null;
      r.error = null;
    });
    if (on && this.status(uid, state).checking) this.start(uid, slug);
  }

  // Apps whose pull requests are due a look.
  due() {
    const { store } = this.ctx;
    const t = this.now();
    const out = [];
    for (const uid of store.listUsers()) {
      for (const slug of store.listApps(uid)) {
        if (this.running.has(`${uid}:${slug}`)) continue;
        const state = store.loadApp(uid, slug);
        if (!state || !this.repo(state)) continue;
        const r = this.load(uid, slug);
        if (!this.status(uid, state, r).checking) continue;
        if (!r.checkedAt || t - Date.parse(r.checkedAt) >= this.everyMs - 5000) out.push({ uid, slug });
      }
    }
    return out;
  }

  // One pass: start what's due, at most a couple at once. Returns when
  // they're done.
  async runDue() {
    const due = this.due();
    let i = 0;
    const lane = async () => {
      while (i < due.length) {
        const { uid, slug } = due[i++];
        await this.start(uid, slug);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, due.length) }, lane));
  }

  start(uid, slug) {
    const key = `${uid}:${slug}`;
    if (this.running.has(key)) return this.running.get(key);
    const job = this.check(uid, slug)
      .catch((e) => console.error(`[liftoff-cloud] pull requests ${slug}:`, e?.stack || e))
      .finally(() => this.running.delete(key));
    this.running.set(key, job);
    return job;
  }

  async idle() {
    await Promise.allSettled([...this.running.values()]);
  }

  // Look at the open pull requests and check the ones with new commits.
  async check(uid, slug) {
    const { ctx } = this;
    const state = ctx.store.loadApp(uid, slug);
    if (!state || !this.status(uid, state).checking) return null;
    const { owner, repo } = this.repo(state);
    const token = githubToken(ctx.store, uid);
    const at = new Date(this.now()).toISOString();
    let open;
    try {
      open = await ctx.github.api(token, `/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=${LIST}`);
      if (!Array.isArray(open)) throw new Error('GitHub sent no list');
    } catch (e) {
      return this.update(uid, slug, (r) => {
        r.checkedAt = at;
        r.error = clip(`Couldn’t list the pull requests on GitHub: ${e.message}`, 300);
      });
    }
    const before = new Map(this.load(uid, slug).prs.map((p) => [p.number, p]));
    const fresh = open.filter((pr) => pr?.head?.sha && before.get(pr.number)?.sha !== pr.head.sha).slice(0, PER_PASS);
    const done = new Map();
    for (const pr of fresh) done.set(pr.number, await this.checkOne(uid, state, token, pr));
    const r = this.update(uid, slug, (rec) => {
      rec.checkedAt = at;
      rec.error = null;
      // Only what's open now is kept; ones not reached this pass wait for the next.
      rec.prs = open.map((pr) => done.get(pr.number) || (before.get(pr.number)?.sha === pr.head?.sha ? { ...before.get(pr.number), title: clip(pr.title, 200) } : null)).filter(Boolean);
    });
    for (const entry of done.values()) {
      if (entry.result === 'problems') await this.alert(uid, state, entry);
    }
    return r;
  }

  async setStatus(token, owner, repo, sha, state, description, slug) {
    await this.ctx.github.api(token, `/repos/${enc(owner)}/${enc(repo)}/statuses/${enc(sha)}`, {
      method: 'POST',
      body: { state, description: clip(description, 140), context: CONTEXT, target_url: `${this.ctx.config.publicUrl}/#${enc(slug)}` },
    });
  }

  // One pull request at one commit.
  async checkOne(uid, state, token, pr) {
    const { ctx } = this;
    const { owner, repo } = this.repo(state);
    const sha = String(pr.head.sha);
    const entry = { number: pr.number, title: clip(pr.title, 200), url: String(pr.html_url || ''), author: clip(pr.user?.login, 60) || null, sha, at: new Date(this.now()).toISOString(), result: 'error', problems: [], detail: null, status: null, statusError: null };
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) return { ...entry, detail: 'GitHub sent an odd commit id.' };
    let statusOk = true;
    const status = async (s, text) => {
      try {
        await this.setStatus(token, owner, repo, sha, s, text, state.slug);
      } catch (e) {
        statusOk = false;
        entry.statusError = clip(e.message, 200);
      }
    };
    await status('pending', 'Checking for secret keys and launch checks this would break…');
    const tmp = ctx.store.tmpDir();
    try {
      const tarball = await ctx.github.downloadTarball(token, owner, repo, sha, ctx.config.maxSourceBytes);
      const dir = path.join(tmp, 'src');
      extractTarGz(tarball, dir, { maxBytes: ctx.config.maxSourceBytes, maxFiles: ctx.config.maxSourceFiles });
      const changed = new Set();
      for (let page = 1; page <= FILE_PAGES; page++) {
        const files = await ctx.github.api(token, `/repos/${enc(owner)}/${enc(repo)}/pulls/${enc(pr.number)}/files?per_page=100&page=${page}`);
        for (const f of Array.isArray(files) ? files : []) if (f.status !== 'removed' && f.filename) changed.add(String(f.filename));
        if (!Array.isArray(files) || files.length < 100) break;
      }
      entry.problems = problemsIn(state, dir, changed);
      entry.result = entry.problems.length ? 'problems' : 'ok';
    } catch (e) {
      entry.detail = clip(`Couldn’t check this pull request: ${e.message}`, 300);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (entry.result === 'error') await status('error', 'Liftoff couldn’t check this pull request. It tries again on the next commit.');
    else await status(entry.problems.length ? 'failure' : 'success', statusText(entry.problems));
    entry.status = statusOk ? 'posted' : 'failed';
    return entry;
  }

  async alert(uid, state, entry) {
    const list = entry.problems.slice(0, 3).map((p) => `${p.title}: ${p.detail}`).join('; ');
    const more = entry.problems.length > 3 ? ` (+${entry.problems.length - 3} more)` : '';
    const text = `Liftoff alert: pull request #${entry.number} "${entry.title}" on ${state.name}: ${list}${more}.\n${entry.url}`;
    await this.ctx.alerts?.send(uid, text).catch(() => false);
  }

  // What the Flight Board shows.
  view(uid, state) {
    if (!this.repo(state)) return null;
    const r = this.load(uid, state.slug);
    const st = this.status(uid, state, r);
    return {
      on: r.on,
      checking: st.checking,
      why: st.why,
      running: this.running.has(`${uid}:${state.slug}`),
      everyMinutes: Math.round(this.everyMs / MIN),
      checkedAt: r.checkedAt,
      error: r.error,
      prs: r.prs.map((p) => ({ number: p.number, title: p.title, url: p.url, author: p.author, sha: p.sha.slice(0, 7), at: p.at, result: p.result, problems: p.problems, detail: p.detail, statusError: p.statusError })),
    };
  }
}

// What's wrong with a pull request's code, against the app as Liftoff last
// read its branch. Secret keys count only in files the pull request changes,
// so a key already on the branch (the daily checks catch that) isn't blamed
// on it. Other checks count when they pass on the branch and fail here.
export function problemsIn(state, dir, changed) {
  const problems = [];
  const keys = scanSecrets(dir).filter((h) => changed.has(h.file));
  for (const h of keys.slice(0, 5)) problems.push({ id: 'sec-keys', title: 'Secret key added', detail: `${h.kind} in ${h.file}` });
  if (keys.length > 5) problems.push({ id: 'sec-keys', title: 'Secret key added', detail: `${keys.length - 5} more` });
  const titles = new Map(checklistFor(state.platforms || []).map((c) => [c.id, c.title]));
  const base = new Map((state.lastScan?.findings || []).map((f) => [f.id, f]));
  for (const f of storeScan(dir, state)) {
    if (f.ok || !state.checklist?.[f.id] || base.get(f.id)?.ok !== true) continue;
    problems.push({ id: f.id, title: `${titles.get(f.id) || f.id}: stops passing`, detail: f.detail });
  }
  return problems;
}
