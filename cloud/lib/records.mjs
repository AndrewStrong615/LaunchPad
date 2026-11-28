// Run records: what happened in each cloud run, kept on the server so Liftoff
// can learn which stacks and steps go well and which break. Phase 3 of the
// roadmap (playbooks, success rates per stack) is built from these.
//
//   records/runs/<run id>.json   one record per run, written when it starts
//                                and again each time it stops working
//
// A record is about the launch, not the person. It holds the stack, the steps
// asked for and how each one ended, the checklist before and after, the cost,
// and the error texts. It holds no names, repo, code, keys, notes or chat.
// The app is a keyed hash, so runs of one app group together but can't be
// traced back once the account is gone. Error texts have links, hosts,
// addresses, emails, key-like strings and the app's own name taken out.
// Records stay when an app or an account is deleted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CHECKLIST, STEPS } from '../../lib/catalog.mjs';
import { MODELS } from './agent.mjs';
import { listUserAccounts } from './accounts.mjs';
import { readJson, writeJson } from './store.mjs';

const VERSION = 1;
// A run has stopped working: it finished, was stopped, failed, or is paused at its budget.
export const SETTLED = new Set(['finished', 'stopped', 'budget', 'failed']);
const RUN = /^r_[a-z0-9]{6,32}$/;
const MAX_ERRORS = 20;
const money = (n) => Math.round(n * 100) / 100;

// ---------- scrubbing ----------

