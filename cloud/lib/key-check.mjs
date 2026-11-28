// Asking each service whether a key works, when it's connected. One cheap,
// read-only request per service with the key it just got. Only a clear
// "these credentials are wrong" (almost always 401) turns the key away: a key
// that works but lacks a permission (403) is kept, and so is one Liftoff
// couldn't check (the service was down or slow), with a note that says so.
// Returns { ok: true | false | null, detail, mode? } where mode is 'test' /
// 'sandbox' / 'live' when the key says which.
import { ACCOUNTS } from '../../lib/catalog.mjs';
import { googleToken, serviceAccount } from '../../lib/google.mjs';

const TIMEOUT = 8000;
const bearer = (key) => ({ authorization: `Bearer ${key}` });

const works = (detail = 'The service accepted the key.', mode) => ({ ok: true, detail, ...(mode ? { mode } : {}) });
const wrong = (detail) => ({ ok: false, detail });
const unsure = (label) => ({ ok: null, detail: `Couldn’t reach ${label} to check the key. It’s saved, and Verify tries it again.` });

async function ask(fetch, url, headers, opts = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT), redirect: 'manual', ...opts });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

// The usual reading of an answer: 2xx works, 401 is a wrong key, 403 is a
// real key without some permission, anything else couldn't be checked.
function read(r, label, rejected, mode) {
  if (r.status >= 200 && r.status < 300) return works(undefined, mode);
  if (r.status === 401) return wrong(rejected);
  if (r.status === 403) return works(`${label} accepted the key, but it can’t read everything. If a step fails, give it more access.`, mode);
  return unsure(label);
}

const modeOf = (key, live) => (live.test(key) ? 'live' : 'test');

