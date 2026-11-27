// Persistent state.
//
//   ~/.liftoff/accounts.json     which accounts are connected (no secrets)
//   ~/.liftoff/credentials.env   the secrets themselves, mode 600
//   ~/.liftoff/projects.json     every app onboarded on this machine
//   <app>/.liftoff/state.json    one app's steps, tasks, checklist and deploys
//
// Set LIFTOFF_HOME to move the shared folder (the tests do this).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectProject } from './detect.mjs';
import { ACCOUNTS, STEPS, STEP_STATUSES, accountsFor, autoCheck, checklistFor, needsFor, paperworkFor, stepsFor } from './catalog.mjs';

export function homeDir() {
  return process.env.LIFTOFF_HOME || path.join(os.homedir(), '.liftoff');
}

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, mode = 0o644) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

const now = () => new Date().toISOString();

// ---------- accounts (connected once, reused by every app) ----------

const credFile = () => path.join(homeDir(), 'credentials.env');
const accountsFile = () => path.join(homeDir(), 'accounts.json');

export function readCredentials() {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(credFile(), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = JSON.parse(m[2]);
  }
  return out;
}

function writeCredentials(creds) {
  ensureDir(homeDir());
  const body = Object.entries(creds)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('\n');
  fs.writeFileSync(credFile(), body + '\n', { mode: 0o600 });
  fs.chmodSync(credFile(), 0o600);
}

export function connectAccount(id, values) {
  const def = ACCOUNTS[id];
  if (!def) throw new Error(`Unknown account "${id}". Known: ${Object.keys(ACCOUNTS).join(', ')}`);
  const missing = def.env.filter((k) => !values[k]);
  if (missing.length) throw new Error(`Missing ${missing.join(', ')} for ${def.label}`);
  const creds = readCredentials();
  for (const k of def.env) creds[k] = values[k];
  writeCredentials(creds);
  const meta = readJson(accountsFile(), {});
  meta[id] = { connectedAt: now() };
  writeJson(accountsFile(), meta);
  return listAccounts().find((a) => a.id === id);
}

export function disconnectAccount(id) {
  const def = ACCOUNTS[id];
  if (!def) throw new Error(`Unknown account "${id}"`);
  const creds = readCredentials();
  for (const k of def.env) delete creds[k];
  writeCredentials(creds);
  const meta = readJson(accountsFile(), {});
  delete meta[id];
  writeJson(accountsFile(), meta);
}

export function listAccounts() {
  const creds = readCredentials();
  const meta = readJson(accountsFile(), {});
  return Object.entries(ACCOUNTS).map(([id, def]) => {
    const connected = def.env.every((k) => creds[k] || process.env[k]);
    return { id, label: def.label, note: def.note, url: def.url, env: def.env, connected, connectedAt: meta[id]?.connectedAt || null };
  });
}

// Environment with every stored credential added, for `liftoff exec`.
export function credentialEnv() {
  return { ...readCredentials(), ...process.env };
}

// ---------- project registry ----------

const projectsFile = () => path.join(homeDir(), 'projects.json');

export function listProjects() {
  return readJson(projectsFile(), []).filter((p) => fs.existsSync(stateFile(p.root)));
}

function registerProject(slug, root) {
  const all = readJson(projectsFile(), []).filter((p) => p.root !== root);
  all.push({ slug, root });
  writeJson(projectsFile(), all);
}

export function findProject(slugOrRoot) {
  const projects = listProjects();
  return projects.find((p) => p.slug === slugOrRoot) || projects.find((p) => p.root === path.resolve(slugOrRoot)) || null;
}

// ---------- per-app state ----------

export const stateFile = (root) => path.join(root, '.liftoff', 'state.json');

export function loadState(root) {
  const state = readJson(stateFile(path.resolve(root)), null);
  if (!state) throw new Error(`No Liftoff state in ${root}. Run \`liftoff init\` there first.`);
  return state;
}

export function saveState(state) {
  state.updatedAt = now();
  writeJson(stateFile(state.root), state);
  return state;
}

function shallowFiles(root, depth = 4) {
  const out = [];
  const skip = new Set(['node_modules', '.git', '.liftoff', 'build', 'dist', '.next', 'Pods', '.expo']);
  const walk = (dir, d) => {
    if (d > depth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const rel = path.relative(root, path.join(dir, e.name));
      if (e.isDirectory()) walk(path.join(dir, e.name), d + 1);
      else out.push(rel);
    }
  };
  walk(root, 0);
  return out;
}

