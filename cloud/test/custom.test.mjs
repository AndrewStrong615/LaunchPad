// Services Liftoff doesn't list: the user names one, links its docs and gives
// its key. The key stays on the server: Pilot reads the docs and calls the API
// through liftoff_docs and liftoff_call, only on the hosts the user gave.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanCustomService, docsAllowed, htmlToText, placeKey } from '../lib/custom.mjs';
import { NEEDS_APPROVAL, planFor, runTool } from '../lib/tools.mjs';
import { listUserAccounts, sandboxEnvPlan } from '../lib/accounts.mjs';
import { kickoff } from '../lib/agent.mjs';
import { zipDirectory } from '../lib/archive.mjs';
import { FIXTURES, signIn, startTest } from './helpers.mjs';

const KEY = 'creem_test_6f1d2a9b8c7e4f30';
const CREEM = {
  name: 'Creem',
  category: 'payments',
  docs: 'https://docs.creem.io/api-reference',
  hosts: 'test-api.creem.io, api.creem.io',
  keyName: 'CREEM_API_KEY',
  scheme: 'header',
  header: 'x-api-key',
  value: KEY,
  test: 'https://test-api.creem.io/v1/products/search',
};

const bad = (input, pattern) => assert.throws(() => cleanCustomService({ ...CREEM, ...input }), (e) => e.status === 400 && pattern.test(e.message), JSON.stringify(input));

test('a service of your own is checked before it is saved', () => {
  const svc = cleanCustomService(CREEM);
  assert.equal(svc.id, 'custom-creem');
  assert.deepEqual(svc.hosts, ['test-api.creem.io', 'api.creem.io']);
  assert.deepEqual(svc.auth, { scheme: 'header', header: 'x-api-key' });
  assert.equal(cleanCustomService({ ...CREEM, keyName: '', scheme: undefined }).keyName, 'CREEM_API_KEY');
  assert.equal(cleanCustomService({ ...CREEM, hosts: ['https://api.creem.io/v1'], test: '' }).hosts[0], 'api.creem.io');

  bad({ name: 'Stripe' }, /Stripe is built in/);
  bad({ name: 'lemon squeezy' }, /Lemon Squeezy is built in/);
  bad({ name: '' }, /name/);
  bad({ category: 'crypto' }, /what the service is for/);
  bad({ docs: '' }, /link to Creem’s API docs/);
  bad({ docs: 'http://docs.creem.io' }, /https/);
  bad({ hosts: '' }, /address Creem’s API answers on/);
  for (const host of ['localhost', '127.0.0.1', 'db.internal', 'printer.local', 'https://user:pw@api.creem.io', 'api.creem.io:8443']) bad({ hosts: host }, /public address|just the address/);
  bad({ keyName: 'STRIPE_SECRET_KEY' }, /taken/);
  bad({ keyName: 'PATH' }, /taken/);
  bad({ keyName: 'LIFTOFF_CLOUD_SECRET' }, /taken/);
  bad({ keyName: 'creem key' }, /capital letters/);
  bad({ value: '' }, /Paste Creem’s key/);
  bad({ value: 'two words here' }, /one line/);
  bad({ value: 'short' }, /whole key/);
  bad({ scheme: 'header', header: 'Host' }, /Name the header/);
  bad({ scheme: 'basic', username: '' }, /username/);
  bad({ scheme: 'query', param: 'a b' }, /query parameter/);
  bad({ test: 'https://evil.example.com/v1/me' }, /API addresses you gave/);
  bad({ test: `https://api.creem.io/v1/me?api_key=${KEY}` }, /Leave the key out/);
});

