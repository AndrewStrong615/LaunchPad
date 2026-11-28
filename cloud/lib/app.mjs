// Liftoff Cloud's HTTP routes: sign-in, the web app's pages, and the JSON API
// the shared Flight Board front end and the cloud screens call.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addTask, removeTask, setCheck, setConfig, setTaskDone, summarize, CONFIG_KEYS } from '../../lib/state.mjs';
import { nextAction } from '../../lib/advice.mjs';
import { costReport } from '../../lib/costs.mjs';
import { ACCOUNTS, stepsFor } from '../../lib/catalog.mjs';
import { ASSETS } from '../../lib/server.mjs';
import { HttpError, cookie, parseCookies, readJson, readRaw, redirect, send } from './http.mjs';
import { sign, unsign } from './crypto.mjs';
import { connectUserAccount, disconnectUserAccount, listUserAccounts } from './accounts.mjs';
import { githubToken, importFromGitHub, importFromZip, rescan } from './importer.mjs';
import { pulseApp, validateSetting, verifyApp } from './tools.mjs';
import { LIVE, publicRun } from './runs.mjs';
import { MODELS } from './agent.mjs';
import { isRunId, isSlug } from './store.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PAGES = {
  '/cloud.css': ['cloud.css', 'text/css; charset=utf-8'],
  '/cloud.js': ['cloud.js', 'text/javascript; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const SID_COOKIE = 'lc_sid';
const STATE_COOKIE = 'lc_oauth';
const THEMES = ['system', 'light', 'dark'];

// Account settings kept on the user: how the app looks and the model runs
// default to. Anything unknown reads as "not set".
function prefsOf(user) {
  const p = user.prefs || {};
  return {
    theme: THEMES.includes(p.theme) ? p.theme : 'system',
    model: MODELS.some((m) => m.id === p.model) ? p.model : null,
  };
}

// A small fixed-window limiter, per process.
function limiter() {
  const hits = new Map();
  return (key, max, windowMs) => {
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || now - cur.at > windowMs) {
      hits.set(key, { at: now, n: 1 });
      if (hits.size > 10000) for (const [k, v] of hits) if (now - v.at > windowMs) hits.delete(k);
      return;
    }
    if (++cur.n > max) throw new HttpError(429, 'Too many requests. Try again in a minute.');
  };
}

