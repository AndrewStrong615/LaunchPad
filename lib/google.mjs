// Google service account sign-in for the checks that ask Google APIs
// (Firebase rules, Google Play): a signed JWT is traded for a short-lived
// access token. The token endpoint is fixed here rather than read from the
// key file, so a key file can never send its signed assertion elsewhere.
import crypto from 'node:crypto';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// The parsed key file, or null when it isn't a service account key.
export function serviceAccount(json) {
  try {
    const j = typeof json === 'string' ? JSON.parse(json) : json;
    return j?.type === 'service_account' && j.client_email && j.private_key ? j : null;
  } catch {
    return null;
  }
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function signedAssertion(sa, scope, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope, aud: GOOGLE_TOKEN_URL, iat, exp: iat + 600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  return `${unsigned}.${sig}`;
}

// An access token for `scope`. Throws with `status` and Google's `code`
// (invalid_grant for a deleted or wrong key) when Google says no.
export async function googleToken(ctx, sa, scope) {
  let assertion;
  try {
    assertion = signedAssertion(sa, scope, ctx.now ?? Date.now());
  } catch {
    throw Object.assign(new Error("the key file's private key can't be read"), { status: 400, code: 'bad_key' });
  }
  const res = await ctx.fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    signal: AbortSignal.timeout(ctx.timeout || 10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw Object.assign(new Error(`Google refused the service account key (${body.error_description || body.error || res.status})`), { status: res.status, code: body.error || null });
  }
  return body.access_token;
}
