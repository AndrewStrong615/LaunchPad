// File storage for Liftoff Cloud. One folder per user under the data folder:
//
//   users/<uid>/user.json              profile (GitHub login, name, avatar)
//   users/<uid>/secrets.json           encrypted keys, GitHub token, vault record
//   users/<uid>/apps/<slug>/state.json the same state the plugin keeps in .liftoff/state.json
//   users/<uid>/apps/<slug>/source/    the imported code, scanned by verify and the pre-scan
//   users/<uid>/apps/<slug>/runs/<id>.json  cloud runs with Claude
//   users/<uid>/apps/<slug>/reports/<id>/   launch reports and their evidence
//   sessions/<sid>.json                sign-in sessions (each names its user)
//   github/<id>.json                   GitHub user id -> uid
//   public/<id>.json                   a shared report or badge link -> { uid, slug }
//   records/runs/<id>.json             anonymous run records (lib/records.mjs), kept after deletes
//
// Writes are atomic (temp file + rename). Everything is read and written
// synchronously, so a read-modify-write never interleaves with another request.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { decrypt, encrypt, randomId } from './crypto.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UID = /^u_[a-z0-9]{6,32}$/;
// Shared links: rp_ for one launch report, bd_ for an app's badge.
export const PUBLIC_ID = /^(rp|bd)_[A-Za-z0-9_-]{20}$/;
const RUN = /^r_[a-z0-9]{6,32}$/;
const SID = /^[A-Za-z0-9_-]{40,64}$/;
const SESSION_DAYS = 30;

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

export const isSlug = (s) => typeof s === 'string' && SLUG.test(s);
export const isRunId = (s) => typeof s === 'string' && RUN.test(s);

export class Store {
  constructor(dataDir, keys) {
    this.dir = dataDir;
    this.keys = keys;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  encrypt(value) {
    return encrypt(this.keys, value);
  }

  decrypt(box) {
    return decrypt(this.keys, box);
  }

  // ---------- users ----------

  userDir(uid) {
    if (!UID.test(uid)) throw new Error('Bad user id');
    return path.join(this.dir, 'users', uid);
  }

  getUser(uid) {
    if (!UID.test(String(uid))) return null;
    return readJson(path.join(this.userDir(uid), 'user.json'));
  }

  saveUser(user) {
    user.updatedAt = new Date().toISOString();
    writeJson(path.join(this.userDir(user.id), 'user.json'), user);
    if (user.githubId) writeJson(path.join(this.dir, 'github', `${Number(user.githubId)}.json`), { uid: user.id });
    return user;
  }

  findUserByGithubId(githubId) {
    const ref = readJson(path.join(this.dir, 'github', `${Number(githubId)}.json`));
    return ref ? this.getUser(ref.uid) : null;
  }

  createUser(fields) {
    const user = { id: randomId('u_', 12), createdAt: new Date().toISOString(), ...fields };
    return this.saveUser(user);
  }

  // ---------- secrets ----------

  getSecrets(uid) {
    return readJson(path.join(this.userDir(uid), 'secrets.json'), { accounts: {}, github: null, vault: null });
  }

  saveSecrets(uid, secrets) {
    writeJson(path.join(this.userDir(uid), 'secrets.json'), secrets);
  }

  // ---------- sign-in sessions ----------

  createSession(uid) {
    const sid = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    writeJson(path.join(this.dir, 'sessions', `${sid}.json`), { uid, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_DAYS * 86_400_000).toISOString() });
    return sid;
  }

  getSession(sid) {
    if (!SID.test(String(sid))) return null;
    const file = path.join(this.dir, 'sessions', `${sid}.json`);
    const s = readJson(file);
    if (!s) return null;
    if (Date.parse(s.expiresAt) < Date.now()) {
      fs.rmSync(file, { force: true });
      return null;
    }
    return s;
  }

  deleteSession(sid) {
    if (SID.test(String(sid))) fs.rmSync(path.join(this.dir, 'sessions', `${sid}.json`), { force: true });
  }

