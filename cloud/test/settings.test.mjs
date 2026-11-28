// Account settings: theme and default model, signing out elsewhere, and
// deleting an account (keys leave Claude's vault, GitHub access is taken back).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { zipDirectory } from '../lib/archive.mjs';
import { fakeAnthropic } from './fake-anthropic.mjs';
import { FIXTURES, signIn, startTest, until } from './helpers.mjs';

const userDirs = (srv) => fs.readdirSync(path.join(srv.dataDir, 'users'));

test('theme and default mode are saved to the account, and new runs use that mode', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = fakeAnthropic(async (s, tools) => {
    await tools.custom('liftoff_step', { step: 'hosting', status: 'running' });
    await gate;
  });
  const srv = await startTest({ anthropic: client });
  t.after(() => { release(); return srv.stop(); });

  // The pages load theme.js before the styles, so the theme never flashes.
  let res = await fetch(`${srv.base}/theme.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /LiftoffTheme/);
  res = await fetch(`${srv.base}/login`);
  assert.match(await res.text(), /<script src="\/theme\.js"><\/script>\n<link rel="stylesheet" href="\/board\.css">/);
  res = await fetch(`${srv.base}/board.css`);
  const css = await res.text();
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.doesNotMatch(css, /prefers-color-scheme/);

  const me = await signIn(srv.base);
  let r = await me.get('/api/me');
  assert.deepEqual(r.body.prefs, { theme: 'system', tier: null });
  assert.equal(r.body.user.via, 'local');
  assert.ok(r.body.user.createdAt);
  assert.equal(r.body.tiers.default, 'cruise');
  assert.equal(r.body.tiers.server, 'cruise');

  r = await me.post('/api/me/prefs', { theme: 'dark' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.prefs.theme, 'dark');
  r = await me.post('/api/me/prefs', { theme: 'purple' });
  assert.equal(r.status, 400);
  r = await me.post('/api/me/prefs', { tier: 'warp' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Cruise, Boost/);
  r = await me.post('/api/me/prefs', { tier: 'boost' });
  assert.equal(r.body.prefs.theme, 'dark', 'changing one setting keeps the other');
  assert.equal(r.body.tiers.default, 'boost');
  r = await me.get('/api/me');
  assert.deepEqual(r.body.prefs, { theme: 'dark', tier: 'boost' });
  // Saved as the model behind the mode, as before, so older accounts keep their choice.
  assert.equal(srv.ctx.store.getUser(userDirs(srv)[0]).prefs.model, 'claude-opus-5-5');

  // A run started without a model uses the account's default.
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
  await me.call('POST', '/api/import/zip?name=a.zip', zip, { 'content-type': 'application/zip' });
  r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.tier, 'boost');
  await until(() => client.calls.find((c) => c[0] === 'sessions.create'));
  assert.equal(client.calls.find((c) => c[0] === 'sessions.create')[1].agent.model.id, 'claude-opus-5-5');

  // Back to the server's default.
  r = await me.post('/api/me/prefs', { tier: null });
  assert.equal(r.body.prefs.tier, null);
  assert.equal(r.body.tiers.default, 'cruise');
});

test('signing out other devices keeps this one', async (t) => {
  const srv = await startTest();
  t.after(() => srv.stop());
  const here = await signIn(srv.base);
  const there = await signIn(srv.base);
  let r = await here.post('/api/me/sign-out-others');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.ended, 1);
  assert.equal((await there.get('/api/me')).status, 401);
  assert.equal((await here.get('/api/me')).status, 200);
  r = await here.post('/api/me/sign-out-others');
  assert.equal(r.body.ended, 0);
});

test('deleting an account removes its data and its keys in Claude\'s vault, but waits for runs to stop', async (t) => {
  const client = fakeAnthropic(async (s, tools) => {
    await tools.custom('liftoff_step', { step: 'hosting', status: 'running' });
    await tools.waitFor((e) => e.type === 'user.interrupt', 20000);
  });
  const srv = await startTest({ anthropic: client });
  t.after(() => srv.stop());
  const me = await signIn(srv.base);
  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
  await me.call('POST', '/api/import/zip?name=a.zip', zip, { 'content-type': 'application/zip' });
  await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_gone_soon' } });
  let r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'] });
  const url = `/api/apps/invoicely/runs/${r.body.id}`;
  await until(async () => (await me.get(url)).body.status === 'running');
  const [uid] = userDirs(srv);
  const vaultId = await until(() => srv.ctx.store.getSecrets(uid).vault?.id);
  assert.ok(client.vaults.has(vaultId));

  // It has to be typed, and a run that's going blocks it.
  r = await me.call('DELETE', '/api/me', { confirm: 'someone-else' });
  assert.equal(r.status, 400);
  r = await me.call('DELETE', '/api/me', { confirm: 'you' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Stop your runs first/);

  await me.post(`${url}/stop`);
  await until(async () => !['running', 'starting', 'needs-you'].includes((await me.get(url)).body.status));

  // If Claude's vault can't be cleared, nothing is deleted.
  const realDelete = client.beta.vaults.delete;
  client.beta.vaults.delete = async () => { throw Object.assign(new Error('overloaded'), { status: 529, headers: {} }); };
  r = await me.call('DELETE', '/api/me', { confirm: 'you' });
  assert.equal(r.status, 502);
  assert.equal((await me.get('/api/me')).status, 200);
  assert.ok(fs.existsSync(path.join(srv.dataDir, 'users', uid)));
  client.beta.vaults.delete = realDelete;

  r = await me.call('DELETE', '/api/me', { confirm: 'YOU' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.deleted, true);
  assert.equal(r.body.githubRevoked, null);
  assert.match(r.headers.get('set-cookie'), /lc_sid=;.*Max-Age=0/);
  assert.ok(!client.vaults.has(vaultId));
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'users', uid)));
  assert.equal((await me.get('/api/me')).status, 401);
  assert.ok(!fs.readdirSync(path.join(srv.dataDir, 'sessions')).length, 'no sign-ins left');

  // Continuing on this machine starts a fresh, empty account.
  const fresh = await signIn(srv.base);
  assert.deepEqual((await fresh.get('/api/apps')).body, []);
  assert.notEqual(userDirs(srv).find((u) => u !== uid), undefined);
});

test('deleting a GitHub account takes back Liftoff Cloud\'s access on GitHub', async (t) => {
  const revoked = [];
  const fetchGh = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/login/oauth/access_token') return json(200, { access_token: 'gho_deleteme', scope: 'repo,read:user' });
    if (u.pathname === '/user') return json(200, { id: 77, login: 'octo', name: 'Octo Cat', avatar_url: 'https://avatars.githubusercontent.com/u/77' });
    if (u.pathname === '/applications/cid/grant' && opts.method === 'DELETE') {
      revoked.push({ auth: opts.headers.authorization, token: JSON.parse(opts.body).access_token });
      return new Response(null, { status: 204 });
    }
    return json(404, { message: 'no route' });
  };
  const srv = await startTest({ fetch: fetchGh, env: { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret' } });
  t.after(() => srv.stop());

  const signInWithGitHub = async () => {
    let res = await fetch(`${srv.base}/auth/github`, { redirect: 'manual' });
    const state = new URL(res.headers.get('location')).searchParams.get('state');
    const stateCookie = res.headers.getSetCookie()[0].split(';')[0];
    res = await fetch(`${srv.base}/auth/github/callback?code=c&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
    const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('lc_sid='));
    return async (method, p, body) => {
      const x = await fetch(`${srv.base}${p}`, { method, headers: { cookie, origin: srv.base, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: x.status, body: await x.json() };
    };
  };

  let call = await signInWithGitHub();
  let r = await call('GET', '/api/me');
  assert.equal(r.body.user.via, 'github');
  assert.equal(r.body.github.scope, 'repo,read:user');
  await call('POST', '/api/me/prefs', { theme: 'light' });
  const [uid] = userDirs(srv);

  r = await call('DELETE', '/api/me', { confirm: 'octo' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.githubRevoked, true);
  assert.deepEqual(revoked, [{ auth: `Basic ${Buffer.from('cid:csecret').toString('base64')}`, token: 'gho_deleteme' }]);
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'github', '77.json')));

  // Signing in with GitHub again starts over.
  call = await signInWithGitHub();
  r = await call('GET', '/api/me');
  assert.equal(r.body.user.login, 'octo');
  assert.equal(r.body.prefs.theme, 'system');
  assert.ok(!userDirs(srv).includes(uid));
});
