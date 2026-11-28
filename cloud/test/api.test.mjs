import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sodium from 'libsodium-wrappers';
import { ACCOUNTS } from '../../lib/catalog.mjs';
import { zipDirectory } from '../lib/archive.mjs';
import { fakeAnthropic } from './fake-anthropic.mjs';
import { FIXTURES, signIn, startTest, tarGz, treeEntries, until } from './helpers.mjs';

await sodium.ready;
const repoKeys = sodium.crypto_box_keypair();

// A fake GitHub (OAuth + REST) behind the fetch the server uses for GitHub.
function fakeGitHub() {
  const gh = { pulls: [], secrets: {}, tokens: [] };
  gh.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const auth = opts.headers?.authorization || '';
    if (auth) gh.tokens.push(auth);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const p = u.pathname;
    if (u.host === 'github.com' && p === '/login/oauth/access_token') return json(200, { access_token: 'gho_testtoken', scope: 'repo,read:user' });
    if (p === '/user') return json(200, { id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/42' });
    if (p === '/user/repos') return json(200, [{ full_name: 'acme/shop', owner: { login: 'acme' }, name: 'shop', private: true, default_branch: 'main', pushed_at: '2026-11-01T00:00:00Z', description: null, html_url: 'https://github.com/acme/shop' }]);
    if (p === '/repos/acme/shop') return json(200, { owner: { login: 'acme' }, name: 'shop', full_name: 'acme/shop', html_url: 'https://github.com/acme/shop', default_branch: 'main', private: true });
    if (p === '/repos/acme/shop/tarball/main') return new Response(tarGz(treeEntries(path.join(FIXTURES, 'next-saas'), 'acme-shop-abc123')), { status: 200 });
    if (p === '/repos/acme/shop/commits/main') return json(200, { sha: 'abc123' });
    if (p === '/repos/acme/shop/pulls' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      gh.pulls.push(body);
      return json(201, { number: 7, html_url: 'https://github.com/acme/shop/pull/7', draft: body.draft });
    }
    if (p === '/repos/acme/shop/actions/secrets/public-key') return json(200, { key: sodium.to_base64(repoKeys.publicKey, sodium.base64_variants.ORIGINAL), key_id: 'k1' });
    const m = p.match(/^\/repos\/acme\/shop\/actions\/secrets\/([A-Z_]+)$/);
    if (m && opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      const sealed = sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL);
      gh.secrets[m[1]] = sodium.to_string(sodium.crypto_box_seal_open(sealed, repoKeys.publicKey, repoKeys.privateKey));
      return new Response(null, { status: 201 });
    }
    if (p.startsWith('/repos/nobody/')) return json(404, { message: 'Not Found' });
    return json(404, { message: `fake github: no route ${opts.method || 'GET'} ${p}` });
  };
  return gh;
}

