#!/usr/bin/env node
// Liftoff's test browser: a private service (no public address) that runs
// one purchase test at a time for Liftoff Cloud. It holds no keys and no
// user data. Liftoff Cloud signs every request (protocol.mjs) and decides
// the result from Stripe's own records, never from this service's word.
//
//   POST /jobs                {url, email, password} → 202 {id}, or 409 when busy
//   GET  /jobs/:id            progress; the result (with screenshots) once done
//   POST /jobs/:id/continue   {cancelled, detail?} or {error} after the cloud
//                             cancelled the subscription
//   POST /jobs/:id/stop
//   GET  /healthz
//
// Settings: PORT (10000), LIFTOFF_PROOF_SECRET (32+ characters, shared with
// Liftoff Cloud). Tests only: LIFTOFF_PROOF_ALLOW_PRIVATE=1 lets the browser
// reach local addresses; LIFTOFF_PROOF_CHECKOUT_HOST stands in for Stripe.
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { checkSignature, HEADER, MAX_SKEW_S, MIN_SECRET } from './protocol.mjs';
import { runPurchase, TIMEOUTS } from './purchase.mjs';

const JOB = /^j_[A-Za-z0-9_-]{16}$/;
const MAX_BODY = 16 * 1024;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// opts: { secret, chromium?, allowPrivate, checkoutHost, timeouts, keepMs }
export function createWorker({ secret, chromium = null, allowPrivate = false, checkoutHost = 'checkout.stripe.com', timeouts = {}, keepMs = 15 * 60000 } = {}) {
  if (!secret || secret.length < MIN_SECRET) throw new Error(`Set LIFTOFF_PROOF_SECRET (${MIN_SECRET}+ random characters, the same as Liftoff Cloud's).`);
  const jobs = new Map();
  const seen = new Map(); // nonces already used, until they'd be stale anyway
  let active = null;
  let browserLib = chromium;

  const sweep = () => {
    const now = Date.now();
    for (const [nonce, until] of seen) if (until < now) seen.delete(nonce);
    for (const [id, j] of jobs) if (j.phase === 'done' && now - j.endedAt > keepMs) jobs.delete(id);
  };
  const timer = setInterval(sweep, 60000);
  timer.unref();

  function publicJob(j) {
    const out = { id: j.id, phase: j.phase, steps: j.steps, sessionId: j.sessionId, startedAt: j.startedAt };
    if (j.phase === 'done') {
      const r = j.result;
      out.result = {
        ok: r.ok, failedAt: r.failedAt, detail: r.detail, sessionId: r.sessionId, refused: r.refused || undefined, crashed: r.crashed || undefined, blocked: r.blocked,
        steps: r.steps.map((s) => ({ name: s.name, ok: s.ok, detail: s.detail, shot: s.shot ? s.shot.toString('base64') : null })),
      };
    }
    return out;
  }

  async function start(body) {
    const url = String(body.url || '');
    let u;
    try {
      u = new URL(url);
    } catch {
      throw Object.assign(new Error('url must be a URL'), { status: 400 });
    }
    if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw Object.assign(new Error('url must be https'), { status: 400 });
    if (u.username || u.password) throw Object.assign(new Error('url must not carry a username or password'), { status: 400 });
    const email = String(body.email || '');
    const password = String(body.password || '');
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email) || password.length < 8 || password.length > 100) throw Object.assign(new Error('email and password are required'), { status: 400 });
    if (active) throw Object.assign(new Error('busy'), { status: 409 });
    if (!browserLib) ({ chromium: browserLib } = await import('playwright'));

    const id = `j_${crypto.randomBytes(12).toString('base64url')}`;
    const abort = new AbortController();
    const job = { id, phase: 'running', steps: [], sessionId: null, startedAt: new Date().toISOString(), abort, resume: null };
    jobs.set(id, job);
    active = job;
    const limit = setTimeout(() => abort.abort(), timeouts.job || TIMEOUTS.job);
    runPurchase({
      chromium: browserLib, url: u.href, email, password, allowPrivate, checkoutHost, timeouts, signal: abort.signal,
      onStep: (steps) => {
        job.steps = steps;
      },
      onWait: (sessionId) => new Promise((resolve) => {
        job.sessionId = sessionId;
        job.phase = 'waiting';
        job.resume = resolve;
        abort.signal.addEventListener('abort', () => resolve({ error: 'Stopped' }), { once: true });
      }),
    })
      .then((result) => {
        job.result = result;
      }, (e) => {
        job.result = { ok: false, failedAt: 'open', detail: `The test browser failed: ${e.message}`, steps: [], crashed: true };
      })
      .finally(() => {
        clearTimeout(limit);
        job.phase = 'done';
        job.endedAt = Date.now();
        job.resume = null;
        if (active === job) active = null;
      });
    return job;
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://worker');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, busy: !!active });
      const raw = req.method === 'GET' ? '' : await readBody(req);
      const check = checkSignature(secret, req.headers[HEADER], req.method, url.pathname, raw);
      if (!check.ok) return send(res, 401, { error: check.why });
      if (seen.has(check.nonce)) return send(res, 401, { error: 'replayed request' });
      seen.set(check.nonce, Date.now() + MAX_SKEW_S * 2000);
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: 'Send JSON' });
        }
      }

      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'jobs') return send(res, 404, { error: 'Not found' });
      if (parts.length === 1 && req.method === 'POST') {
        const job = await start(body);
        return send(res, 202, { id: job.id });
      }
      const job = JOB.test(parts[1] || '') && jobs.get(parts[1]);
      if (!job) return send(res, 404, { error: 'No such job' });
      if (parts.length === 2 && req.method === 'GET') return send(res, 200, publicJob(job));
      if (parts[2] === 'continue' && req.method === 'POST') {
        if (job.phase !== 'waiting' || !job.resume) return send(res, 409, { error: 'The job is not waiting' });
        const answer = body.error ? { error: String(body.error).slice(0, 300) } : { cancelled: body.cancelled === true, detail: body.detail ? String(body.detail).slice(0, 300) : undefined };
        job.phase = 'running';
        job.resume(answer);
        job.resume = null;
        return send(res, 200, publicJob(job));
      }
      if (parts[2] === 'stop' && req.method === 'POST') {
        job.abort.abort();
        return send(res, 200, { id: job.id, stopping: job.phase !== 'done' });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : 'The test browser hit an error' });
      if (!e.status) console.error('[liftoff-proof]', e);
    }
  };

  const server = http.createServer(handler);
  server.requestTimeout = 30000;
  return {
    server,
    jobs,
    get busy() {
      return !!active;
    },
    close: async () => {
      clearInterval(timer);
      for (const j of jobs.values()) j.abort.abort();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const env = process.env;
  const production = env.NODE_ENV === 'production';
  const worker = createWorker({
    secret: env.LIFTOFF_PROOF_SECRET,
    allowPrivate: env.LIFTOFF_PROOF_ALLOW_PRIVATE === '1' && !production,
    checkoutHost: (!production && env.LIFTOFF_PROOF_CHECKOUT_HOST) || 'checkout.stripe.com',
  });
  const port = Number(env.PORT || 10000);
  worker.server.listen(port, '0.0.0.0', () => console.log(`Liftoff test browser listening on :${port}`));
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, async () => {
      await worker.close();
      process.exit(0);
    });
  }
}