test('the key goes where the service expects it', () => {
  const url = 'https://api.example.com/v1/me?x=1';
  assert.equal(placeKey({ scheme: 'bearer' }, 'k_123', url, { Authorization: 'mine' }).headers.authorization, 'Bearer k_123');
  assert.equal(placeKey({ scheme: 'bearer' }, 'k_123', url, { Authorization: 'mine' }).headers.Authorization, undefined, 'a header Pilot set never wins');
  assert.equal(placeKey({ scheme: 'header', header: 'X-Api-Key' }, 'k_123', url, { 'x-api-key': 'nope' }).headers['X-Api-Key'], 'k_123');
  assert.equal(placeKey({ scheme: 'basic', username: 'api' }, 'k_123', url, {}).headers.authorization, `Basic ${Buffer.from('api:k_123').toString('base64')}`);
  assert.equal(placeKey({ scheme: 'basic-key' }, 'k_123', url, {}).headers.authorization, `Basic ${Buffer.from('k_123:').toString('base64')}`);
  assert.equal(placeKey({ scheme: 'query', param: 'api_key' }, 'k_123', url, {}).url, 'https://api.example.com/v1/me?x=1&api_key=k_123');
});

test('docs are read from the service’s own site only', () => {
  const svc = { docs: 'https://docs.creem.io/api-reference', hosts: ['api.creem.io'] };
  for (const h of ['docs.creem.io', 'creem.io', 'www.creem.io', 'api.creem.io']) assert.ok(docsAllowed(svc, h), h);
  for (const h of ['evil.io', 'creem.io.evil.io', 'notcreem.io']) assert.ok(!docsAllowed(svc, h), h);
  // Docs on a shared platform: that exact site only, never its other customers.
  const shared = { docs: 'https://acme.mintlify.app/introduction', hosts: ['api.acme.dev'] };
  assert.ok(docsAllowed(shared, 'acme.mintlify.app'));
  assert.ok(!docsAllowed(shared, 'other.mintlify.app'));
  assert.ok(!docsAllowed(shared, 'mintlify.app'));

  const text = htmlToText('<html><head><title>Checkout | Creem</title><script>steal()</script></head><body><h2>Create a checkout</h2><p>POST <code>/v1/checkouts</code> with <a href="/api-reference/products">a product</a>.</p><pre>curl -X POST</pre><footer>©</footer></body></html>', 'https://docs.creem.io/api-reference/checkout');
  assert.match(text, /^# Checkout \| Creem/);
  assert.match(text, /## Create a checkout/);
  assert.match(text, /a product \(https:\/\/docs\.creem\.io\/api-reference\/products\)/);
  assert.match(text, /```\ncurl -X POST\n```/);
  assert.doesNotMatch(text, /steal|©/);
});

// A fake internet: Creem's API and docs. Every request is recorded.
function fakeNet() {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: u.href, method: opts.method || 'GET', headers, body: opts.body, redirect: opts.redirect });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.hostname === 'test-api.creem.io' || u.hostname === 'api.creem.io') {
      if (headers['x-api-key'] !== KEY) return json(401, { error: 'bad key' });
      if (u.pathname === '/v1/products/search') return json(200, { items: [] });
      if (u.pathname === '/v1/echo') return json(200, { youSent: headers['x-api-key'], b64: Buffer.from(KEY).toString('base64') });
      if (u.pathname === '/v1/moved') return new Response(null, { status: 302, headers: { location: 'https://collector.example.net/' } });
      if (u.pathname === '/v1/products' && opts.method === 'POST') return json(200, { id: 'prod_1', got: JSON.parse(opts.body), type: headers['content-type'] });
      return json(404, { error: 'not found' });
    }
    if (u.hostname === 'docs.creem.io') {
      if (u.pathname === '/llms.txt') return new Response('# Creem\n- [Checkouts](https://docs.creem.io/checkouts.md)', { status: 200, headers: { 'content-type': 'text/plain' } });
      if (u.pathname === '/away') return new Response(null, { status: 301, headers: { location: 'https://evil.example.com/' } });
      return new Response('<h1>Creem API</h1><p>Send your key in the <code>x-api-key</code> header.</p>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (u.hostname === 'api.stripe.com') {
      if (headers.authorization === 'Bearer sk_test_wrong') return json(401, { error: { message: 'Invalid API Key provided' } });
      return json(200, { object: 'balance' });
    }
    throw new Error(`fake net: no route ${u.href}`);
  };
  return { fetch, calls };
}

