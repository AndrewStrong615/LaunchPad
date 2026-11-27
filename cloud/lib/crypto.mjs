// Encryption for stored keys (AES-256-GCM) and signatures for cookies (HMAC),
// both derived from LIFTOFF_CLOUD_SECRET.
import crypto from 'node:crypto';

export function makeKeys(secret) {
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('liftoff-cloud'), Buffer.from(info), 32));
  return { enc: derive('encrypt v1'), mac: derive('sign v1') };
}

export function encrypt(keys, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.enc, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

export function decrypt(keys, box) {
  if (typeof box !== 'string' || !box.startsWith('v1:')) throw new Error('Unreadable secret');
  const raw = Buffer.from(box.slice(3), 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keys.enc, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function sign(keys, value) {
  const mac = crypto.createHmac('sha256', keys.mac).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function unsign(keys, signed) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(keys, value));
  const given = Buffer.from(signed);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? value : null;
}

export const randomId = (prefix = '', bytes = 9) => `${prefix}${crypto.randomBytes(bytes).toString('base64url').replace(/[-_]/g, '').slice(0, bytes + 3).toLowerCase()}`;

export const fingerprint = (...parts) => crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
