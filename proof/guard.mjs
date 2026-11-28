// The test browser's only way out. Chromium runs with this forward proxy as
// its proxy, so every request (pages, scripts, fetches, WebSockets) is
// resolved and connected here, not by Chromium. The proxy refuses private,
// loopback and link-local addresses (checking the address it actually
// connects to, so DNS rebinding can't slip through), single-label and
// .internal names (Render's private network), and every port but 80 and 443.
// A stranger's page in the test can reach the public web and nothing else.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isBlockedAddress } from '../cloud/lib/safe-fetch.mjs';

const PORTS = new Set([80, 443]);
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/;

class Blocked extends Error {}

// Where to connect for host:port, or throw Blocked.
export async function resolveTarget(host, port, { allowPrivate = false, lookup = dns.lookup } = {}) {
  const name = String(host || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!name) throw new Blocked('no host');
  if (!allowPrivate && !PORTS.has(port)) throw new Blocked(`port ${port} is not allowed`);
  if (net.isIP(name)) {
    if (!allowPrivate && isBlockedAddress(name)) throw new Blocked(`${name} is a private address`);
    return { address: name, family: net.isIP(name) };
  }
  if (!allowPrivate && (!name.includes('.') || PRIVATE_NAME.test(name))) throw new Blocked(`${name} is a private name`);
  let addrs;
  try {
    addrs = await lookup(name, { all: true });
  } catch {
    throw new Blocked(`${name} did not resolve`);
  }
  if (!addrs.length) throw new Blocked(`${name} did not resolve`);
  if (!allowPrivate) {
    const bad = addrs.find((a) => isBlockedAddress(a.address));
    if (bad) throw new Blocked(`${name} resolves to a private address`);
  }
  return addrs[0];
}

const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

// Starts the proxy on 127.0.0.1. Returns { url, blocked, close }; `blocked`
// lists what it refused, for the test's report.
export async function startGuard({ allowPrivate = false, lookup } = {}) {
  const blocked = [];
  const sockets = new Set();
  const refuse = (what, e) => {
    if (blocked.length < 50) blocked.push(`${what}: ${e.message}`);
  };

  const server = http.createServer(async (req, res) => {
    // Plain http:// requests arrive with an absolute URL.
    let u;
    try {
      u = new URL(req.url);
      if (u.protocol !== 'http:') throw new Blocked(`${u.protocol} is not proxied`);
    } catch (e) {
      res.writeHead(400).end();
      return;
    }
    let target;
    try {
      target = await resolveTarget(u.hostname, Number(u.port || 80), { allowPrivate, lookup });
    } catch (e) {
      refuse(u.host, e);
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by Liftoff');
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
    const up = http.request({ host: target.address, family: target.family, port: Number(u.port || 80), method: req.method, path: `${u.pathname}${u.search}`, headers: { ...headers, host: u.host }, timeout: 30000 }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timed out')));
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });

  // https:// and WebSockets come as CONNECT host:port tunnels.
  server.on('connect', async (req, client, head) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url || '');
    let target;
    try {
      if (!m) throw new Blocked('bad CONNECT target');
      target = await resolveTarget(m[1], Number(m[2]), { allowPrivate, lookup });
    } catch (e) {
      refuse(req.url, e);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const up = net.connect({ host: target.address, port: Number(m[2]), family: target.family });
    sockets.add(up);
    up.setTimeout(60000, () => up.destroy());
    up.on('close', () => sockets.delete(up));
    up.on('error', () => client.destroy());
    up.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    client.on('close', () => up.destroy());
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('clientError', (e, s) => s.destroy());

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    blocked,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