// Create or refresh an app's state from what's in the repo. Keeps any
// progress already recorded; only adds steps and checklist items that are new.
export function initProject(dir) {
  const detected = detectProject(dir);
  let state;
  try {
    state = loadState(detected.root);
  } catch {
    state = { version: 1, createdAt: now(), steps: {}, tasks: [], checklist: {}, deploys: [], liveUrl: null, log: [] };
  }
  state.config ||= {};
  state.changes ||= {};
  Object.assign(state, {
    root: detected.root,
    name: state.name || detected.name,
    slug: state.slug || detected.slug,
    framework: detected.framework,
    platforms: detected.platforms.length ? detected.platforms : state.platforms || ['web'],
    integrations: detected.integrations,
  });

  for (const step of stepsFor(state.platforms)) {
    state.steps[step.id] ||= { status: 'todo', provider: null, note: null, updatedAt: null };
  }

  const files = shallowFiles(detected.root);
  for (const item of checklistFor(state.platforms)) {
    const cur = state.checklist[item.id];
    if (item.auto && autoCheck(item.auto, { integrations: detected.integrations }, files)) {
      if (!cur?.done) state.checklist[item.id] = { done: true, by: 'auto', at: now() };
    } else if (!cur) {
      state.checklist[item.id] = { done: false, by: null, at: null };
    }
  }

  // Paperwork with long lead times goes on the task list on day one, once.
  for (const w of paperworkFor(state.platforms)) {
    if (state.tasks.some((t) => t.key === w.key)) continue;
    const t = addTask(state, w.title, { blocksRelease: w.blocks, key: w.key, leadTime: w.days, url: w.url });
    t.startNow = true;
  }

  saveState(state);
  registerProject(state.slug, state.root);
  return state;
}

// Steps whose needs are not finished yet.
export function waitingOn(state, id) {
  const step = STEPS.find((s) => s.id === id);
  if (!step) return [];
  return needsFor(step, state.platforms).filter((n) => !['done', 'skipped'].includes(state.steps[n]?.status));
}

// The steps that can run now, in order.
export function nextSteps(state) {
  return stepsFor(state.platforms)
    .filter((s) => !['done', 'skipped'].includes(state.steps[s.id]?.status) && waitingOn(state, s.id).length === 0)
    .map((s) => s.id);
}

const STALE_MS = 2 * 60 * 60 * 1000;
export function isStale(step, at = Date.now()) {
  return step?.status === 'running' && step.updatedAt && at - Date.parse(step.updatedAt) > STALE_MS;
}

export function setStep(state, id, status, { provider, note, force = false } = {}) {
  if (!state.steps[id]) throw new Error(`Step "${id}" doesn't apply to this app. Steps: ${Object.keys(state.steps).join(', ')}`);
  if (!STEP_STATUSES.includes(status)) throw new Error(`Status must be one of ${STEP_STATUSES.join(', ')}`);
  if ((status === 'done' || status === 'running') && !force) {
    const waiting = waitingOn(state, id);
    if (waiting.length) throw new Error(`"${id}" needs ${waiting.join(', ')} first. Finish or skip those, or pass --force.`);
  }
  const step = state.steps[id];
  step.status = status;
  if (provider !== undefined) step.provider = provider;
  if (note !== undefined) step.note = note;
  step.updatedAt = now();
  state.log.push({ at: now(), msg: `${id} → ${status}${note ? `: ${note}` : ''}` });
  return state;
}

export function addTask(state, title, { blocksRelease = false, owner = 'you', key, leadTime, url } = {}) {
  const task = { id: crypto.randomBytes(4).toString('hex'), title, blocksRelease, owner, done: false, createdAt: now(), doneAt: null };
  if (key) task.key = key;
  if (leadTime) task.leadTime = leadTime;
  if (url) task.url = url;
  state.tasks.push(task);
  return task;
}

export function setTaskDone(state, id, done = true) {
  const task = state.tasks.find((t) => t.id === id || t.id.startsWith(id));
  if (!task) throw new Error(`No task "${id}"`);
  task.done = done;
  task.doneAt = done ? now() : null;
  return task;
}

export function removeTask(state, id) {
  const before = state.tasks.length;
  state.tasks = state.tasks.filter((t) => t.id !== id);
  if (state.tasks.length === before) throw new Error(`No task "${id}"`);
}

export function setCheck(state, id, done = true, by = 'claude') {
  if (!state.checklist[id]) throw new Error(`Checklist item "${id}" doesn't apply to this app`);
  state.checklist[id] = { done, by: done ? by : null, at: done ? now() : null };
  return state.checklist[id];
}