const TLD = 'com|net|org|io|app|dev|co|ai|xyz|me|us|uk|de|fr|ca|au|site|store|shop|tech|cloud|page|online|info|biz|so|gg|tv';
const HOST = new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLD})\\b`, 'gi');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An error text with nothing in it that points at a person, a site or a key.
// `words` are this app's own names (app name, repo, login), taken out too.
export function scrub(text, words = [], n = 240) {
  let s = String(text ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<link>')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    .replace(/\b(?:sk|pk|rk)_(?:live|test)_\w+/g, '<key>')
    .replace(/\b(?:whsec|ghp|gho|ghu|ghs|github_pat|xox[abprs]|sk-ant|AKIA)[\w-]{6,}/g, '<key>')
    .replace(/\beyJ[\w-]{10,}(?:\.[\w-]+){0,2}/g, '<key>')
    .replace(/[A-Za-z0-9+_=-]{32,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<key>' : m))
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(HOST, '<host>');
  for (const w of words) {
    if (typeof w === 'string' && w.trim().length >= 4) s = s.replace(new RegExp(escape(w.trim()), 'gi'), '<app>');
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------- what a record holds ----------

// The stack, from what the scan detected. Nothing here names the app.
export function stackOf(state) {
  return {
    framework: state.framework || null,
    platforms: [...(state.platforms || [])].sort(),
    auth: state.auth || null,
    payments: [...(state.payments || [])].sort(),
    packageManager: state.packageManager || null,
    monorepo: (state.apps || []).length > 1,
    integrations: Object.entries(state.integrations || {}).filter(([, v]) => v === true).map(([k]) => k).sort(),
    source: state.source?.type || null,
  };
}

export const stackLabel = (s) => `${s?.framework || 'Unknown framework'} · ${(s?.platforms || []).join(' + ') || 'web'}`;

// Each checklist item in one word: proven (by verify), failed (verify said
// no), ticked (by Claude, the person or the scan), or open.
function checkWord(c) {
  if (!c) return 'open';
  if (c.verify?.ok === false) return 'failed';
  if (c.done && c.by === 'verified') return 'proven';
  return c.done ? 'ticked' : 'open';
}

function snapshot(state) {
  return {
    steps: Object.fromEntries(Object.entries(state.steps || {}).map(([id, s]) => [id, s?.status || 'todo'])),
    checks: Object.fromEntries(Object.entries(state.checklist || {}).map(([id, c]) => [id, checkWord(c)])),
  };
}

// The app's own names, to take out of error texts.
function namesOf(state, user) {
  const full = state?.source?.fullName || '';
  return [state?.name, state?.slug, full, ...full.split('/'), user?.login, user?.name].filter(Boolean);
}

// Errors the run hit: the run's own, the session's, and Liftoff or sandbox
// tools that failed. The same text once.
function errorsOf(run, words) {
  const out = [];
  const add = (where, text) => {
    const t = scrub(text, words);
    if (t && !out.some((e) => e.text === t) && out.length < MAX_ERRORS) out.push({ where, text: t });
  };
  if (run.error) add('run', run.error);
  for (const e of run.events || []) {
    if (e.kind === 'error') add('session', e.text);
    else if ((e.kind === 'liftoff' || e.kind === 'tool') && e.isError) add(e.tool || 'tool', e.out || e.text);
  }
  return out;
}

function countsOf(run) {
  const ev = run.events || [];
  const n = (pred) => ev.filter(pred).length;
  const answer = /^(Allowed|Declined): /;
  return {
    events: run.seq || ev.length,
    messages: n((e) => e.kind === 'message'),
    tools: n((e) => e.kind === 'tool'),
    liftoffTools: n((e) => e.kind === 'liftoff'),
    questions: n((e) => e.kind === 'question'),
    approvals: n((e) => e.kind === 'you' && answer.test(e.text || '')),
    declined: n((e) => e.kind === 'you' && /^Declined: /.test(e.text || '')),
    nudges: n((e) => e.kind === 'you' && !e.id && !answer.test(e.text || '') && e.text !== 'Stop' && !/^Raised the budget/.test(e.text || '')),
  };
}

// ---------- the store of records ----------

export class Records {
  constructor(ctx) {
    this.ctx = ctx;
    this.dir = path.join(ctx.config.dataDir, 'records', 'runs');
    this.seen = new Map(); // run id → the state last written, so saves that change nothing don't rewrite it
  }

  // Groups runs of one app without saying whose app it is.
  appKey(uid, slug) {
    return `a_${crypto.createHmac('sha256', this.ctx.store.keys.mac).update(`run-record\0${uid}\0${slug}`).digest('hex').slice(0, 16)}`;
  }

  file(id) {
    if (!RUN.test(String(id))) throw new Error('Bad run id');
    return path.join(this.dir, `${id}.json`);
  }

  load(id) {
    return RUN.test(String(id)) ? readJson(this.file(id)) : null;
  }

  // Who may read the records: GitHub logins in LIFTOFF_ADMIN_LOGINS (or the
  // local developer account, when it's listed and dev sign-in is on).
  isAdmin(user) {
    const list = this.ctx.config.adminLogins || [];
    if (!user?.login || !list.includes(String(user.login).toLowerCase())) return false;
    return !!user.githubId || this.ctx.config.devLogin;
  }

  // A run started: note the stack and where the app stood.
  begin(run, state) {
    try {
      // The user's own services count by what they're for, never by name.
      const accounts = listUserAccounts(this.ctx.store, run.uid).filter((a) => a.connected).map((a) => (a.custom ? `custom:${a.category}` : a.id)).sort();
      writeJson(this.file(run.id), {
        v: VERSION,
        id: run.id,
        app: this.appKey(run.uid, run.slug),
        startedAt: run.createdAt,
        updatedAt: new Date().toISOString(),
        outcome: 'running',
        stack: stackOf(state),
        accounts,
        model: run.model || null,
        mode: run.mode || null,
        asked: [...(run.steps || [])],
        budgetUsd: run.budgetUsd ?? null,
        before: snapshot(state),
      });
    } catch (e) {
      console.error(`[liftoff-cloud] run record for ${run.id}:`, e?.message || e);
    }
  }

  // The run stopped working (finished, stopped, failed, or paused at its
  // budget): note how it ended and where the app stands now. A run that is
  // picked up again settles again, and its record is brought up to date.
  settle(run) {
    if (!SETTLED.has(run.status)) return;
    const mark = [run.status, run.cost, run.endedAt, run.budgetUsd, run.seq].join('|');
    if (this.seen.get(run.id) === mark) return;
    this.seen.set(run.id, mark);
    try {
      const rec = this.load(run.id);
      if (!rec) return; // a run from before records were kept
      const state = this.ctx.store.loadApp(run.uid, run.slug);
      const words = namesOf(state, this.ctx.store.getUser(run.uid));
      const before = rec.before;
      if (state) {
        const after = snapshot(state);
        rec.after = after;
        rec.steps = Object.entries(after.steps)
          .filter(([id, to]) => rec.asked.includes(id) || before.steps[id] !== to)
          .map(([id, to]) => {
            const cur = state.steps[id] || {};
            const step = { id, from: before.steps[id] ?? null, to };
            if (cur.provider) step.provider = scrub(cur.provider, words, 40);
            if (to === 'blocked' && cur.note) step.why = scrub(cur.note, words);
            return step;
          });
        rec.checks = Object.entries(after.checks).filter(([id, to]) => (before.checks[id] ?? 'open') !== to).map(([id, to]) => ({ id, from: before.checks[id] ?? null, to }));
        rec.failing = Object.entries(after.checks).filter(([, w]) => w === 'failed').map(([id]) => ({ id, detail: scrub(state.checklist[id]?.verify?.detail, words, 200) }));
      }
      rec.stepsDone = (rec.steps || []).filter((s) => s.to === 'done' && s.from !== 'done').length;
      rec.outcome = run.status;
      rec.endedAt = run.endedAt || null;
      rec.minutes = run.endedAt ? Math.round((Date.parse(run.endedAt) - Date.parse(rec.startedAt)) / 6000) / 10 : null;
      rec.cost = run.cost ?? null;
      rec.budgetUsd = run.budgetUsd ?? rec.budgetUsd;
      rec.pr = !!run.pr;
      rec.errors = errorsOf(run, words);
      rec.counts = countsOf(run);
      rec.settled = (rec.settled || 0) + 1;
      rec.updatedAt = new Date().toISOString();
      writeJson(this.file(run.id), rec);
    } catch (e) {
      console.error(`[liftoff-cloud] run record for ${run.id}:`, e?.message || e);
    }
  }

  // Every record, oldest first.
  all() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => RUN.test(f.slice(0, -5)) && f.endsWith('.json'));
    } catch {
      return [];
    }
    return files.map((f) => readJson(path.join(this.dir, f))).filter((r) => r?.v).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  }

  summary() {
    return summarize(this.all());
  }
}

// ---------- the numbers ----------

const top = (keys, n = 8) => {
  const m = new Map();
  for (const k of keys) if (k) m.set(k, (m.get(k) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
};

function tally(rs) {
  const ended = rs.filter((r) => SETTLED.has(r.outcome));
  const is = (o) => ended.filter((r) => r.outcome === o).length;
  const cost = ended.reduce((t, r) => t + (Number(r.cost) || 0), 0);
  const steps = ended.reduce((t, r) => t + (r.stepsDone || 0), 0);
  return {
    runs: rs.length,
    ended: ended.length,
    finished: is('finished'),
    failed: is('failed'),
    stopped: is('stopped'),
    budget: is('budget'),
    cost: money(cost),
    avgCost: ended.length ? money(cost / ended.length) : null,
    stepsDone: steps,
    costPerStep: steps ? money(cost / steps) : null,
  };
}

function groupBy(rs, keyOf) {
  const m = new Map();
  for (const r of rs) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m];
}

const stepLabel = (id) => STEPS.find((s) => s.id === id)?.label || id;
const checkTitle = (id) => CHECKLIST.find((c) => c.id === id)?.title || id;
// Admins see the mode and the real model behind it, e.g. "Cruise · Claude Sonnet 5.5".
const modelLabel = (id) => { const m = MODELS.find((x) => x.id === id); return m ? `${m.label} · ${m.name}` : id || 'Unknown model'; };

// What the admin page shows: totals, then by stack, step and model, then
// the checks and errors that come up most.
export function summarize(records) {
  const byStack = groupBy(records, (r) => stackLabel(r.stack)).map(([label, rs]) => ({
    label,
    apps: new Set(rs.map((r) => r.app)).size,
    ...tally(rs),
    topFailure: top(rs.flatMap((r) => (r.failing || []).map((f) => f.id)), 1).map(([id, n]) => ({ id, title: checkTitle(id), n }))[0] || null,
  })).sort((a, b) => b.runs - a.runs || a.label.localeCompare(b.label));

  const byModel = groupBy(records, (r) => r.model || '').map(([id, rs]) => ({ id, label: modelLabel(id), ...tally(rs) })).sort((a, b) => b.runs - a.runs);

  const stepIds = [...new Set(records.flatMap((r) => (r.steps || []).map((s) => s.id)))];
  const bySteps = stepIds.map((id) => {
    const tried = records.filter((r) => SETTLED.has(r.outcome) && (r.steps || []).some((s) => s.id === id && s.from !== 'done'));
    const end = (to) => tried.filter((r) => r.steps.find((s) => s.id === id).to === to).length;
    const done = end('done');
    return {
      id,
      label: stepLabel(id),
      tried: tried.length,
      done,
      blocked: end('blocked'),
      skipped: end('skipped'),
      rate: tried.length ? Math.round((done / tried.length) * 100) : null,
      providers: top(tried.map((r) => r.steps.find((s) => s.id === id).provider), 3).map(([p, n]) => ({ provider: p, n })),
      why: top(tried.map((r) => r.steps.find((s) => s.id === id).why), 3).map(([text, n]) => ({ text, n })),
    };
  }).sort((a, b) => STEPS.findIndex((s) => s.id === a.id) - STEPS.findIndex((s) => s.id === b.id));

  const failures = top(records.flatMap((r) => (r.failing || []).map((f) => f.id))).map(([id, n]) => {
    const last = [...records].reverse().flatMap((r) => r.failing || []).find((f) => f.id === id);
    return { id, title: checkTitle(id), n, example: last?.detail || null };
  });
  const errors = top(records.flatMap((r) => (r.errors || []).map((e) => e.text))).map(([text, n]) => ({ text, n }));

  return {
    total: records.length,
    apps: new Set(records.map((r) => r.app)).size,
    since: records[0]?.startedAt || null,
    ...tally(records),
    byStack,
    bySteps,
    byModel,
    failures,
    errors,
    recent: records.slice(-15).reverse().map((r) => ({
      id: r.id,
      at: r.startedAt,
      stack: stackLabel(r.stack),
      model: modelLabel(r.model),
      outcome: r.outcome,
      cost: r.cost ?? null,
      minutes: r.minutes ?? null,
      stepsDone: r.stepsDone || 0,
      steps: (r.steps || []).map((s) => ({ id: s.id, label: stepLabel(s.id), to: s.to })),
      errors: (r.errors || []).length,
    })),
  };
}
