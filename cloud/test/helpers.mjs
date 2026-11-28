// Shared test helpers: a tar.gz writer (to fake GitHub tarballs), a test
// server with fakes, and a small signed-in HTTP client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadConfig } from '../lib/config.mjs';
import { startCloud } from '../server.mjs';

export const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'test', 'fixtures');

function header(name, size, type = '0') {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

// entries: [{ name, content }] → gzipped tar, with a pax global header like GitHub's.
export function tarGz(entries) {
  const parts = [];
  const pax = Buffer.from('52 comment=0123456789abcdef0123456789abcdef01234567\n');
  parts.push(header('pax_global_header', pax.length, 'g'), pax, Buffer.alloc((512 - (pax.length % 512)) % 512));
  for (const e of entries) {
    const data = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content);
    parts.push(header(e.name, data.length, e.type || '0'), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

// Every file under dir as [{ name, content }] with a top folder, like a GitHub tarball.
export function treeEntries(dir, top) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push({ name: `${top}/${path.relative(dir, abs).split(path.sep).join('/')}`, content: fs.readFileSync(abs) });
    }
  };
  walk(dir);
  return out;
}

export function tmpDir(prefix = 'lc-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function startTest({ env = {}, fetch, anthropic = null, safeFetch, proof, watch } = {}) {
  const dataDir = tmpDir();
  const config = loadConfig({
    PORT: '0',
    HOST: '127.0.0.1',
    LIFTOFF_DATA_DIR: dataDir,
    LIFTOFF_DEV_LOGIN: '1',
    LIFTOFF_ALLOW_PRIVATE_FETCH: '1',
    ...(anthropic ? { ANTHROPIC_API_KEY: 'test', LIFTOFF_AGENT_ID: 'agent_test', LIFTOFF_ENVIRONMENT_ID: 'env_test' } : {}),
    ...env,
  });
  // The watcher's clock-driven schedule stays off; tests call its tick themselves.
  const started = await startCloud(config, { anthropic, fetch, safeFetch, proof, watch: { autostart: false, ...watch } });
  const port = started.server.address().port;
  // PUBLIC_URL must match the real port for the origin check.
  started.ctx.config.publicUrl = `http://localhost:${port}`;
  const base = `http://localhost:${port}`;
  return { ...started, base, dataDir, config: started.ctx.config };
}

// A signed-in client for the test server.
export async function signIn(base, origin = base) {
  const res = await fetch(`${base}/auth/dev`, { method: 'POST', redirect: 'manual', headers: { origin } });
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => c.startsWith('lc_sid=')).join('; ');
  const call = async (method, pathname, body, headers = {}) => {
    const opts = { method, headers: { cookie, origin, ...headers } };
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) opts.body = body;
      else {
        opts.body = JSON.stringify(body);
        opts.headers['content-type'] = 'application/json';
      }
    } else if (method !== 'GET') opts.headers['content-type'] = 'application/json';
    const r = await fetch(`${base}${pathname}`, opts);
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, body: json, text, headers: r.headers };
  };
  return { cookie, call, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), del: (p) => call('DELETE', p) };
}

export async function until(fn, { timeout = 5000, every = 25 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, every));
  }
}