  // Signs one user out everywhere, except the session `keep`. Returns how many ended.
  endSessions(uid, keep = null) {
    const dir = path.join(this.dir, 'sessions');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return 0;
    }
    let ended = 0;
    for (const f of files) {
      const sid = f.slice(0, -5);
      if (sid === keep || !SID.test(sid)) continue;
      if (readJson(path.join(dir, f))?.uid !== uid) continue;
      fs.rmSync(path.join(dir, f), { force: true });
      ended++;
    }
    return ended;
  }

  // Deletes everything kept for one user: profile, keys, apps, imported code,
  // run history and sign-ins.
  deleteUser(uid) {
    const user = this.getUser(uid);
    fs.rmSync(this.userDir(uid), { recursive: true, force: true });
    if (user?.githubId) {
      const ref = path.join(this.dir, 'github', `${Number(user.githubId)}.json`);
      if (readJson(ref)?.uid === uid) fs.rmSync(ref, { force: true });
    }
    this.endSessions(uid);
  }

  // ---------- apps ----------

  appDir(uid, slug) {
    if (!isSlug(slug)) throw new Error('Bad app name');
    return path.join(this.userDir(uid), 'apps', slug);
  }

  sourceDir(uid, slug) {
    return path.join(this.appDir(uid, slug), 'source');
  }

  listApps(uid) {
    try {
      return fs.readdirSync(path.join(this.userDir(uid), 'apps')).filter((s) => isSlug(s) && fs.existsSync(path.join(this.appDir(uid, s), 'state.json')));
    } catch {
      return [];
    }
  }

  loadApp(uid, slug) {
    if (!isSlug(slug)) return null;
    const state = readJson(path.join(this.appDir(uid, slug), 'state.json'));
    if (!state) return null;
    // The plugin's code reads files from state.root; point it at this app's copy.
    state.root = this.sourceDir(uid, slug);
    return state;
  }

  saveApp(uid, state) {
    state.updatedAt = new Date().toISOString();
    const { root, ...rest } = state;
    writeJson(path.join(this.appDir(uid, state.slug), 'state.json'), rest);
    return state;
  }

  // Load, change synchronously, save. Returns the saved state.
  updateApp(uid, slug, fn) {
    const state = this.loadApp(uid, slug);
    if (!state) return null;
    fn(state);
    return this.saveApp(uid, state);
  }

  deleteApp(uid, slug) {
    fs.rmSync(this.appDir(uid, slug), { recursive: true, force: true });
  }

  // ---------- shared links ----------
  // A shared link only points at an app; what it shows lives with the app, so
  // deleting the app or the account takes it down. Dangling links are removed
  // when someone opens them.

  newPublicId(prefix) {
    return `${prefix}_${crypto.randomBytes(15).toString('base64url')}`;
  }

  publish(id, ref) {
    if (!PUBLIC_ID.test(id)) throw new Error('Bad link id');
    writeJson(path.join(this.dir, 'public', `${id}.json`), { uid: ref.uid, slug: ref.slug });
  }

  published(id) {
    if (typeof id !== 'string' || !PUBLIC_ID.test(id)) return null;
    const ref = readJson(path.join(this.dir, 'public', `${id}.json`));
    if (!ref || !UID.test(ref.uid || '') || !isSlug(ref.slug)) return null;
    if (!fs.existsSync(path.join(this.appDir(ref.uid, ref.slug), 'state.json'))) {
      this.unpublish(id);
      return null;
    }
    return ref;
  }

  unpublish(id) {
    if (PUBLIC_ID.test(id)) fs.rmSync(path.join(this.dir, 'public', `${id}.json`), { force: true });
  }

  // ---------- runs ----------

  runFile(uid, slug, id) {
    if (!isRunId(id)) throw new Error('Bad run id');
    return path.join(this.appDir(uid, slug), 'runs', `${id}.json`);
  }

  loadRun(uid, slug, id) {
    if (!isRunId(String(id)) || !isSlug(slug)) return null;
    return readJson(this.runFile(uid, slug, id));
  }

  saveRun(run) {
    run.updatedAt = new Date().toISOString();
    writeJson(this.runFile(run.uid, run.slug, run.id), run);
    return run;
  }

  listRuns(uid, slug) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(this.appDir(uid, slug), 'runs')).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => readJson(path.join(this.appDir(uid, slug), 'runs', f)))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  // Every run on the server that may still need watching (used after a restart).
  allRuns(filter = () => true) {
    const out = [];
    let users = [];
    try {
      users = fs.readdirSync(path.join(this.dir, 'users')).filter((u) => UID.test(u));
    } catch {
      return out;
    }
    for (const uid of users) for (const slug of this.listApps(uid)) for (const run of this.listRuns(uid, slug)) if (filter(run)) out.push(run);
    return out;
  }

  tmpDir() {
    const dir = path.join(this.dir, 'tmp', crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}
