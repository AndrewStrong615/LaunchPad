// Connecting a key asks the service whether it works: one read-only request.
// Only a clear "wrong key" turns it away; trouble reaching the service never does.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ACCOUNTS } from '../../lib/catalog.mjs';
import { checkKey, KEY_CHECKED } from '../lib/key-check.mjs';
import { ACCOUNT_HOSTS, PLAIN_ENV, SIGNING_ENV, VAULT_LIMIT } from '../lib/accounts.mjs';

// A fake service: answers by URL, records what was asked.
function fake(routes) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {}, method: opts.method || 'GET', body: opts.body });
    for (const [match, answer] of routes) {
      if (url.startsWith(match)) {
        const [status, body] = typeof answer === 'function' ? answer(opts) : answer;
        if (status === 'down') throw new Error('ECONNRESET');
        return new Response(JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } });
      }
    }
    throw new Error(`no route for ${url}`);
  };
  return { fetch, calls };
}

test('every service that can be checked is, and every key the sandbox gets fits in one vault', () => {
  for (const id of Object.keys(ACCOUNTS)) {
    if (['apple-developer'].includes(id)) continue; // App Store Connect keys sign their own requests
    assert.ok(KEY_CHECKED.has(id), `${id} is checked when it's connected`);
  }
  const vaulted = Object.entries(ACCOUNTS).flatMap(([id, a]) => (ACCOUNT_HOSTS[id] ? a.env.filter((k) => !PLAIN_ENV.has(k) && !SIGNING_ENV.has(k)) : []));
  assert.ok(vaulted.length <= VAULT_LIMIT, `${vaulted.length} sandbox keys, the vault holds ${VAULT_LIMIT}`);
});

test('a working key passes and says whether it is a test key', async () => {
  const s = fake([['https://api.stripe.com/v1/balance', [200, { object: 'balance' }]]]);
  assert.deepEqual(await checkKey('stripe', { STRIPE_SECRET_KEY: 'sk_test_abc' }, s.fetch), { ok: true, detail: 'The service accepted the key.', mode: 'test' });
  assert.equal((await checkKey('stripe', { STRIPE_SECRET_KEY: 'rk_live_abc' }, s.fetch)).mode, 'live');
  assert.equal(s.calls[0].headers.authorization, 'Bearer sk_test_abc');
});

test('a wrong key is turned away with what to do; a key without some permission is kept', async () => {
  const s = fake([['https://api.stripe.com', [401, {}]], ['https://api.vercel.com', [403, { error: { invalidToken: true } }]], ['https://api.netlify.com', [403, {}]]]);
  const stripe = await checkKey('stripe', { STRIPE_SECRET_KEY: 'sk_test_old' }, s.fetch);
  assert.equal(stripe.ok, false);
  assert.match(stripe.detail, /wrong or was rolled/);
  assert.equal((await checkKey('vercel', { VERCEL_TOKEN: 'x' }, s.fetch)).ok, false, 'Vercel says 403 invalidToken for an expired token');
  const netlify = await checkKey('netlify', { NETLIFY_AUTH_TOKEN: 'nfp_x' }, s.fetch);
  assert.equal(netlify.ok, true);
  assert.match(netlify.detail, /can’t read everything/);
});

test('a service that is down never blocks a connect', async () => {
  const s = fake([['https://api.resend.com', ['down']], ['https://api.sendgrid.com', [503, {}]]]);
  const resend = await checkKey('resend', { RESEND_API_KEY: 're_x' }, s.fetch);
  assert.equal(resend.ok, null);
  assert.match(resend.detail, /Couldn’t reach Resend/);
  assert.equal((await checkKey('sendgrid', { SENDGRID_API_KEY: 'SG.a.b' }, s.fetch)).ok, null);
  assert.equal((await checkKey('nope', {}, s.fetch)).ok, null);
});