// A live site for verify to check (private addresses are allowed in tests).
async function liveSite() {
  const s = http.createServer((req, res) => {
    if (req.url === '/' ) return res.end('<html><head><title>Invoicely</title></head><body><h1>Invoices</h1></body></html>');
    res.statusCode = 404;
    res.end('nope');
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() };
}

test('sign-in, origin checks and the plain API', async (t) => {
  const gh = fakeGitHub();
  const srv = await startTest({ fetch: gh.fetch });
  t.after(() => srv.stop());

  // Pages and API need a session.
  let r = await fetch(`${srv.base}/`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login');
  r = await fetch(`${srv.base}/api/apps`);
  assert.equal(r.status, 401);
  r = await fetch(`${srv.base}/login`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');

  // Writes from another site are refused, even with the session cookie.
  const me = await signIn(srv.base);
  assert.ok(me.cookie.startsWith('lc_sid='));
  const evil = await me.call('POST', '/api/apps/x/tasks', { title: 'hi' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const noOrigin = await fetch(`${srv.base}/auth/dev`, { method: 'POST', redirect: 'manual' });
  assert.equal(noOrigin.status, 403);

  r = await me.get('/api/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.claude.ok, false);
  assert.equal(r.body.github.oauth, false);

  // Shared assets are served.
  r = await fetch(`${srv.base}/board.js`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /window\.Board/);

  // Every built-in service has its own logo, drawn from this server (the CSP
  // allows no outside images) without style attributes (the CSP blocks those
  // too), and the page loads them before board.js draws the account lists.
  r = await fetch(`${srv.base}/logos.js`);
  assert.equal(r.status, 200);
  const logos = await r.text();
  const win = {};
  new Function('window', logos)(win);
  for (const id of Object.keys(ACCOUNTS)) assert.ok(win.LiftoffLogos[id], `${id} has a logo`);
  assert.doesNotMatch(logos, /style=|https?:/);
  r = await me.get('/');
  assert.match(r.text, /<script src="\/logos\.js"><\/script>\n<script src="\/board\.js">/);

  // Import a zip.
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'), { prefix: 'next-saas/' });
  r = await me.call('POST', '/api/import/zip?name=next-saas.zip', zip, { 'content-type': 'application/zip' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.slug, 'invoicely');
  assert.equal(r.body.framework, 'Next.js');
  assert.equal(r.body.root, 'next-saas.zip');
  assert.equal(r.body.cloud.source.type, 'upload');
  assert.ok(r.body.cloud.scan);
  assert.ok(r.body.steps.some((s) => s.id === 'hosting'));
  r = await me.call('POST', '/api/import/zip?name=x.zip', Buffer.from('not a zip'), { 'content-type': 'application/zip' });
  assert.equal(r.status, 400);
  r = await me.call('POST', '/api/import/zip', zip, { 'content-type': 'text/plain' });
  assert.equal(r.status, 415);

  // Tasks and checklist work like the local dashboard.
  r = await me.post('/api/apps/invoicely/tasks', { title: 'Buy the domain', blocksRelease: true });
  assert.equal(r.status, 200);
  const task = r.body.tasks.find((x) => x.title === 'Buy the domain');
  assert.ok(task.blocksRelease);
  r = await me.post(`/api/apps/invoicely/tasks/${task.id}`, { done: true });
  assert.ok(r.body.tasks.find((x) => x.id === task.id).done);
  r = await me.post('/api/apps/invoicely/tasks/nope', { done: true });
  assert.equal(r.status, 400);
  r = await me.post('/api/apps/invoicely/checklist/pay-products', { done: true });
  assert.equal(r.body.checklist.find((c) => c.id === 'pay-products').by, 'you');
  r = await me.get('/api/apps/../../etc');
  assert.equal(r.status, 404);

  // Settings are checked so a key can never be sent to another host.
  r = await me.post('/api/apps/invoicely/settings', { key: 'posthog.host', value: 'https://evil.example' });
  assert.equal(r.status, 400);
  r = await me.post('/api/apps/invoicely/settings', { key: 'sentry.org', value: '../../x' });
  assert.equal(r.status, 400);
  r = await me.post('/api/apps/invoicely/settings', { key: 'posthog.host', value: 'https://eu.posthog.com/' });
  assert.equal(r.body.config['posthog.host'], 'https://eu.posthog.com');

  // Accounts: values are stored encrypted and never returned.
  r = await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_supersecret' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.find((a) => a.id === 'stripe').connected);
  assert.ok(!JSON.stringify(r.body).includes('sk_test_supersecret'));
  const onDisk = fs.readFileSync(path.join(srv.dataDir, 'users', fs.readdirSync(path.join(srv.dataDir, 'users'))[0], 'secrets.json'), 'utf8');
  assert.ok(!onDisk.includes('sk_test_supersecret'));
  r = await me.post('/api/accounts/stripe', { values: {} });
  assert.equal(r.status, 400);
  r = await me.post('/api/accounts/nope', { values: {} });
  assert.equal(r.status, 404);
  r = await me.del('/api/accounts/stripe');
  assert.ok(!r.body.find((a) => a.id === 'stripe').connected);

  // Runs need the Anthropic key.
  r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'] });
  assert.equal(r.status, 503);

  // A GitHub repo that doesn't exist.
  r = await me.post('/api/import/github', { url: 'https://github.com/nobody/missing' });
  assert.equal(r.status, 404);
  r = await me.post('/api/import/github', { url: 'not a repo link at all' });
  assert.equal(r.status, 400);

  // Sign out ends the session.
  r = await fetch(`${srv.base}/auth/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: me.cookie, origin: srv.base } });
  assert.equal(r.status, 302);
  r = await me.get('/api/me');
  assert.equal(r.status, 401);
});

test('GitHub sign-in imports private repos with the user\'s token', async (t) => {
  const gh = fakeGitHub();
  const srv = await startTest({ fetch: gh.fetch, env: { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret' } });
  t.after(() => srv.stop());
  const origin = srv.base;

  let r = await fetch(`${srv.base}/auth/github`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.host, 'github.com');
  assert.equal(loc.searchParams.get('scope'), 'repo read:user');
  const state = loc.searchParams.get('state');
  const stateCookie = r.headers.getSetCookie()[0].split(';')[0];

  // A forged state is refused.
  r = await fetch(`${srv.base}/auth/github/callback?code=c&state=forged`, { redirect: 'manual', headers: { cookie: stateCookie } });
  assert.equal(r.headers.get('location'), '/login?error=state');

  r = await fetch(`${srv.base}/auth/github/callback?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
  assert.equal(r.headers.get('location'), '/');
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('lc_sid='));
  const call = async (method, p, body) => {
    const res = await fetch(`${srv.base}${p}`, { method, headers: { cookie, origin, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };

  r = await call('GET', '/api/me');
  assert.equal(r.body.user.login, 'octo');
  assert.equal(r.body.github.token, true);
  r = await call('GET', '/api/github/repos');
  assert.equal(r.body[0].fullName, 'acme/shop');

  r = await call('POST', '/api/import/github', { url: 'https://github.com/acme/shop' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.slug, 'invoicely');
  assert.equal(r.body.cloud.source.fullName, 'acme/shop');
  assert.equal(r.body.cloud.source.private, true);
  assert.equal(r.body.config['github.repo'], 'acme/shop');
  assert.ok(gh.tokens.includes('Bearer gho_testtoken'));

  // Importing the same repo again refreshes the same app.
  r = await call('POST', '/api/import/github', { url: 'acme/shop' });
  assert.equal(r.body.slug, 'invoicely');
  r = await call('GET', '/api/apps');
  assert.equal(r.body.length, 1);
  r = await call('POST', '/api/apps/invoicely/rescan');
  assert.equal(r.status, 200);
  assert.match(r.body.log.at(-1).msg, /Rescanned acme\/shop@main/);
});

test('a cloud run: Claude calls Liftoff tools, asks for approval and a choice, and finishes', async (t) => {
  const site = await liveSite();
  t.after(() => site.close());
  let session;
  const client = fakeAnthropic(async (s, tools) => {
    session = s;
    s.plan = JSON.parse((await tools.custom('liftoff_plan', {})).text);
    s.skill = await tools.custom('liftoff_skill', { name: 'hosting' });
    await tools.custom('liftoff_step', { step: 'hosting', status: 'running' });
    s.approval = await tools.ask('bash', { command: 'curl -X POST https://api.vercel.com/v13/deployments -H "Authorization: Bearer $VERCEL_TOKEN"' });
    s.answer = await tools.custom('ask_user', { question: 'Which domain should the app use?', options: ['invoicely.app', 'Skip for now'] });
    await tools.custom('liftoff_deploy', { target: 'vercel', platform: 'web', url: site.url });
    await tools.custom('liftoff_record', { step: 'hosting', kind: 'resource', value: 'vercel:project:invoicely' });
    await tools.custom('liftoff_step', { step: 'hosting', status: 'done', provider: 'vercel', note: 'deployed' });
    s.handTick = await tools.custom('liftoff_check', { item: 'host-deploy' });
    s.purchaseTick = await tools.custom('liftoff_check', { item: 'pay-e2e' });
    s.preview = await tools.custom('liftoff_set', { key: 'preview.url', value: 'https://invoicely-git-main-me.vercel.app/pricing' });
    s.badSetting = await tools.custom('liftoff_set', { key: 'posthog.host', value: 'https://evil.example' });
    s.verify = await tools.custom('liftoff_verify', { only: ['host-deploy', 'land-page'] });
    s.pr = await tools.custom('open_pull_request', { branch: 'x', title: 't', body: 'b' });
    s.outputs = [{ id: 'file_out1', filename: 'liftoff-changes.patch', size_bytes: 5, body: 'patch' }];
    tools.emit({ type: 'agent.message', content: [{ type: 'text', text: '✓ Deploy and domain: Vercel, live' }] });
    tools.end('250');
  });
  const srv = await startTest({ anthropic: client });
  t.after(() => srv.stop());
  const me = await signIn(srv.base);

  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
  let r = await me.call('POST', '/api/import/zip?name=invoicely.zip', zip, { 'content-type': 'application/zip' });
  assert.equal(r.status, 200);
  await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_supersecret' } });
  await me.post('/api/accounts/cloudflare', { values: { CLOUDFLARE_API_TOKEN: 'cf_secret_token', CLOUDFLARE_ACCOUNT_ID: 'acct123' } });

  r = await me.get('/api/me');
  assert.equal(r.body.claude.ok, true);
  // People see Pilot, two modes and tokens: no model ids, no dollars.
  assert.equal(r.body.assistant.name, 'Pilot');
  assert.equal(r.body.tiers.default, 'cruise');
  assert.deepEqual(r.body.tiers.choices.map((m) => [m.id, m.label]), [['cruise', 'Cruise'], ['boost', 'Boost']]);
  assert.equal(r.body.tiers.strongest, 'boost');
  assert.deepEqual([r.body.limits.runBudgetTokens, r.body.limits.topUpTokens], [1500, 1000]);
  assert.doesNotMatch(r.text, /claude-|sonnet|opus|Usd/i);
  r = await me.post('/api/apps/invoicely/runs', { steps: ['nope'] });
  assert.equal(r.status, 400);
  r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'], tier: 'warp' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Cruise, Boost/);
  r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'], note: 'Use Vercel' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.tier, 'cruise');
  assert.equal(r.body.model, undefined);
  assert.equal(r.body.budgetTokens, 1500);
  const runId = r.body.id;
  assert.match(runId, /^r_/);
  r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'] });
  assert.equal(r.status, 409);

  // Claude asks to run a command: approve it.
  const url = `/api/apps/invoicely/runs/${runId}`;
  let run = await until(async () => { const x = (await me.get(url)).body; return x.pending[0]?.kind === 'approval' && x; });
  assert.equal(run.status, 'needs-you');
  assert.match(run.pending[0].detail, /api\.vercel\.com/);
  r = await me.post(`${url}/message`, { text: 'hello?' });
  assert.equal(r.status, 409);
  r = await me.post(`${url}/approve`, { eventId: run.pending[0].id, allow: true });
  assert.equal(r.status, 200, r.text);
  r = await me.post(`${url}/approve`, { eventId: run.pending[0].id, allow: true });
  assert.equal(r.status, 409);

  // Then a question: answer it.
  run = await until(async () => { const x = (await me.get(url)).body; return x.pending[0]?.kind === 'question' && x; });
  assert.deepEqual(run.pending[0].options, ['invoicely.app', 'Skip for now']);
  r = await me.post(`${url}/answer`, { eventId: run.pending[0].id, text: 'invoicely.app' });
  assert.equal(r.status, 200);

  run = await until(async () => { const x = (await me.get(url)).body; return x.status === 'finished' && x.tokens !== null && x; });
  assert.equal(run.tokens, 250, '$2.50 of Claude time is 250 tokens');
  assert.equal(run.cost, undefined);
  assert.ok(run.events.some((e) => e.text === 'Pilot got the launch brief'));
  assert.ok(run.events.some((e) => e.text === 'Pilot finished. Send a message to keep going.'));
  assert.equal(session.approval, 'allow');
  assert.match(session.answer.text, /invoicely\.app/);
  assert.ok(session.plan.steps.some((s) => s.id === 'hosting'));
  assert.deepEqual(session.plan.keys.inSandbox, ['STRIPE_SECRET_KEY', 'CLOUDFLARE_API_TOKEN']);
  assert.deepEqual(session.plan.keys.plain, ['CLOUDFLARE_ACCOUNT_ID']);
  assert.match(session.skill.text, /hosting/i);
  assert.equal(session.handTick.isError, true);
  assert.match(session.handTick.text, /liftoff_verify/);
  assert.equal(session.purchaseTick.isError, true, 'a web app on Stripe has its purchase flow proven by Stripe, not ticked');
  assert.match(session.purchaseTick.text, /proven from Stripe/);
  assert.ok(!session.preview.isError, session.preview.text);
  assert.equal(session.badSetting.isError, true);
  assert.match(session.verify.text, /PASS host-deploy/);
  assert.equal(session.pr.isError, true); // uploads have no pull request
  assert.ok(run.events.some((e) => e.kind === 'message' && /Deploy and domain/.test(e.text)));
  assert.ok(run.events.some((e) => e.kind === 'you' && e.text === 'invoicely.app'));

  // The Flight Board shows what the run did.
  r = await me.get('/api/apps/invoicely');
  const hosting = r.body.steps.find((s) => s.id === 'hosting');
  assert.equal(hosting.status, 'done');
  assert.equal(hosting.provider, 'vercel');
  assert.equal(r.body.liveUrl, site.url);
  assert.equal(r.body.config['preview.url'], 'https://invoicely-git-main-me.vercel.app');
  assert.equal(r.body.checklist.find((c) => c.id === 'pay-e2e').done, false);
  assert.equal(r.body.checklist.find((c) => c.id === 'host-deploy').by, 'verified');
  assert.equal(r.body.cloud.run.status, 'finished');
  assert.equal(r.body.cloud.run.tokens, 250);

  // The session got the code, a vault and a budget, and never a real key.
  const create = client.calls.find((c) => c[0] === 'sessions.create')[1];
  // Sonnet by default, with the agent's prompt and tools.
  assert.deepEqual(create.agent, { type: 'agent_with_overrides', id: 'agent_test', model: { id: 'claude-sonnet-5-5', effort: 'high' } });
  assert.equal(create.environment_id, 'env_test');
  assert.equal(create.resources[0].type, 'file');
  assert.equal(create.resources[0].mount_path, '/app.zip');
  assert.equal(create.vault_ids.length, 1);
  assert.deepEqual(create.budget, { type: 'limit', max_list_cost: { amount: '1500', currency: 'USD' } });
  const kickoffText = create.initial_events[0].content[0].text;
  assert.match(kickoffText, /Steps to run: hosting/);
  assert.match(kickoffText, /STRIPE_SECRET_KEY/);
  assert.match(kickoffText, /CLOUDFLARE_ACCOUNT_ID=acct123/);
  assert.match(kickoffText, /Use Vercel/);
  assert.ok(!JSON.stringify(create).includes('sk_test_supersecret'));
  assert.ok(!JSON.stringify(create).includes('cf_secret_token'));
  const creds = client.calls.filter((c) => c[0] === 'vaults.credentials.create').map((c) => c[2].auth);
  const stripe = creds.find((a) => a.secret_name === 'STRIPE_SECRET_KEY');
  assert.equal(stripe.secret_value, 'sk_test_supersecret');
  assert.deepEqual(stripe.networking, { type: 'limited', allowed_hosts: ['api.stripe.com'] });
  assert.deepEqual(stripe.injection_location, { header: true, body: false });
  assert.ok(!creds.some((a) => a.secret_name === 'CLOUDFLARE_ACCOUNT_ID'));

  // Outputs for an upload: the patch can be downloaded.
  run = await until(async () => { const x = (await me.get(url)).body; return x.outputs.length && x; });
  const dl = await fetch(`${srv.base}${url}/outputs/file_out1`, { headers: { cookie: me.cookie } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'patch');
  assert.match(dl.headers.get('content-disposition'), /liftoff-changes\.patch/);
  r = await me.get(`${url}/outputs/file_other`);
  assert.equal(r.status, 404);

  // Incremental polling returns only newer events.
  const all = (await me.get(url)).body;
  const later = (await me.get(`${url}?after=${all.seq}`)).body;
  assert.equal(later.events.length, 0);

  // Keep going with a message, then stop.
  r = await me.post(`${url}/message`, { text: 'Now add a status page' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'running');
  r = await me.post(`${url}/stop`);
  assert.equal(r.status, 200);
  run = await until(async () => { const x = (await me.get(url)).body; return x.status === 'stopped' && x; });
  const sent = client.calls.filter((c) => c[0] === 'events.send').flatMap((c) => c[2]);
  assert.ok(sent.some((e) => e.type === 'user.interrupt'));
  assert.ok(sent.some((e) => e.type === 'user.tool_confirmation' && e.result === 'allow'));

  // Changing a key replaces its vault credential on the next run.
  await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_rotated' } });
  r = await me.post('/api/apps/invoicely/runs', { steps: [] });
  assert.equal(r.status, 200);
  const second = r.body.id;
  await until(async () => client.calls.filter((c) => c[0] === 'sessions.create').length === 2 || (await me.get(`/api/apps/invoicely/runs/${second}`)).body.error).catch(() => {});
  assert.equal((await me.get(`/api/apps/invoicely/runs/${second}`)).body.error, null);
  assert.equal(client.calls.filter((c) => c[0] === 'sessions.create').length, 2);
  assert.ok(client.calls.some((c) => c[0] === 'vaults.credentials.archive'));
  assert.equal(client.calls.filter((c) => c[0] === 'vaults.create').length, 1);
});

test('GitHub runs push a branch, open a pull request and copy keys to CI after approval', async (t) => {
  const gh = fakeGitHub();
  let session;
  const client = fakeAnthropic(async (s, tools) => {
    session = s;
    const branch = s.params.initial_events[0].content[0].text.match(/Create the branch (\S+?) from it/)[1];
    s.branch = branch;
    s.wrongBranch = await tools.custom('open_pull_request', { branch: 'main', title: 'x', body: 'y' });
    s.pr = await tools.custom('open_pull_request', { branch, title: 'Launch setup', body: 'Hosting and CI' });
    s.secret = await tools.custom('github_set_secret', { name: 'STRIPE_SECRET_KEY', from: 'STRIPE_SECRET_KEY' });
    s.declined = await tools.custom('github_set_secret', { name: 'VERCEL_TOKEN', from: 'VERCEL_TOKEN' });
    tools.end();
  });
  const srv = await startTest({ fetch: gh.fetch, anthropic: client, env: { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret' } });
  t.after(() => srv.stop());

  // Sign in with GitHub.
  let r = await fetch(`${srv.base}/auth/github`, { redirect: 'manual' });
  const state = new URL(r.headers.get('location')).searchParams.get('state');
  const stateCookie = r.headers.getSetCookie()[0].split(';')[0];
  r = await fetch(`${srv.base}/auth/github/callback?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('lc_sid='));
  const call = async (method, p, body) => {
    const res = await fetch(`${srv.base}${p}`, { method, headers: { cookie, origin: srv.base, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };

  await call('POST', '/api/import/github', { url: 'https://github.com/acme/shop' });
  await call('POST', '/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_ci' } });
  await call('POST', '/api/accounts/vercel', { values: { VERCEL_TOKEN: 'vercel_tok' } });
  r = await call('POST', '/api/apps/invoicely/runs', { steps: ['cicd'], tier: 'boost' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'github');
  assert.equal(r.body.tier, 'boost');
  const url = `/api/apps/invoicely/runs/${r.body.id}`;

  let run = await until(async () => { const x = (await call('GET', url)).body; return x.pending[0]?.kind === 'secret' && x; });
  assert.match(run.pending[0].text, /STRIPE_SECRET_KEY.*acme\/shop/);
  assert.deepEqual(gh.secrets, {}); // nothing copied before the user says yes
  await call('POST', `${url}/approve`, { eventId: run.pending[0].id, allow: true });
  run = await until(async () => { const x = (await call('GET', url)).body; return x.pending[0]?.kind === 'secret' && x.pending[0].text.includes('VERCEL') && x; });
  await call('POST', `${url}/approve`, { eventId: run.pending[0].id, allow: false, reason: 'not yet' });
  run = await until(async () => { const x = (await call('GET', url)).body; return x.status === 'finished' && x; });

  assert.equal(gh.secrets.STRIPE_SECRET_KEY, 'sk_test_ci');
  assert.equal(gh.secrets.VERCEL_TOKEN, undefined);
  assert.equal(session.declined.isError, true);
  assert.match(session.declined.text, /not yet/);
  assert.equal(session.wrongBranch.isError, true);
  assert.equal(session.pr.isError, false);
  assert.deepEqual(gh.pulls[0].head, session.branch);
  assert.equal(gh.pulls[0].base, 'main');
  assert.equal(gh.pulls[0].draft, true);
  assert.deepEqual(run.pr, { number: 7, url: 'https://github.com/acme/shop/pull/7', branch: session.branch });

  const create = client.calls.find((c) => c[0] === 'sessions.create')[1];
  assert.deepEqual(create.agent.model, { id: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(create.resources[0], {
    type: 'github_repository',
    url: 'https://github.com/acme/shop',
    authorization_token: 'gho_testtoken',
    checkout: { type: 'branch', name: 'main' },
    mount_path: '/workspace/app',
  });
  r = await call('GET', '/api/apps/invoicely');
  assert.ok(r.body.tasks.some((x) => x.url === 'https://github.com/acme/shop/pull/7'));
});

test('runs pick up where they left off after a restart', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = fakeAnthropic(async (s, tools) => {
    await tools.custom('liftoff_step', { step: 'hosting', status: 'running' });
    await gate;
    await tools.custom('liftoff_step', { step: 'hosting', status: 'done', note: 'after restart' });
    tools.end();
  });
  const srv = await startTest({ anthropic: client });
  const me = await signIn(srv.base);
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
  await me.call('POST', '/api/import/zip?name=a.zip', zip, { 'content-type': 'application/zip' });
  const r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'] });
  const url = `/api/apps/invoicely/runs/${r.body.id}`;
  await until(async () => (await me.get('/api/apps/invoicely')).body.steps.find((s) => s.id === 'hosting').status === 'running');
  await srv.stop();

  // A new server on the same data folder follows the same session again.
  const { startCloud } = await import('../server.mjs');
  const again = await startCloud({ ...srv.config, port: 0 }, { anthropic: client });
  t.after(() => again.stop());
  assert.equal(again.resumed, 1);
  const base = `http://localhost:${again.server.address().port}`;
  again.ctx.config.publicUrl = base;
  const me2 = await signIn(base);
  release();
  const run = await until(async () => { const x = (await me2.get(url)).body; return x.status === 'finished' && x; });
  assert.ok(run.events.filter((e) => e.text === 'hosting → running').length === 1, 'no duplicate events after reconnecting');
  const app = (await me2.get('/api/apps/invoicely')).body;
  assert.equal(app.steps.find((s) => s.id === 'hosting').note, 'after restart');
});

test('a run that reaches its budget pauses, and continues when the user adds more', async (t) => {
  const client = fakeAnthropic(async (s, tools) => {
    await tools.custom('liftoff_step', { step: 'hosting', status: 'running' });
    await tools.budget('1503');
    await tools.custom('liftoff_step', { step: 'hosting', status: 'done' });
    tools.end('1840');
  });
  const srv = await startTest({ anthropic: client });
  t.after(() => srv.stop());
  const me = await signIn(srv.base);
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
  await me.call('POST', '/api/import/zip?name=a.zip', zip, { 'content-type': 'application/zip' });
  let r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'] });
  assert.equal(r.status, 200, r.text);
  const url = `/api/apps/invoicely/runs/${r.body.id}`;

  let run = await until(async () => { const x = (await me.get(url)).body; return x.status === 'budget' && x; });
  assert.equal(run.tokens, 1503);
  assert.ok(run.events.some((e) => e.text === "Paused at this run's budget of 1,500 tokens"));
  r = await me.post(`${url}/message`, { text: 'keep going' });
  assert.equal(r.status, 409);
  r = await me.post(`${url}/budget`, { addTokens: 50 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /between 100 tokens and 10,000 tokens/);
  r = await me.post(`${url}/budget`, { addTokens: 1000 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.budgetTokens, 2503);
  assert.ok(r.body.events.some((e) => e.kind === 'you' && e.text === 'Raised the budget to 2,503 tokens'));
  const update = client.calls.find((c) => c[0] === 'sessions.update');
  // Anthropic still gets dollars, in cents.
  assert.deepEqual(update[2].budget, { type: 'limit', max_list_cost: { amount: '2503', currency: 'USD' } });

  run = await until(async () => { const x = (await me.get(url)).body; return x.status === 'finished' && x.tokens === 1840 && x; });
  assert.equal(run.budgetTokens, 2503);
});

test('a message sent while Claude works shows once, even when the session echoes it right back', async (t) => {
  const client = fakeAnthropic(async (s, tools) => {
    await tools.waitFor((e) => e.type === 'user.message'); // the launch brief
    tools.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Which host?' }] });
    await tools.waitFor((e) => e.type === 'user.message');
    tools.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Vercel it is' }] });
    tools.end('100');
  });
  const srv = await startTest({ anthropic: client });
  t.after(() => srv.stop());
  const me = await signIn(srv.base);
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
  await me.call('POST', '/api/import/zip?name=a.zip', zip, { 'content-type': 'application/zip' });
  let r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'] });
  assert.equal(r.status, 200, r.text);
  const url = `/api/apps/invoicely/runs/${r.body.id}`;
  await until(async () => (await me.get(url)).body.events.some((e) => e.text === 'Which host?'));
  r = await me.post(`${url}/message`, { text: 'Use Vercel' });
  assert.equal(r.status, 200, r.text);
  const run = await until(async () => { const x = (await me.get(url)).body; return x.status === 'finished' && x; });
  assert.equal(run.events.filter((e) => e.kind === 'you' && e.text === 'Use Vercel').length, 1);
});