export function createApp(ctx) {
  const { config, store, github, runs } = ctx;
  const originOf = () => new URL(config.publicUrl).origin;
  const limit = limiter();
  const secure = config.secureCookies;

  const accountsOf = (uid) => listUserAccounts(store, uid);

  // Everything the Flight Board shows for one app, plus what the cloud adds.
  function view(uid, state, accounts = accountsOf(uid)) {
    const s = summarize(state, { accounts });
    const all = runs.list(uid, state.slug);
    const latest = all[0] || null;
    const src = state.source || {};
    return {
      ...s,
      root: src.type === 'github' ? `github.com/${src.fullName}@${src.ref}` : src.filename || 'uploaded code',
      nextAction: nextAction(s),
      costs: costReport(s),
      cloud: {
        source: { type: src.type, fullName: src.fullName, url: src.url, ref: src.ref, private: src.private, filename: src.filename, importedAt: src.importedAt, commit: src.commit },
        scan: state.lastScan ? { at: state.lastScan.at, failing: state.lastScan.findings.filter((f) => !f.ok && s.checklist.some((c) => c.id === f.id)) } : null,
        run: latest ? { id: latest.id, status: latest.status, pending: latest.pending.length, cost: latest.cost, pr: latest.pr || null, createdAt: latest.createdAt } : null,
        runs: all.length,
      },
    };
  }

  function appOf(uid, slug) {
    if (!isSlug(slug)) throw new HttpError(404, 'No such app');
    const state = store.loadApp(uid, slug);
    if (!state) throw new HttpError(404, 'No such app');
    return state;
  }

  function signedIn(req) {
    const sid = parseCookies(req)[SID_COOKIE];
    const session = sid && store.getSession(sid);
    const user = session && store.getUser(session.uid);
    return user ? { user, sid } : null;
  }

  function startSession(res, uid, location = '/') {
    const sid = store.createSession(uid);
    redirect(res, location, {
      'set-cookie': [cookie(SID_COOKIE, sid, { maxAge: 30 * 86400, secure }), cookie(STATE_COOKIE, '', { maxAge: 0, secure })],
    });
  }

  function page(res, file) {
    send(res, 200, fs.readFileSync(path.join(PUBLIC, file), 'utf8'), 'text/html; charset=utf-8');
  }

  function devUser() {
    const file = path.join(config.dataDir, 'dev-user.json');
    let uid = null;
    try {
      uid = JSON.parse(fs.readFileSync(file, 'utf8')).uid;
    } catch {}
    let user = uid && store.getUser(uid);
    if (!user) {
      user = store.createUser({ login: 'you', name: 'Local developer', avatar: null, githubId: null });
      fs.writeFileSync(file, JSON.stringify({ uid: user.id }), { mode: 0o600 });
    }
    return user;
  }

  // ---------- sign-in ----------

  async function auth(req, res, url) {
    const ip = req.socket.remoteAddress || 'ip';
    if (url.pathname === '/auth/github' && req.method === 'GET') {
      if (!github.oauthEnabled) throw new HttpError(404, 'GitHub sign-in is not set up on this server.');
      limit(`auth:${ip}`, 30, 60000);
      const state = crypto.randomBytes(16).toString('base64url');
      res.writeHead(302, { location: github.authorizeUrl(state), 'cache-control': 'no-store', 'set-cookie': cookie(STATE_COOKIE, sign(store.keys, state), { maxAge: 600, secure }) });
      return res.end();
    }
    if (url.pathname === '/auth/github/callback' && req.method === 'GET') {
      limit(`auth:${ip}`, 30, 60000);
      const want = unsign(store.keys, parseCookies(req)[STATE_COOKIE] || '');
      const got = url.searchParams.get('state') || '';
      if (!want || want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) return redirect(res, '/login?error=state');
      if (url.searchParams.get('error')) return redirect(res, '/login?error=denied');
      const { token, scope } = await github.exchangeCode(url.searchParams.get('code') || '');
      const gh = await github.getUser(token);
      let user = store.findUserByGithubId(gh.id);
      const profile = { login: gh.login, name: gh.name || gh.login, avatar: gh.avatar_url || null, githubId: gh.id };
      user = user ? store.saveUser({ ...user, ...profile }) : store.createUser(profile);
      const secrets = store.getSecrets(user.id);
      secrets.github = store.encrypt(token);
      secrets.githubScope = scope;
      store.saveSecrets(user.id, secrets);
      return startSession(res, user.id);
    }
    if (url.pathname === '/auth/dev' && req.method === 'POST') {
      if (!config.devLogin) throw new HttpError(404, 'Not found');
      return startSession(res, devUser().id);
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      const me = signedIn(req);
      if (me) store.deleteSession(me.sid);
      return redirect(res, '/login', { 'set-cookie': cookie(SID_COOKIE, '', { maxAge: 0, secure }) });
    }
    throw new HttpError(404, 'Not found');
  }

  // ---------- deleting an account ----------

  // Keys mirrored into Claude's vault go first: if that fails nothing is
  // deleted, so no key is left behind without a record of it. Taking back the
  // GitHub grant is best effort (the person can also do it on GitHub).
  async function deleteAccount(uid) {
    const secrets = store.getSecrets(uid);
    if (secrets.vault?.id) {
      if (runs.client) {
        try {
          await runs.client.beta.vaults.delete(secrets.vault.id);
        } catch (err) {
          if (err?.status !== 404) {
            console.error(`[liftoff-cloud] deleting vault ${secrets.vault.id} for ${uid}:`, err?.message || err);
            throw new HttpError(502, "Couldn't remove your keys from Claude's vault just now, so nothing was deleted. Try again in a minute.");
          }
        }
      } else console.warn(`[liftoff-cloud] ${uid} deleted their account; vault ${secrets.vault.id} is still in the Anthropic account (no API key on this server to delete it).`);
    }
    let token = null;
    try {
      token = secrets.github ? store.decrypt(secrets.github) : null;
    } catch {}
    const githubRevoked = token ? await github.revokeGrant(token).catch(() => false) : null;
    store.deleteUser(uid);
    return { githubRevoked };
  }

  function meModels(uid) {
    return { choices: MODELS, default: runs.defaultModel(uid), server: runs.defaultModel() };
  }

  // ---------- API ----------

  async function api(req, res, url, user, sid) {
    const uid = user.id;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).slice(1);
    const M = req.method;
    const ok = (body) => send(res, 200, body);

    if (parts[0] === 'me' && parts.length === 1 && M === 'GET') {
      const ready = runs.readiness();
      const secrets = store.getSecrets(uid);
      return ok({
        user: { login: user.login, name: user.name, avatar: user.avatar, createdAt: user.createdAt || null, via: user.githubId ? 'github' : 'local' },
        prefs: prefsOf(user),
        github: { signedIn: !!secrets.github, token: !!githubToken(store, uid), oauth: github.oauthEnabled, scope: secrets.github ? secrets.githubScope || '' : null },
        claude: ready,
        models: meModels(uid),
        limits: { uploadMb: Math.round(config.maxUploadBytes / 1048576), runBudgetUsd: config.runBudgetUsd, maxRuns: config.maxRunsPerUser },
        settings: CONFIG_KEYS,
      });
    }

    // ----- Account settings -----
    if (parts[0] === 'me' && parts[1] === 'prefs' && parts.length === 2 && M === 'POST') {
      limit(`prefs:${uid}`, 60, 60000);
      const body = await readJson(req);
      const prefs = prefsOf(user);
      if ('theme' in body) {
        if (!THEMES.includes(body.theme)) throw new HttpError(400, 'Theme is one of: system, light, dark.');
        prefs.theme = body.theme;
      }
      if ('model' in body) {
        if (body.model !== null && !MODELS.some((m) => m.id === body.model)) throw new HttpError(400, `Pick one of these models: ${MODELS.map((m) => m.label).join(', ')}.`);
        prefs.model = body.model;
      }
      const saved = store.saveUser({ ...store.getUser(uid), prefs });
      return ok({ prefs: prefsOf(saved), models: meModels(uid) });
    }
    if (parts[0] === 'me' && parts[1] === 'sign-out-others' && parts.length === 2 && M === 'POST') {
      limit(`sessions:${uid}`, 10, 60000);
      return ok({ ended: store.endSessions(uid, sid) });
    }
    if (parts[0] === 'me' && parts.length === 1 && M === 'DELETE') {
      limit(`delete:${uid}`, 5, 60000);
      const body = await readJson(req);
      if (String(body.confirm || '').trim().toLowerCase() !== String(user.login).toLowerCase()) throw new HttpError(400, `Type ${user.login} to confirm.`);
      if (runs.hasOpenRuns(uid)) throw new HttpError(409, 'Stop your Claude runs first, then delete your account.');
      const done = await deleteAccount(uid);
      return send(res, 200, { deleted: true, ...done }, 'application/json; charset=utf-8', { 'set-cookie': cookie(SID_COOKIE, '', { maxAge: 0, secure }) });
    }

    if (parts[0] === 'accounts') {
      if (M === 'GET' && parts.length === 1) return ok(accountsOf(uid));
      if (parts[1] && !ACCOUNTS[parts[1]]) throw new HttpError(404, 'No such account');
      if (M === 'POST' && parts.length === 2) {
        limit(`acct:${uid}`, 30, 60000);
        const body = await readJson(req);
        connectUserAccount(store, uid, parts[1], body.values || {});
        return ok(accountsOf(uid));
      }
      if (M === 'DELETE' && parts.length === 2) {
        disconnectUserAccount(store, uid, parts[1]);
        return ok(accountsOf(uid));
      }
    }

    if (parts[0] === 'github' && parts[1] === 'repos' && M === 'GET') {
      const token = githubToken(store, uid);
      if (!token) return ok([]);
      limit(`repos:${uid}`, 20, 60000);
      return ok(await github.listRepos(token));
    }

    if (parts[0] === 'import') {
      limit(`import:${uid}`, 20, 3600000);
      if (store.listApps(uid).length >= 50 && !url.searchParams.get('slug')) throw new HttpError(400, 'You have 50 apps. Delete one first.');
      if (parts[1] === 'github' && M === 'POST') {
        const body = await readJson(req);
        const state = await importFromGitHub(ctx, uid, { url: String(body.url || ''), ref: body.ref ? String(body.ref) : null });
        return ok(view(uid, state));
      }
      if (parts[1] === 'zip' && M === 'POST') {
        const type = String(req.headers['content-type'] || '');
        if (!/^application\/(zip|x-zip-compressed|octet-stream)/.test(type)) throw new HttpError(415, 'Upload a .zip file');
        const buffer = await readRaw(req, config.maxUploadBytes);
        const state = importFromZip(ctx, uid, buffer, url.searchParams.get('name') || 'app.zip');
        return ok(view(uid, state));
      }
    }

    if (parts[0] === 'apps') {
      if (parts.length === 1 && M === 'GET') {
        const accounts = accountsOf(uid);
        return ok(store.listApps(uid).map((slug) => store.loadApp(uid, slug)).filter(Boolean).map((s) => view(uid, s, accounts)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
      }
      const slug = parts[1];
      const state = appOf(uid, slug);
      const rest = parts.slice(2);
      const save = (fn) => ok(view(uid, store.updateApp(uid, slug, fn)));

      if (rest.length === 0 && M === 'GET') return ok(view(uid, state));
      if (rest.length === 0 && M === 'DELETE') {
        if (runs.list(uid, slug).some((r) => LIVE.has(r.status) || r.status === 'budget')) throw new HttpError(409, 'Stop the run first.');
        store.deleteApp(uid, slug);
        return ok({ deleted: slug });
      }
      if (rest[0] === 'rescan' && M === 'POST') {
        limit(`import:${uid}`, 20, 3600000);
        return ok(view(uid, await rescan(ctx, uid, slug)));
      }
      if (rest[0] === 'verify' && M === 'POST') {
        limit(`verify:${uid}`, 20, 60000);
        const { state: next } = await verifyApp(ctx, uid, slug);
        return ok(view(uid, next));
      }
      if (rest[0] === 'pulse' && M === 'POST') {
        limit(`verify:${uid}`, 20, 60000);
        return ok(view(uid, await pulseApp(ctx, uid, slug)));
      }
      if (rest[0] === 'tasks') {
        if (M === 'POST' && rest.length === 1) {
          const body = await readJson(req);
          const title = String(body.title || '').trim();
          if (!title) throw new HttpError(400, 'Title required');
          return save((s) => addTask(s, title.slice(0, 200), { blocksRelease: !!body.blocksRelease }));
        }
        if (M === 'POST' && rest[1]) {
          const body = await readJson(req);
          return save((s) => setTaskDone(s, rest[1], body.done !== false));
        }
        if (M === 'DELETE' && rest[1]) return save((s) => removeTask(s, rest[1]));
      }
      if (rest[0] === 'checklist' && rest[1] && M === 'POST') {
        const body = await readJson(req);
        return save((s) => setCheck(s, rest[1], body.done !== false, 'you'));
      }
      if (rest[0] === 'settings' && M === 'POST') {
        const body = await readJson(req);
        const value = validateSetting(String(body.key || ''), body.value);
        return save((s) => setConfig(s, String(body.key), value || null));
      }

      if (rest[0] === 'runs') {
        if (rest.length === 1 && M === 'GET') return ok(runs.list(uid, slug).map((r) => ({ ...publicRun(r), events: undefined })));
        if (rest.length === 1 && M === 'POST') {
          limit(`run:${uid}`, 10, 3600000);
          const body = await readJson(req);
          const run = await runs.start(uid, slug, { steps: body.steps || [], note: body.note || '', model: body.model ? String(body.model) : null });
          return ok(publicRun(run));
        }
        const id = rest[1];
        if (!isRunId(id)) throw new HttpError(404, 'No such run');
        const run = runs.must(uid, slug, id);
        if (rest.length === 2 && M === 'GET') {
          runs.ensureFollowing(run);
          return ok(publicRun(run, Number(url.searchParams.get('after') || 0)));
        }
        if (M === 'POST' && rest.length === 3) {
          limit(`act:${uid}`, 60, 60000);
          const body = await readJson(req);
          if (rest[2] === 'message') return ok(publicRun(await runs.message(uid, slug, id, body.text)));
          if (rest[2] === 'answer') return ok(publicRun(await runs.answer(uid, slug, id, { eventId: body.eventId, text: body.text })));
          if (rest[2] === 'approve') return ok(publicRun(await runs.approve(uid, slug, id, { eventId: body.eventId, allow: body.allow === true, reason: body.reason })));
          if (rest[2] === 'stop') return ok(publicRun(await runs.stop(uid, slug, id)));
          if (rest[2] === 'budget') return ok(publicRun(await runs.raiseBudget(uid, slug, id, body.addUsd)));
        }
        if (M === 'GET' && rest[2] === 'outputs' && rest[3]) {
          const { file, body } = await runs.download(uid, slug, id, rest[3]);
          const name = String(file.filename || 'file').replace(/[^\w.-]/g, '_');
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          return res.end(body);
        }
      }
      if (rest[0] === 'steps' && M === 'GET') return ok(stepsFor(state.platforms).map((s) => ({ id: s.id, label: s.label, does: s.does })));
    }
    throw new HttpError(404, 'Not found');
  }

  // ---------- the handler ----------

  return async function handle(req, res) {
    const origin = originOf();
    const url = new URL(req.url, origin);
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // Writes only from this site's own pages.
        if (req.headers.origin !== origin) throw new HttpError(403, 'Bad origin');
      }
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (url.pathname.startsWith('/auth/')) return await auth(req, res, url);

      if (req.method === 'GET') {
        if (ASSETS[url.pathname]) {
          const [file, type] = ASSETS[url.pathname];
          return send(res, 200, fs.readFileSync(file, 'utf8'), type);
        }
        if (PAGES[url.pathname]) {
          const [file, type] = PAGES[url.pathname];
          return send(res, 200, fs.readFileSync(path.join(PUBLIC, file), 'utf8'), type);
        }
        if (url.pathname === '/login') {
          if (signedIn(req)) return redirect(res, '/');
          return page(res, 'login.html');
        }
        if (url.pathname === '/login/options') return send(res, 200, { github: github.oauthEnabled, dev: config.devLogin });
        if (url.pathname === '/' || url.pathname === '/index.html') {
          if (!signedIn(req)) return redirect(res, '/login');
          return page(res, 'index.html');
        }
      }

      if (url.pathname.startsWith('/api/')) {
        const me = signedIn(req);
        if (!me) throw new HttpError(401, 'Sign in first');
        const zip = url.pathname === '/api/import/zip';
        if (req.method !== 'GET' && !zip && req.headers['content-length'] !== '0' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
          throw new HttpError(415, 'Send JSON');
        }
        return await api(req, res, url, me.user, me.sid);
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      let status = 500;
      let message = 'Something went wrong on the server.';
      if (err instanceof HttpError) [status, message] = [err.status, err.message];
      else if (typeof err?.status === 'number' && err.headers !== undefined) {
        // An Anthropic API error: never pass its status through (a 401 would sign the user out).
        [status, message] = [502, `Claude's service answered ${err.status}: ${String(err.error?.error?.message || err.message).slice(0, 300)}`];
      } else if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) [status, message] = [err.status, err.message];
      else if (err?.constructor === Error && url.pathname.startsWith('/api/apps/')) [status, message] = [400, err.message]; // a rule in lib/state.mjs (unknown step, task…)
      if (status >= 500) console.error(`[liftoff-cloud] ${req.method} ${url.pathname}:`, err?.stack || err);
      return send(res, status, { error: message });
    }
  };
}