test('each service is read the way it answers', async () => {
  // Resend: a sending-only key can't list keys, and says so.
  let s = fake([['https://api.resend.com', [401, { name: 'restricted_api_key' }]]]);
  assert.equal((await checkKey('resend', { RESEND_API_KEY: 're_x' }, s.fetch)).ok, true);
  s = fake([['https://api.resend.com', [403, { name: 'invalid_api_key' }]]]);
  assert.equal((await checkKey('resend', { RESEND_API_KEY: 're_x' }, s.fetch)).ok, false);

  // Paddle: the key's prefix says sandbox or live.
  s = fake([['https://sandbox-api.paddle.com/event-types', [200, { data: [] }]]]);
  assert.equal((await checkKey('paddle', { PADDLE_API_KEY: 'pdl_sdbx_apikey_abc' }, s.fetch)).mode, 'sandbox');
  assert.equal(s.calls.length, 1);
  s = fake([['https://api.paddle.com', [403, { error: { code: 'authentication_malformed' } }]]]);
  assert.equal((await checkKey('paddle', { PADDLE_API_KEY: 'pdl_live_apikey_abc' }, s.fetch)).ok, false);
  // An older key without a prefix may be a sandbox key.
  s = fake([['https://api.paddle.com', [401, {}]], ['https://sandbox-api.paddle.com', [200, {}]]]);
  assert.equal((await checkKey('paddle', { PADDLE_API_KEY: 'a'.repeat(50) }, s.fetch)).mode, 'sandbox');

  // Polar: live first, then sandbox.
  s = fake([['https://api.polar.sh', [401, {}]], ['https://sandbox-api.polar.sh', [200, { items: [] }]]]);
  assert.deepEqual(await checkKey('polar', { POLAR_ACCESS_TOKEN: 'polar_oat_x' }, s.fetch), { ok: true, detail: 'The service accepted the key.', mode: 'sandbox' });
  s = fake([['https://api.polar.sh', [401, {}]], ['https://sandbox-api.polar.sh', [401, {}]]]);
  assert.match((await checkKey('polar', { POLAR_ACCESS_TOKEN: 'polar_oat_x' }, s.fetch)).detail, /either its live or its sandbox/);

  // Expo answers 200 with a GraphQL error for an unknown token.
  s = fake([['https://api.expo.dev/graphql', [200, { errors: [{ extensions: { errorCode: 'UNAUTHORIZED_ERROR' } }] }]]]);
  assert.equal((await checkKey('expo', { EXPO_TOKEN: 'x' }, s.fetch)).ok, false);

  // PostHog and Sentry keys live in one region; the other region is tried.
  s = fake([['https://us.posthog.com', [401, {}]], ['https://eu.posthog.com', [200, {}]]]);
  assert.equal((await checkKey('posthog', { POSTHOG_PERSONAL_API_KEY: 'phx_x' }, s.fetch)).ok, true);

  // Postmark takes its own header.
  s = fake([['https://api.postmarkapp.com/server', [200, {}]]]);
  await checkKey('postmark', { POSTMARK_SERVER_TOKEN: 'x' }, s.fetch);
  assert.equal(s.calls[0].headers['x-postmark-server-token'], 'x');

  // Cloudflare account tokens verify on the account.
  s = fake([['https://api.cloudflare.com/client/v4/user/tokens/verify', [401, {}]], ['https://api.cloudflare.com/client/v4/accounts/acct1/tokens/verify', [200, {}]]]);
  assert.equal((await checkKey('cloudflare', { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'acct1' }, s.fetch)).ok, true);
});

test('a service account key is traded at Google for a token, and only there', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = JSON.stringify({ type: 'service_account', project_id: 'shop', client_email: 'ci@shop.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://evil.example.com/token' });
  let s = fake([['https://oauth2.googleapis.com/token', [200, { access_token: 'ya29.x' }]]]);
  const ok = await checkKey('firebase', { FIREBASE_SERVICE_ACCOUNT_JSON: key }, s.fetch);
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /ci@shop/);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, 'https://oauth2.googleapis.com/token', 'never the token_uri in the file');
  s = fake([['https://oauth2.googleapis.com/token', [400, { error: 'invalid_grant' }]]]);
  assert.equal((await checkKey('firebase', { FIREBASE_SERVICE_ACCOUNT_JSON: key }, s.fetch)).ok, false);
  const broken = JSON.stringify({ ...JSON.parse(key), private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' });
  assert.match((await checkKey('firebase', { FIREBASE_SERVICE_ACCOUNT_JSON: broken }, s.fetch)).detail, /can’t be read/);
  s = fake([['https://oauth2.googleapis.com/token', ['down']]]);
  assert.equal((await checkKey('google-play', { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: key }, s.fetch)).ok, null);
});