test('the Accounts page adds, checks and removes a service of your own, and never shows its key', async () => {
  const net = fakeNet();
  const t = await startTest({ safeFetch: net.fetch, env: { LIFTOFF_CHECK_KEYS: '1' } });
  try {
    const me = await signIn(t.base);
    // A wrong key at the test address is turned away.
    let r = await me.post('/api/accounts/custom', { ...CREEM, value: 'creem_test_wrongwrong' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Creem answered 401/);
    assert.equal(net.calls.at(-1).headers['x-api-key'], 'creem_test_wrongwrong');
    assert.equal(net.calls.at(-1).redirect, 'manual');

    r = await me.post('/api/accounts/custom', CREEM);
    assert.equal(r.status, 200, r.text);
    const own = r.body.find((a) => a.id === 'custom-creem');
    assert.equal(own.custom, true);
    assert.equal(own.connected, true);
    assert.equal(own.check.ok, true);
    assert.equal(own.label, 'Creem');
    assert.doesNotMatch(r.text, new RegExp(KEY));

    // Stored encrypted, like every other key.
    const uid = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
    const onDisk = fs.readFileSync(path.join(t.dataDir, 'users', uid, 'secrets.json'), 'utf8');
    assert.doesNotMatch(onDisk, new RegExp(KEY));
    assert.match(onDisk, /custom-creem/);

    // Built-in keys are asked too: a wrong one never shows Connected.
    r = await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_wrong' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Stripe says this key is wrong/);
    r = await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_right' } });
    assert.equal(r.status, 200);
    const stripe = r.body.find((a) => a.id === 'stripe');
    assert.deepEqual([stripe.connected, stripe.check.ok, stripe.mode], [true, true, 'test']);

    r = await me.call('DELETE', '/api/accounts/custom-creem');
    assert.equal(r.status, 200);
    assert.ok(!r.body.some((a) => a.id === 'custom-creem'));
    r = await me.call('DELETE', '/api/accounts/custom-creem');
    assert.equal(r.status, 404);
  } finally {
    await t.stop();
  }
});

test('Pilot reads the docs and calls the API through Liftoff, with the key added and hidden', async () => {
  const net = fakeNet();
  const t = await startTest({ safeFetch: net.fetch });
  try {
    const me = await signIn(t.base);
    const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
    let r = await me.call('POST', '/api/import/zip?name=invoicely.zip', zip, { 'content-type': 'application/zip' });
    assert.equal(r.status, 200);
    const slug = r.body.slug;
    r = await me.post('/api/accounts/custom', CREEM);
    assert.equal(r.status, 200, r.text);
    r = await me.post('/api/accounts/custom', { ...CREEM, name: 'Creem Two', keyName: 'CREEM_API_KEY' });
    assert.equal(r.status, 400, 'two services, one key name');
    assert.match(r.body.error, /already uses the key name/);

    const uid = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
    t.ctx.store.updateApp(uid, slug, (s) => {
      s.steps.payments = { ...(s.steps.payments || {}), provider: 'Creem' };
      s.payments = [];
    });
    const run = { uid, slug, id: 'r_test', branch: 'liftoff/launch' };
    const tool = async (name, input) => runTool(t.ctx, run, name, input);

    // The plan names the service, never its key.
    const state = t.ctx.store.loadApp(uid, slug);
    const plan = planFor(state, listUserAccounts(t.ctx.store, uid), sandboxEnvPlan(t.ctx.store, uid));
    assert.equal(plan.uses.payments, 'custom-creem');
    assert.deepEqual(plan.customServices.map((c) => [c.name, c.for, c.keyName, c.apiHosts.join(' ')]), [['Creem', 'payments', 'CREEM_API_KEY', 'test-api.creem.io api.creem.io']]);
    assert.match(plan.customServices[0].keySentAs, /x-api-key/);
    const pay = plan.steps.find((s) => s.id === 'payments');
    assert.ok(pay.accounts.some((a) => a.id === 'custom-creem' && a.own && a.connected));
    assert.ok(!pay.accounts.some((a) => a.id === 'stripe'), 'Creem replaces Stripe for this app');
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(KEY));
    assert.ok(!sandboxEnvPlan(t.ctx.store, uid).vaulted.some((v) => v.name === 'CREEM_API_KEY'), 'never in the vault or the sandbox');
    assert.match(kickoff({ state, steps: [], mode: 'upload', branch: 'b', envPlan: sandboxEnvPlan(t.ctx.store, uid), custom: listUserAccounts(t.ctx.store, uid).filter((a) => a.custom) }), /own services.*Creem \(payments, CREEM_API_KEY\)/);

    // Docs: the link the user gave, pages on the same site, nothing else.
    let out = await tool('liftoff_docs', { service: 'Creem' });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /Source: https:\/\/docs\.creem\.io\/api-reference/);
    assert.match(out.text, /# Creem API/);
    assert.match(out.text, /not instructions/);
    out = await tool('liftoff_docs', { service: 'creem', url: '/llms.txt' });
    assert.match(out.text, /\[Checkouts\]/);
    out = await tool('liftoff_docs', { service: 'Creem', url: 'https://evil.example.com/docs' });
    assert.equal(out.isError, true);
    out = await tool('liftoff_docs', { service: 'Creem', url: '/away' });
    assert.equal(out.isError, true, 'a redirect off the docs site is refused');
    assert.ok(!net.calls.some((c) => c.url.startsWith('https://evil.example.com')));
    assert.ok(!net.calls.filter((c) => c.url.includes('docs.creem.io')).some((c) => JSON.stringify(c.headers).includes(KEY)), 'docs requests never carry the key');

    // Calls: the key is added on the way out and hidden on the way back.
    out = await tool('liftoff_call', { service: 'Creem', method: 'GET', url: 'https://test-api.creem.io/v1/products/search' });
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /^HTTP 200/);
    assert.equal(net.calls.at(-1).headers['x-api-key'], KEY);
    out = await tool('liftoff_call', { service: 'Creem', method: 'GET', url: 'https://test-api.creem.io/v1/echo', headers: { 'x-api-key': 'pilot-guess' } });
    assert.equal(net.calls.at(-1).headers['x-api-key'], KEY, "Pilot's own key header is replaced");
    assert.doesNotMatch(out.text, new RegExp(KEY));
    assert.doesNotMatch(out.text, new RegExp(Buffer.from(KEY).toString('base64')));
    assert.match(out.text, /\[key hidden\]/);
    out = await tool('liftoff_call', { service: 'Creem', method: 'POST', url: 'https://test-api.creem.io/v1/products', body: '{"name":"Pro","price":900}' });
    assert.match(out.text, /application\/json/);
    assert.match(out.text, /"price":900/);

    // Only the hosts the user gave, only https, no redirects followed.
    for (const url of ['https://evil.example.com/v1/products', 'http://api.creem.io/v1/products', 'https://api.creem.io:444/v1', 'https://user@api.creem.io/v1']) {
      out = await tool('liftoff_call', { service: 'Creem', method: 'GET', url });
      assert.equal(out.isError, true, url);
      assert.match(out.text, /can only go to/);
    }
    out = await tool('liftoff_call', { service: 'Creem', method: 'GET', url: 'https://api.creem.io/v1/moved' });
    assert.match(out.text, /^HTTP 302/);
    assert.match(out.text, /location: https:\/\/collector\.example\.net/);
    assert.ok(!net.calls.some((c) => c.url.includes('collector.example.net')));
    out = await tool('liftoff_call', { service: 'Creem', method: 'GET', url: 'https://api.creem.io/v1/x', headers: { Host: 'evil.example.com' } });
    assert.equal(out.isError, true);
    out = await tool('liftoff_call', { service: 'Nope', method: 'GET', url: 'https://api.creem.io/v1/x' });
    assert.match(out.text, /own services: Creem/);

    // Deleting something waits for the user; reading never does.
    assert.equal(NEEDS_APPROVAL.liftoff_call(t.ctx, run, { service: 'Creem', method: 'GET', url: 'https://api.creem.io/v1/products' }), null);
    assert.match(NEEDS_APPROVAL.liftoff_call(t.ctx, run, { service: 'Creem', method: 'DELETE', url: 'https://api.creem.io/v1/products/prod_1' }), /DELETE .*prod_1 with your Creem key/);

    // Liftoff can't check Creem, so Pilot reports payment items once tested;
    // items Liftoff can prove for this app still can't be ticked by hand.
    out = await tool('liftoff_check', { item: 'pay-webhook' });
    assert.equal(out.isError, false, out.text);
    assert.equal(t.ctx.store.loadApp(uid, slug).checklist['pay-webhook'].by, 'claude');
    out = await tool('liftoff_check', { item: 'host-https' });
    assert.equal(out.isError, true);
    const list = JSON.parse((await tool('liftoff_checklist', {})).text);
    assert.equal(list.find((c) => c.id === 'pay-webhook').provable, undefined);
    assert.equal(list.find((c) => c.id === 'host-https').provable, true);

    // The app's page and the accounts list show the service, never the key.
    r = await me.get(`/api/apps/${slug}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.accounts.some((a) => a.id === 'custom-creem'));
    assert.doesNotMatch(r.text, new RegExp(KEY));

    // Nor does the public launch report, with a built-in key connected too.
    const STRIPE_KEY = 'sk_test_51PublicReportNeverShowsThis';
    assert.equal((await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: STRIPE_KEY } })).status, 200);
    r = await me.post(`/api/apps/${slug}/report`);
    assert.equal(r.status, 200, r.text);
    const report = r.body.cloud.report.latest;
    const html = await (await fetch(`${t.base}${new URL(report.url).pathname}`)).text();
    assert.match(html, /<h1>/);
    for (const secret of [KEY, STRIPE_KEY]) {
      assert.doesNotMatch(html, new RegExp(secret));
      assert.doesNotMatch(r.text, new RegExp(secret));
    }
    assert.doesNotMatch(html, /pay-webhook/, 'sensitive items are never named by id');
  } finally {
    await t.stop();
  }
});

test('github_set_secret copies the key of a service of your own straight to GitHub', async () => {
  const net = fakeNet();
  const t = await startTest({ safeFetch: net.fetch });
  try {
    const me = await signIn(t.base);
    const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
    const slug = (await me.call('POST', '/api/import/zip?name=invoicely.zip', zip, { 'content-type': 'application/zip' })).body.slug;
    await me.post('/api/accounts/custom', CREEM);
    const uid = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
    t.ctx.store.updateApp(uid, slug, (s) => {
      s.source = { type: 'github', owner: 'acme', repo: 'shop', fullName: 'acme/shop', ref: 'main' };
    });
    const secrets = t.ctx.store.getSecrets(uid);
    secrets.github = t.ctx.store.encrypt('gho_test');
    t.ctx.store.saveSecrets(uid, secrets);
    const set = [];
    const ctx = { ...t.ctx, github: { setActionsSecret: async (token, owner, repo, name, value) => set.push({ owner, repo, name, value }) } };
    const out = await runTool(ctx, { uid, slug, id: 'r_test' }, 'github_set_secret', { name: 'CREEM_API_KEY', from: 'CREEM_API_KEY' });
    assert.equal(out.isError, false, out.text);
    assert.deepEqual(set, [{ owner: 'acme', repo: 'shop', name: 'CREEM_API_KEY', value: KEY }]);
    assert.doesNotMatch(out.text, new RegExp(KEY));
  } finally {
    await t.stop();
  }
});