export function addDeploy(state, { target, platform, version, url, status = 'live' }) {
  const deploy = { target, platform, version: version || null, url: url || null, status, at: now() };
  state.deploys = state.deploys.filter((d) => d.target !== target);
  state.deploys.push(deploy);
  if (url && platform === 'web' && status === 'live') state.liveUrl = url;
  return deploy;
}

// ---------- what each step changed (for undo) ----------

// kind: "file" (path in the repo) or "resource" (e.g. "stripe:product:prod_123",
// "vercel:project:fernweh", "github:secret:STRIPE_SECRET_KEY").
export function recordChange(state, stepId, kind, value) {
  if (!state.steps[stepId]) throw new Error(`Step "${stepId}" doesn't apply to this app`);
  if (!['file', 'resource'].includes(kind)) throw new Error('kind must be file or resource');
  state.changes ||= {};
  const list = (state.changes[stepId] ||= []);
  if (!list.some((c) => c.kind === kind && c.value === value)) list.push({ kind, value, at: now() });
  return list;
}

// What undoing a step involves. The CLI only resets the record; Claude reverts
// the files and, with the user's yes, deletes the resources it lists.
export function undoPlan(state, stepId) {
  if (!state.steps[stepId]) throw new Error(`Step "${stepId}" doesn't apply to this app`);
  const changes = state.changes?.[stepId] || [];
  const dependents = Object.keys(state.steps).filter(
    (id) => waitingOnIds(state, id).includes(stepId) && ['done', 'running'].includes(state.steps[id].status),
  );
  return {
    step: stepId,
    files: changes.filter((c) => c.kind === 'file').map((c) => c.value),
    resources: changes.filter((c) => c.kind === 'resource').map((c) => c.value),
    dependents,
  };
}

function waitingOnIds(state, id) {
  const step = STEPS.find((s) => s.id === id);
  return step ? needsFor(step, state.platforms) : [];
}

export function resetStep(state, stepId) {
  setStep(state, stepId, 'todo', { note: 'undone', force: true });
  delete state.changes?.[stepId];
  return state;
}

// ---------- per-app settings that checks and Pulse read ----------

export const CONFIG_KEYS = {
  'github.repo': 'owner/name of the GitHub repo (default: read from git remote)',
  'sentry.org': 'Sentry organization slug',
  'sentry.project': 'Sentry project slug',
  'posthog.host': 'PostHog host, e.g. https://us.posthog.com',
  'posthog.project': 'PostHog project id (number)',
  'supabase.ref': 'Supabase project ref',
  'revenuecat.project': 'RevenueCat project id',
  'email.domain': 'Domain email is sent from',
  'health.path': 'Health check path (default /api/health)',
};

export function setConfig(state, key, value) {
  if (!CONFIG_KEYS[key]) throw new Error(`Unknown setting "${key}". Known: ${Object.keys(CONFIG_KEYS).join(', ')}`);
  state.config ||= {};
  if (value === null || value === '') delete state.config[key];
  else state.config[key] = String(value);
  return state.config;
}

// Everything Mission Control shows for one app.
export function summarize(state) {
  const steps = stepsFor(state.platforms).map((s) => ({
    id: s.id,
    label: s.label,
    skill: s.skill,
    ...state.steps[s.id],
    waitingOn: waitingOn(state, s.id),
    stale: !!isStale(state.steps[s.id]),
  }));
  const items = checklistFor(state.platforms).map((c) => ({ ...c, ...(state.checklist[c.id] || { done: false }) }));
  const openTasks = state.tasks.filter((t) => !t.done);
  const blocking = openTasks.filter((t) => t.blocksRelease);
  const stepsDone = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const checksDone = items.filter((i) => i.done).length;
  const accounts = listAccounts();
  const needed = accountsFor(state.platforms);
  return {
    name: state.name,
    slug: state.slug,
    root: state.root,
    framework: state.framework,
    platforms: state.platforms,
    liveUrl: state.liveUrl,
    deploys: state.deploys,
    steps,
    stepsDone,
    stepsTotal: steps.length,
    checklist: items,
    checksDone,
    checksTotal: items.length,
    tasks: [...state.tasks].sort((a, b) => a.done - b.done || b.blocksRelease - a.blocksRelease),
    openTasks: openTasks.length,
    blockingTasks: blocking.length,
    readyForRelease: blocking.length === 0 && stepsDone === steps.length,
    nextSteps: nextSteps(state),
    config: state.config || {},
    pulse: state.pulse?.latest || null,
    accounts: needed.map((id) => accounts.find((a) => a.id === id)),
    log: state.log.slice(-20),
    updatedAt: state.updatedAt,
  };
}
