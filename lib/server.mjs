// Flight Board: a local dashboard for every app Liftoff knows about.
// Listens on 127.0.0.1 only. Mutating requests must be same-origin JSON.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addTask, credentialEnv, listAccounts, listProjects, loadState, removeTask, saveState, setCheck, setTaskDone, summarize,
} from './state.mjs';
import { nextAction } from './advice.mjs';
import { costReport } from './costs.mjs';
import { applyVerify, runVerify } from './verify.mjs';
import { walk } from './scan.mjs';
import { collectPulse, recordPulse } from './pulse.mjs';

// Summary plus the derived views the Flight Board shows.
function view(state) {
  const s = summarize(state);
  return { ...s, nextAction: nextAction(s), costs: costReport(s) };
}

const DASHBOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard');
const DASHBOARD = path.join(DASHBOARD_DIR, 'index.html');
// The page's styles and script, shared with Liftoff Cloud.
export const ASSETS = {
  '/board.css': [path.join(DASHBOARD_DIR, 'board.css'), 'text/css; charset=utf-8'],
  '/board.js': [path.join(DASHBOARD_DIR, 'board.js'), 'text/javascript; charset=utf-8'],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

function allApps() {
  return listProjects()
    .map((p) => {
      try {
        return view(loadState(p.root));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appState(slug) {
  const p = listProjects().find((x) => x.slug === slug);
  if (!p) return null;
  return loadState(p.root);
}

export function createHandler({ port }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (req, res) => {
    try {
      // Block DNS-rebinding and cross-site writes.
      if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'Bad host' });
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'Bad origin' });
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'Send JSON' });
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, fs.readFileSync(DASHBOARD, 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && ASSETS[url.pathname]) {
        const [file, type] = ASSETS[url.pathname];
        return send(res, 200, fs.readFileSync(file, 'utf8'), type);
      }
      if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });

      if (req.method === 'GET' && parts[1] === 'apps' && parts.length === 2) return send(res, 200, allApps());
      if (req.method === 'GET' && parts[1] === 'accounts') {
        return send(res, 200, listAccounts().map(({ env, ...a }) => a));
      }

      if (parts[1] === 'apps' && parts[2]) {
        const state = appState(parts[2]);
        if (!state) return send(res, 404, { error: 'No such app' });

        if (req.method === 'GET' && parts.length === 3) return send(res, 200, view(state));

        // Refresh from the real services. Network calls happen server-side with stored keys;
        // no secret ever reaches the page.
        if (req.method === 'POST' && parts[3] === 'verify' && parts.length === 4) {
          applyVerify(state, await runVerify(state, { env: credentialEnv(), files: walk(state.root) }));
          saveState(state);
          return send(res, 200, view(state));
        }
        if (req.method === 'POST' && parts[3] === 'pulse' && parts.length === 4) {
          recordPulse(state, await collectPulse(state, { env: credentialEnv() }));
          saveState(state);
          return send(res, 200, view(state));
        }

        if (parts[3] === 'tasks') {
          if (req.method === 'POST' && parts.length === 4) {
            const body = await readBody(req);
            const title = String(body.title || '').trim();
            if (!title) return send(res, 400, { error: 'Title required' });
            addTask(state, title.slice(0, 200), { blocksRelease: !!body.blocksRelease });
          } else if (req.method === 'POST' && parts[4]) {
            const body = await readBody(req);
            setTaskDone(state, parts[4], body.done !== false);
          } else if (req.method === 'DELETE' && parts[4]) {
            removeTask(state, parts[4]);
          } else return send(res, 405, { error: 'Method not allowed' });
          saveState(state);
          return send(res, 200, view(state));
        }

        if (parts[3] === 'checklist' && parts[4] && req.method === 'POST') {
          const body = await readBody(req);
          setCheck(state, parts[4], body.done !== false, 'you');
          saveState(state);
          return send(res, 200, view(state));
        }
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  };
}

export function startServer({ port = 4810, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createHandler({ port }));
    server.on('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      if (actual !== port) server.removeAllListeners('request').on('request', createHandler({ port: actual }));
      resolve({ server, url: `http://localhost:${actual}` });
    });
  });
}
