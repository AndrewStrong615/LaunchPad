// How Liftoff Cloud talks to its test browser (proof/server.mjs). Every
// request carries
//   x-liftoff-signature: t=<unix seconds>,n=<random nonce>,v1=<hex HMAC-SHA256>
// over "<t>.<n>.<METHOD> <path>.<body>" with the shared LIFTOFF_PROOF_SECRET,
// so only the cloud server can start or steer a test, and a captured request
// can't be sent to another endpoint, sent twice, or reused after five minutes.
import crypto from 'node:crypto';

export const HEADER = 'x-liftoff-signature';
export const MAX_SKEW_S = 300;
export const MIN_SECRET = 32;

const mac = (secret, t, n, method, pathname, body) =>
  crypto.createHmac('sha256', secret).update(`${t}.${n}.${method.toUpperCase()} ${pathname}.${body}`).digest('hex');

export function signRequest(secret, method, pathname, body = '', now = Date.now()) {
  const t = Math.floor(now / 1000);
  const n = crypto.randomBytes(12).toString('base64url');
  return `t=${t},n=${n},v1=${mac(secret, t, n, method, pathname, body)}`;
}

// { ok: true, nonce } or { ok: false, why }. The receiver refuses a nonce it has seen.
export function checkSignature(secret, header, method, pathname, body = '', now = Date.now()) {
  const m = /^t=(\d{1,12}),n=([A-Za-z0-9_-]{16}),v1=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m) return { ok: false, why: 'unsigned request' };
  const t = Number(m[1]);
  if (Math.abs(now / 1000 - t) > MAX_SKEW_S) return { ok: false, why: 'stale signature' };
  const want = Buffer.from(mac(secret, t, m[2], method, pathname, body), 'hex');
  if (!crypto.timingSafeEqual(want, Buffer.from(m[3], 'hex'))) return { ok: false, why: 'bad signature' };
  return { ok: true, nonce: m[2] };
}

// The steps of a purchase test, in order, with the words the Flight Board
// shows. The browser reports the first six; Liftoff Cloud adds the last, the
// check of Stripe's own records that decides the result.
export const STEPS = [
  ['open', 'Open the app'],
  ['sign-up', 'Sign up as a new user'],
  ['checkout', 'Pay with Stripe’s test card'],
  ['pro', 'Pro unlocks'],
  ['cancel', 'Cancel the subscription in Stripe'],
  ['locked', 'Pro locks again'],
  ['stripe', 'Stripe’s records agree'],
];
