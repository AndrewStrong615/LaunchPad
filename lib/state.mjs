// Persistent state.
//
//   ~/.liftoff/accounts.json     which accounts are connected (no secrets)
//   ~/.liftoff/credentials.env   the secrets themselves, mode 600
//   ~/.liftoff/projects.json     every app Liftoff knows about on this machine
//   <app>/.liftoff/state.json    one app's steps, tasks, checklist and deploys
//
// Set LIFTOFF_HOME to move the shared folder (the tests do this).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { detectProject } from './detect.mjs';
import { ACCOUNTS, CHECKLIST, PAPERWORK_KEYS, STEPS, STEP_STATUSES, accountsFor, autoCheck, checklistFor, needsFor, paperworkFor, stepsFor } from './catalog.mjs';
import { FEATURES, FEATURE_IDS, detectFeatures, featuresOf, profileView } from './profile.mjs';

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

// Where secrets live. "keychain" uses the macOS Keychain (`security`) or the
// Linux Secret Service (`secret-tool`); "file" uses credentials.env (mode 600).
// Default: the keychain when one is available, else the file.
function hasCmd(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function secretStore() {
  const forced = process.env.LIFTOFF_SECRET_STORE;
  if (forced === 'file' || forced === 'keychain') return forced;
  if (process.platform === 'darwin' && hasCmd('security')) return 'keychain';
  if (process.platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS && hasCmd('secret-tool')) return 'keychain';
  return 'file';
}

const SERVICE = 'liftoff';
const keychain = {
  get(key) {
    try {
      if (process.platform === 'darwin') {
        return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/\n$/, '');
      }
      return execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'account', key], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch {
      return null;
    }
  },
  set(key, value) {
    if (process.platform === 'darwin') {
      // Fed through stdin so the secret never shows up in the process list.
      const q = (v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;
      execFileSync('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a ${key} -w ${q(value)}\n`, stdio: ['pipe', 'ignore', 'pipe'] });
    } else {
      execFileSync('secret-tool', ['store', '--label', `liftoff ${key}`, 'service', SERVICE, 'account', key], { input: value, stdio: ['pipe', 'ignore', 'pipe'] });
    }
  },
  del(key) {
    try {
      if (process.platform === 'darwin') execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', key], { stdio: 'ignore' });
      else execFileSync('secret-tool', ['clear', 'service', SERVICE, 'account', key], { stdio: 'ignore' });
    } catch {}
  },
};

function readCredentialFile() {
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

// Every stored secret, from the file and the keychain.
export function readCredentials() {
  const out = readCredentialFile();
  const meta = readJson(accountsFile(), {});
  for (const [id, m] of Object.entries(meta)) {
    if (m.store !== 'keychain' || !ACCOUNTS[id]) continue;
    for (const k of ACCOUNTS[id].env) {
      const v = keychain.get(k);
      if (v !== null) out[k] = v;
    }
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
  const store = secretStore();
  const creds = readCredentialFile();
  if (store === 'keychain') {
    for (const k of def.env) {
      keychain.set(k, values[k]);
      delete creds[k];
    }
  } else {
    for (const k of def.env) creds[k] = values[k];
  }
  writeCredentials(creds);
  const meta = readJson(accountsFile(), {});
  meta[id] = { connectedAt: now(), store };
  writeJson(accountsFile(), meta);
  return listAccounts().find((a) => a.id === id);
}

export function disconnectAccount(id) {
  const def = ACCOUNTS[id];
  if (!def) throw new Error(`Unknown account "${id}"`);
  const creds = readCredentialFile();
  for (const k of def.env) {
    delete creds[k];
    keychain.del(k);
  }
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
    return { id, label: def.label, note: def.note, url: def.url, env: def.env, connected, connectedAt: meta[id]?.connectedAt || null, store: meta[id]?.store || (connected ? 'file' : null) };
  });
}

// Environment for `liftoff exec`. With `only` (account ids), just those
// accounts' keys are added, so a command can't read keys it doesn't need.
export function credentialEnv(only = null) {
  const creds = readCredentials();
  if (only) {
    const unknown = only.filter((id) => !ACCOUNTS[id]);
    if (unknown.length) throw new Error(`Unknown account(s): ${unknown.join(', ')}`);
    const allowed = new Set(only.flatMap((id) => ACCOUNTS[id].env));
    for (const k of Object.keys(creds)) if (!allowed.has(k)) delete creds[k];
  }
  return { ...process.env, ...creds };
}

// Move secrets from credentials.env into the keychain.
export function migrateToKeychain() {
  if (secretStore() !== 'keychain') throw new Error('No keychain found on this machine (macOS Keychain or Linux secret-tool).');
  const creds = readCredentialFile();
  const meta = readJson(accountsFile(), {});
  const moved = [];
  for (const [id, def] of Object.entries(ACCOUNTS)) {
    if (!def.env.every((k) => creds[k])) continue;
    for (const k of def.env) {
      keychain.set(k, creds[k]);
      delete creds[k];
    }
    meta[id] = { ...(meta[id] || { connectedAt: now() }), store: 'keychain' };
    moved.push(id);
  }
  writeCredentials(creds);
  writeJson(accountsFile(), meta);
  return moved;
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

export function shallowFiles(root, depth = 4) {
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
    state = null;
  }
  state = refreshState(state, detected, shallowFiles(detected.root));
  saveState(state);
  registerProject(state.slug, state.root);
  return state;
}

export const newState = () => ({ version: 1, createdAt: now(), steps: {}, tasks: [], checklist: {}, deploys: [], liveUrl: null, log: [] });

// The storage-free part of init: merge what detection found into a state
// (or a new one), work out what the app does, add the steps and checklist
// items that fit it, tick what the repo proves, and add day-one paperwork.
// Liftoff Cloud calls this with its own storage.
export function refreshState(state, detected, files = []) {
  state ||= newState();
  state.config ||= {};
  state.changes ||= {};
  Object.assign(state, {
    root: detected.root,
    name: state.name || detected.name,
    slug: state.slug || detected.slug,
    framework: detected.framework,
    platforms: detected.platforms.length ? detected.platforms : state.platforms || ['web'],
    integrations: detected.integrations,
    auth: detected.auth,
    payments: detected.payments,
    packageManager: detected.packageManager,
    apps: detected.apps,
  });
  state.profile = { ...(state.profile || {}), detected: detectFeatures(detected, files) };
  return tailor(state, files);
}

// Make the state fit what the app does now: add the steps and checklist
// items that apply, tick what the repo proves, and keep the paperwork on the
// task list in step. Steps and items that stop applying keep their progress
// (hidden), in case the owner turns that part back on.
export function tailor(state, files = []) {
  const features = featuresOf(state);
  for (const step of stepsFor(state.platforms, features)) {
    state.steps[step.id] ||= { status: 'todo', provider: null, note: null, updatedAt: null };
  }

  for (const item of checklistFor(state.platforms, features)) {
    const cur = state.checklist[item.id];
    if (item.auto && autoCheck(item.auto, { integrations: state.integrations || {} }, files)) {
      if (!cur?.done) state.checklist[item.id] = { done: true, by: 'auto', at: now() };
    } else if (!cur) {
      state.checklist[item.id] = { done: false, by: null, at: null };
    }
  }

  // Paperwork with long lead times goes on the task list on day one, once.
  // Open paperwork that no longer applies comes off; finished paperwork stays.
  const paperwork = paperworkFor(state.platforms, features, state.payments || []);
  const fit = new Set(paperwork.map((w) => w.key));
  state.tasks = state.tasks.filter((t) => t.done || !PAPERWORK_KEYS.has(t.key) || fit.has(t.key));
  for (const w of paperwork) {
    if (state.tasks.some((t) => t.key === w.key)) continue;
    const t = addTask(state, w.title, { blocksRelease: w.blocks, key: w.key, leadTime: w.days, url: w.url });
    t.startNow = true;
  }
  return state;
}

// ---------- what the app does (lib/profile.mjs) ----------

// The owner's correction: `on` true or false, or null to go back to what the
// scan found. Setting what the scan found anyway just clears the correction.
export function setFeature(state, id, on) {
  const f = FEATURES.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown feature "${id}". Known: ${FEATURE_IDS.join(', ')}`);
  if (on !== true && on !== false && on !== null) throw new Error('on is true, false, or null for what the scan found');
  state.profile ||= {};
  const set = { ...(state.profile.set || {}) };
  delete set[id];
  state.profile.set = set;
  const auto = featuresOf(state)[id];
  if (on !== null && on !== auto) set[id] = on;
  const now_ = featuresOf(state)[id];
  state.log.push({ at: now(), msg: `${f.label}: ${now_ ? 'yes' : 'no'}${id in set ? ' (set by you)' : ' (as the scan found)'}` });
  return tailor(state);
}

// The owner looked at what Liftoff found and says it's right.
export function confirmProfile(state) {
  state.profile ||= {};
  if (!state.profile.confirmedAt) state.log.push({ at: now(), msg: 'Confirmed what the app does' });
  state.profile.confirmedAt = now();
  return state;
}

// Steps whose needs are not finished yet.
export function waitingOn(state, id, features = featuresOf(state)) {
  const step = STEPS.find((s) => s.id === id);
  if (!step) return [];
  return needsFor(step, state.platforms, features).filter((n) => !['done', 'skipped'].includes(state.steps[n]?.status));
}

// The steps that can run now, in order.
export function nextSteps(state, features = featuresOf(state)) {
  return stepsFor(state.platforms, features)
    .filter((s) => !['done', 'skipped'].includes(state.steps[s.id]?.status) && waitingOn(state, s.id, features).length === 0)
    .map((s) => s.id);
}

// Why a step or checklist item isn't part of this app's launch.
function notHere(state, kind, id, defs) {
  const def = defs.find((x) => x.id === id);
  if (!def) return `${kind} "${id}" doesn't exist`;
  const does = (def.features || []).map((fid) => FEATURES.find((f) => f.id === fid)?.does);
  return def.features && !def.features.some((fid) => featuresOf(state)[fid])
    ? `${kind} "${id}" doesn't apply: this app isn't set as one that ${does.join(' or ')}. If it does, turn that on under "What this app does" (liftoff profile).`
    : `${kind} "${id}" doesn't apply to this app.`;
}

const STALE_MS = 2 * 60 * 60 * 1000;
export function isStale(step, at = Date.now()) {
  return step?.status === 'running' && step.updatedAt && at - Date.parse(step.updatedAt) > STALE_MS;
}

export function setStep(state, id, status, { provider, note, force = false } = {}) {
  const fit = stepsFor(state.platforms, featuresOf(state)).map((s) => s.id);
  if (!state.steps[id] || !fit.includes(id)) throw new Error(`${notHere(state, 'Step', id, STEPS)} Steps: ${fit.join(', ')}`);
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
  const fit = checklistFor(state.platforms, featuresOf(state)).some((c) => c.id === id);
  if (!state.checklist[id] || !fit) throw new Error(notHere(state, 'Checklist item', id, CHECKLIST));
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
// "vercel:project:greenrow", "github:secret:STRIPE_SECRET_KEY").
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
  return step ? needsFor(step, state.platforms, featuresOf(state)) : [];
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
  'preview.url': 'Preview or staging URL in Stripe test mode, where the purchase flow test runs',
  'signup.path': 'Path where a new user signs up (default /), where the purchase test starts',
};

export function setConfig(state, key, value) {
  if (!CONFIG_KEYS[key]) throw new Error(`Unknown setting "${key}". Known: ${Object.keys(CONFIG_KEYS).join(', ')}`);
  state.config ||= {};
  if (value === null || value === '') delete state.config[key];
  else state.config[key] = String(value);
  return state.config;
}

// Everything the Flight Board shows for one app. `accounts` defaults to the
// accounts connected on this machine; Liftoff Cloud passes the signed-in user's.
export function summarize(state, { accounts = listAccounts() } = {}) {
  const features = featuresOf(state);
  const steps = stepsFor(state.platforms, features).map((s) => ({
    id: s.id,
    label: s.label,
    skill: s.skill,
    ...(state.steps[s.id] || { status: 'todo' }),
    waitingOn: waitingOn(state, s.id, features),
    stale: !!isStale(state.steps[s.id]),
  }));
  const items = checklistFor(state.platforms, features).map((c) => ({ ...c, ...(state.checklist[c.id] || { done: false }) }));
  const openTasks = state.tasks.filter((t) => !t.done);
  const blocking = openTasks.filter((t) => t.blocksRelease);
  const stepsDone = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const checksDone = items.filter((i) => i.done).length;
  const needed = accountsFor(state.platforms, features);
  return {
    name: state.name,
    slug: state.slug,
    root: state.root,
    framework: state.framework,
    platforms: state.platforms,
    features,
    profile: profileView(state),
    auth: state.auth || null,
    payments: state.payments || [],
    packageManager: state.packageManager || null,
    apps: state.apps || [],
    liveUrl: state.liveUrl,
    lastVerifiedAt: state.lastVerifiedAt || null,
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
    nextSteps: nextSteps(state, features),
    config: state.config || {},
    pulse: state.pulse?.latest || null,
    accounts: needed.map((id) => accounts.find((a) => a.id === id)).filter(Boolean),
    log: state.log.slice(-20),
    updatedAt: state.updatedAt,
  };
}
