// A fetch for URLs that users control (their live site, a PostHog host, a
// webhook URL Stripe reports). It refuses private, loopback and link-local
// addresses, checks the address actually connected to (so DNS rebinding can't
// slip through), follows redirects itself so every hop is checked, and caps
// response size. Returns a standard Response, so lib/verify.mjs and
// lib/pulse.mjs work unchanged.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

function v4Blocked(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && ip.split('.')[2] === '0') ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function isBlockedAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind !== 6) return true;
  const low = ip.toLowerCase();
  const mapped = low.match(/^(?:::ffff:|::ffff:0:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Blocked(mapped[1]);
  if (low === '::' || low === '::1') return true;
  const first = parseInt(low.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EBLOCKED' }));
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

const NULL_BODY = new Set([101, 204, 205, 304]);

function headersOf(init) {
  const out = {};
  if (!init) return out;
  const h = init instanceof Headers ? init : new Headers(init);
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export function createSafeFetch({ allowPrivate = false, maxBytes = 5 * 1048576, maxRedirects = 5 } = {}) {
  function once(url, { method = 'GET', headers = {}, body, signal }) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error(`Only http and https URLs can be checked (${u.protocol})`));
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (!allowPrivate && net.isIP(host) && isBlockedAddress(host)) return reject(new Error(`${host} is a private address`));
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        u,
        { method, headers: { 'user-agent': 'LiftoffCloud/1.0 (+verify)', ...headers }, lookup: allowPrivate ? undefined : guardedLookup, signal, timeout: 15000 },
        (res) => {
          const chunks = [];
          let size = 0;
          let over = false;
          res.on('data', (c) => {
            if (over) return;
            size += c.length;
            if (size > maxBytes) {
              // Stop reading and fail this request only; never throw on the socket.
              over = true;
              reject(new Error('Response too large'));
              res.destroy();
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (over) return;
            const status = res.statusCode;
            const hdrs = new Headers();
            for (const [k, v] of Object.entries(res.headers)) for (const x of [v].flat()) if (x !== undefined) hdrs.append(k, String(x));
            const payload = NULL_BODY.has(status) || method === 'HEAD' ? null : Buffer.concat(chunks);
            resolve(new Response(payload, { status: status < 200 ? 502 : status, statusText: res.statusMessage, headers: hdrs }));
          });
          res.on('error', (e) => reject(e));
          res.on('close', () => {
            if (!res.complete) reject(new Error('Connection closed early'));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Timed out')));
      req.on('error', reject);
      if (body !== undefined && body !== null) req.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : String(body));
      req.end();
    });
  }

  return async function safeFetch(input, opts = {}) {
    let url = String(input instanceof URL ? input.href : input);
    let method = (opts.method || 'GET').toUpperCase();
    let body = opts.body;
    let headers = headersOf(opts.headers);
    const mode = opts.redirect || 'follow';
    for (let hop = 0; ; hop++) {
      const res = await once(url, { method, headers, body, signal: opts.signal });
      if (![301, 302, 303, 307, 308].includes(res.status) || mode === 'manual') return res;
      if (mode === 'error') throw new Error('Redirect not allowed');
      if (hop >= maxRedirects) throw new Error('Too many redirects');
      const next = new URL(res.headers.get('location') || '', url);
      if (new URL(url).origin !== next.origin) {
        // Never carry credentials to another host.
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase())));
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      url = next.href;
    }
  };
}
