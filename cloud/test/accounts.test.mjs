// Connecting a service: a key that can't be right is turned away when it's
// typed, with what the right one looks like, instead of showing Connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyProblem } from '../lib/accounts.mjs';
import { signIn, startTest } from './helpers.mjs';

test('keys that look right pass, and the wrong kind of key says why', () => {
  for (const [name, value] of [
    ['STRIPE_SECRET_KEY', 'sk_test_51HxYzAbCdEf'],
    ['STRIPE_SECRET_KEY', 'sk_live_51HxYzAbCdEf'],
    ['STRIPE_SECRET_KEY', 'rk_test_51HxYzAbCdEf'],
    ['GITHUB_TOKEN', 'github_pat_11ABCDEF_abcdef'],
    ['GITHUB_TOKEN', 'ghp_abcdefABCDEF123456'],
    ['RESEND_API_KEY', 're_123abc_XYZ'],
    ['SUPABASE_ACCESS_TOKEN', 'sbp_0123456789abcdef'],
    ['POSTHOG_PERSONAL_API_KEY', 'phx_abcDEF123'],
    ['SENTRY_AUTH_TOKEN', 'sntryu_abc123'],
    ['REVENUECAT_API_KEY', 'sk_abcDEF123'],
    ['VERCEL_TOKEN', 'AbCdEf0123456789'],
    ['APP_STORE_CONNECT_KEY_ID', 'ABC123DEFG'],
    ['APP_STORE_CONNECT_ISSUER_ID', '57246542-96fe-1a63-e053-0824d011072a'],
    ['APP_STORE_CONNECT_KEY', '-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----'],
    ['GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', JSON.stringify({ type: 'service_account', client_email: 'ci@x.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----' })],
  ]) assert.equal(keyProblem(name, value), null, `${name} ${value}`);

  assert.match(keyProblem('STRIPE_SECRET_KEY', 'my stripe key'), /start with sk_test_ or sk_live_/);
  assert.match(keyProblem('STRIPE_SECRET_KEY', 'pk_test_51HxYz'), /publishable key/);
  assert.match(keyProblem('POSTHOG_PERSONAL_API_KEY', 'phc_abc'), /project key/);
  assert.match(keyProblem('REVENUECAT_API_KEY', 'appl_abc'), /public app key/);
  assert.match(keyProblem('GITHUB_TOKEN', 'hunter2'), /github_pat_/);
  assert.match(keyProblem('VERCEL_TOKEN', 'two words'), /one line with no spaces/);
  assert.match(keyProblem('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', '{"type":"user"}'), /isn’t a service account key/);
});

test('the Connect dialog shows what each key looks like, and a wrong key never shows Connected', async () => {
  const t = await startTest();
  try {
    const me = await signIn(t.base);
    let r = await me.get('/api/accounts');
    assert.equal(r.body.find((a) => a.id === 'stripe').hints.STRIPE_SECRET_KEY, 'sk_test_… or sk_live_…');
    r = await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'my stripe key' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /isn’t a Stripe secret key/);
    r = await me.get('/api/accounts');
    assert.equal(r.body.find((a) => a.id === 'stripe').connected, false);
  } finally {
    await t.stop();
  }
});