const CHECKS = {
  async stripe({ STRIPE_SECRET_KEY: k }, fetch) {
    return read(await ask(fetch, 'https://api.stripe.com/v1/balance', bearer(k)), 'Stripe', 'Stripe says this key is wrong or was rolled. Copy it again from the API keys page.', modeOf(k, /^(sk|rk)_live_/));
  },
  async paddle({ PADDLE_API_KEY: k }, fetch) {
    const one = (base) => ask(fetch, `${base}/event-types`, bearer(k));
    const sandbox = /^pdl_sdbx_/.test(k);
    let r = await one(sandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com');
    let mode = sandbox ? 'sandbox' : 'live';
    // Older keys have no prefix: a live miss may be a sandbox key.
    if (!/^pdl_/.test(k) && (r.status === 401 || r.status === 403)) {
      const s = await one('https://sandbox-api.paddle.com');
      if (s.status >= 200 && s.status < 300) [r, mode] = [s, 'sandbox'];
    }
    if (r.status === 403 && /^authentication/.test(r.body?.error?.code || '')) r.status = 401;
    return read(r, 'Paddle', 'Paddle didn’t accept this API key. Create one under Developer tools → Authentication.', mode);
  },
  async polar({ POLAR_ACCESS_TOKEN: k }, fetch) {
    const one = (base) => ask(fetch, `${base}/v1/products/?limit=1`, bearer(k));
    const live = await one('https://api.polar.sh');
    if (live.status !== 401) return read(live, 'Polar', '', 'live');
    const sandbox = await one('https://sandbox-api.polar.sh');
    return read(sandbox, 'Polar', 'Polar didn’t accept this token on either its live or its sandbox API. Create an organization access token in Polar’s settings.', 'sandbox');
  },
  async lemonsqueezy({ LEMONSQUEEZY_API_KEY: k }, fetch) {
    return read(await ask(fetch, 'https://api.lemonsqueezy.com/v1/users/me', { ...bearer(k), accept: 'application/vnd.api+json' }), 'Lemon Squeezy', 'Lemon Squeezy didn’t accept this API key.');
  },
  async revenuecat({ REVENUECAT_API_KEY: k }, fetch) {
    return read(await ask(fetch, 'https://api.revenuecat.com/v2/projects?limit=1', bearer(k)), 'RevenueCat', 'RevenueCat didn’t accept this key. Liftoff needs a v2 secret API key (sk_…).');
  },
  async vercel({ VERCEL_TOKEN: k }, fetch) {
    const r = await ask(fetch, 'https://api.vercel.com/v2/user', bearer(k));
    if (r.status === 403 && r.body?.error?.invalidToken) r.status = 401;
    return read(r, 'Vercel', 'Vercel didn’t accept this token. It may have expired: create a new one.');
  },
  async netlify({ NETLIFY_AUTH_TOKEN: k }, fetch) {
    return read(await ask(fetch, 'https://api.netlify.com/api/v1/user', bearer(k)), 'Netlify', 'Netlify didn’t accept this token. Create a personal access token under User settings → Applications.');
  },
  async cloudflare({ CLOUDFLARE_API_TOKEN: k, CLOUDFLARE_ACCOUNT_ID: acct }, fetch) {
    let r = await ask(fetch, 'https://api.cloudflare.com/client/v4/user/tokens/verify', bearer(k));
    // Tokens owned by an account verify on the account instead.
    if ((r.status === 401 || r.status === 400) && acct) r = await ask(fetch, `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(acct)}/tokens/verify`, bearer(k));
    if (r.status === 400) r.status = 401;
    return read(r, 'Cloudflare', 'Cloudflare didn’t accept this API token.');
  },
  async supabase({ SUPABASE_ACCESS_TOKEN: k }, fetch) {
    return read(await ask(fetch, 'https://api.supabase.com/v1/projects', bearer(k)), 'Supabase', 'Supabase didn’t accept this access token. It may have been revoked: create a new one.');
  },
  async neon({ NEON_API_KEY: k }, fetch) {
    return read(await ask(fetch, 'https://console.neon.tech/api/v2/projects?limit=1', bearer(k)), 'Neon', 'Neon didn’t accept this API key.');
  },
  async clerk({ CLERK_SECRET_KEY: k }, fetch) {
    return read(await ask(fetch, 'https://api.clerk.com/v1/users?limit=1', bearer(k)), 'Clerk', 'Clerk didn’t accept this secret key. Copy it again from API keys in the Clerk dashboard.', modeOf(k, /^sk_live_/));
  },
  async posthog({ POSTHOG_PERSONAL_API_KEY: k }, fetch) {
    // Keys belong to one region: US or EU.
    const us = await ask(fetch, 'https://us.posthog.com/api/users/@me/', bearer(k));
    if (us.status !== 401) return read(us, 'PostHog');
    return read(await ask(fetch, 'https://eu.posthog.com/api/users/@me/', bearer(k)), 'PostHog', 'PostHog didn’t accept this personal API key in the US or the EU region.');
  },
  async sentry({ SENTRY_AUTH_TOKEN: k }, fetch) {
    const us = await ask(fetch, 'https://sentry.io/api/0/organizations/', bearer(k));
    if (us.status !== 401) return read(us, 'Sentry');
    return read(await ask(fetch, 'https://de.sentry.io/api/0/organizations/', bearer(k)), 'Sentry', 'Sentry didn’t accept this auth token.');
  },
  async github({ GITHUB_TOKEN: k }, fetch) {
    return read(await ask(fetch, 'https://api.github.com/user', { ...bearer(k), accept: 'application/vnd.github+json', 'user-agent': 'liftoff-cloud' }), 'GitHub', 'GitHub didn’t accept this token. It may have expired.');
  },
  async expo({ EXPO_TOKEN: k }, fetch) {
    const r = await ask(fetch, 'https://api.expo.dev/graphql', { ...bearer(k), 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ query: '{ meActor { id } }' }) });
    // GraphQL answers 200 with an error for a token it doesn't know.
    if ((r.body?.errors || []).some((e) => /UNAUTHORI[SZ]ED|UNAUTHENTICATED/.test(e?.extensions?.errorCode || ''))) r.status = 401;
    return read(r, 'Expo', 'Expo didn’t accept this access token.');
  },
  async resend({ RESEND_API_KEY: k }, fetch) {
    const r = await ask(fetch, 'https://api.resend.com/api-keys', bearer(k));
    // A sending-only key can't list keys, and says so: it's a real key.
    if (r.body?.name === 'restricted_api_key') return works('Resend accepted the key (it can send email only, which is enough).');
    if (r.status === 403 && r.body?.name === 'invalid_api_key') r.status = 401;
    return read(r, 'Resend', 'Resend says this API key is invalid.');
  },
  async sendgrid({ SENDGRID_API_KEY: k }, fetch) {
    return read(await ask(fetch, 'https://api.sendgrid.com/v3/scopes', bearer(k)), 'SendGrid', 'SendGrid didn’t accept this API key.');
  },
  async postmark({ POSTMARK_SERVER_TOKEN: k }, fetch) {
    return read(await ask(fetch, 'https://api.postmarkapp.com/server', { 'x-postmark-server-token': k, accept: 'application/json' }), 'Postmark', 'Postmark didn’t accept this token. Use a Server API token from your server’s API Tokens tab (not the account token).');
  },
  // Service account keys: trading one for an access token proves it's real
  // and not deleted.
  async firebase({ FIREBASE_SERVICE_ACCOUNT_JSON: v }, fetch) {
    return googleCheck(v, 'https://www.googleapis.com/auth/firebase.readonly', fetch, 'Firebase');
  },
  async 'google-play'({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: v }, fetch) {
    return googleCheck(v, 'https://www.googleapis.com/auth/androidpublisher', fetch, 'Google');
  },
};

async function googleCheck(json, scope, fetch, label) {
  const sa = serviceAccount(json);
  if (!sa) return wrong('That isn’t a service account key file.');
  try {
    await googleToken({ fetch, timeout: TIMEOUT }, sa, scope);
    return works(`Google accepted the key for ${sa.client_email}.`);
  } catch (e) {
    if (e.code === 'bad_key') return wrong('The key file’s private key can’t be read. Download a new JSON key.');
    if (e.code === 'invalid_grant' || e.status === 400 || e.status === 401) return wrong(`Google turned this key down: it was deleted or belongs to another project. Download a new JSON key for ${label}.`);
    return unsure('Google');
  }
}

export const KEY_CHECKED = new Set(Object.keys(CHECKS));

// Ask the service. Network trouble never blocks a connect.
export async function checkKey(id, values, fetch) {
  const fn = CHECKS[id];
  if (!fn) return { ok: null, detail: 'Liftoff doesn’t check this key with the service yet.' };
  try {
    return await fn(values, fetch);
  } catch {
    return unsure(ACCOUNTS[id]?.label || id);
  }
}
