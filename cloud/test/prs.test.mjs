// Pull request checks (lib/prs.mjs): each open pull request on a watched
// GitHub app is checked for secret keys in the files it changes and launch
// checks it would break, and the answer goes back to GitHub as a commit
// status and to the owner's alert channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { problemsIn, statusText } from '../lib/prs.mjs';
import { FIXTURES, signIn, startTest, tarGz, tmpDir, treeEntries } from './helpers.mjs';

const KEY = `sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`;
const S = (s) => s.padEnd(40, '0'); // a commit id
const BASE = treeEntries(path.join(FIXTURES, 'next-saas'), 'acme-shop-base');
const tree = (sha, extra) => tarGz([...BASE.map((e) => ({ ...e, name: e.name.replace('acme-shop-base', `acme-shop-${sha}`) })), ...extra.map(([f, content]) => ({ name: `acme-shop-${sha}/${f}`, content }))]);

// GitHub, for one repository: acme/shop.
function fakeGitHub() {
  const gh = { open: [], trees: {}, files: {}, statuses: [], statusAnswer: 201, listAnswer: 200 };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  gh.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const p = u.pathname;
    if (p === '/repos/acme/shop') return json(200, { owner: { login: 'acme' }, name: 'shop', full_name: 'acme/shop', html_url: 'https://github.com/acme/shop', default_branch: 'main', private: true });
    if (p === '/repos/acme/shop/tarball/main') return new Response(tarGz(BASE), { status: 200 });
    if (p === '/repos/acme/shop/commits/main') return json(200, { sha: 'base000' });
    if (p === '/repos/acme/shop/pulls' && (opts.method || 'GET') === 'GET') return gh.listAnswer === 200 ? json(200, gh.open) : json(gh.listAnswer, { message: 'Bad credentials' });
    let m = /^\/repos\/acme\/shop\/tarball\/([0-9a-f]+)$/.exec(p);
    if (m) return gh.trees[m[1]] ? new Response(gh.trees[m[1]], { status: 200 }) : json(404, { message: 'Not Found' });
    m = /^\/repos\/acme\/shop\/pulls\/(\d+)\/files$/.exec(p);
    if (m) return json(200, u.searchParams.get('page') === '1' ? (gh.files[m[1]] || []).map((f) => ({ filename: f, status: 'modified' })) : []);
    m = /^\/repos\/acme\/shop\/statuses\/([0-9a-f]+)$/.exec(p);
    if (m && opts.method === 'POST') {
      if (gh.statusAnswer !== 201) return json(gh.statusAnswer, { message: 'Resource not accessible by integration' });
      gh.statuses.push({ sha: m[1], ...JSON.parse(opts.body) });
      return json(201, {});
    }
    return json(404, { message: `fake github: no route ${opts.method || 'GET'} ${p}` });
  };
  // A pull request at a commit, with its code and the files it changes.
  gh.pr = (number, title, sha, changed, extra = []) => {
    gh.trees[sha] = tree(sha, extra);
    gh.files[number] = changed;
    const pr = { number, title, html_url: `https://github.com/acme/shop/pull/${number}`, user: { login: 'dev' }, head: { sha } };
    gh.open = [pr, ...gh.open.filter((x) => x.number !== number)];
  };
  return gh;
}

// The live site and Slack.
function fakeWeb() {
  const web = { hooks: [] };
  web.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host === 'hooks.slack.com') {
      web.hooks.push(JSON.parse(opts.body).text);
      return new Response('ok');
    }
    return new Response('<title>Shop</title>', { status: 200 });
  };
  return web;
}

async function setup() {
  const gh = fakeGitHub();
  const web = fakeWeb();
  const t = await startTest({ env: { LIFTOFF_CHECK_KEYS: '0' }, fetch: gh.fetch, safeFetch: web.fetch });
  const me = await signIn(t.base);
  assert.equal((await me.post('/api/accounts/github', { values: { GITHUB_TOKEN: `ghp_${'a'.repeat(36)}` } })).status, 200);
  const r = await me.post('/api/import/github', { url: 'acme/shop' });
  assert.equal(r.status, 200, r.text);
  const slug = r.body.slug;
  await me.post(`/api/apps/${slug}/live`, { url: 'https://shop.example' });
  await me.post('/api/me/alerts', { url: 'https://hooks.slack.com/services/T000AAAA/B000BBBB/abcdefghijklmnopqrstuvwx' });
  web.hooks.length = 0;
  const uid = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'dev-user.json'), 'utf8')).uid;
  const view = async () => (await me.get(`/api/apps/${slug}`)).body.cloud.prs;
  return { t, me, gh, web, slug, uid, view };
}

test('pull requests are checked once turned on, and the answer goes to GitHub', async () => {
  const { t, me, gh, web, slug, uid, view } = await setup();
  try {
    gh.pr(5, 'Add billing', S('aaa5'), ['app/lib/pay.ts', 'app/page.tsx'], [['app/lib/pay.ts', `export const key = '${KEY}';`]]);
    gh.pr(6, 'Fix footer', S('bbb6'), ['app/footer.tsx'], [['app/footer.tsx', 'export const Footer = () => null;'], ['app/old.ts', `// ${KEY}`]]);

    let v = await view();
    assert.equal(v.on, false);
    assert.equal(v.why, 'off');
    await t.ctx.watch.runDue();
    assert.equal(gh.statuses.length, 0, 'nothing is posted to GitHub until the owner turns it on');

    let r = await me.post(`/api/apps/${slug}/watch/prs`, { on: 'yes' });
    assert.equal(r.status, 400);
    r = await me.post(`/api/apps/${slug}/watch/prs`, { on: true });
    assert.equal(r.status, 200, r.text);
    await t.ctx.prs.idle();

    v = await view();
    assert.equal(v.checking, true);
    const five = v.prs.find((p) => p.number === 5);
    const six = v.prs.find((p) => p.number === 6);
    assert.equal(five.result, 'problems');
    assert.deepEqual(five.problems, [{ id: 'sec-keys', title: 'Secret key added', detail: 'Stripe secret key in app/lib/pay.ts' }]);
    assert.equal(six.result, 'ok', "a key in a file the pull request doesn't change isn't blamed on it");
    assert.equal(five.sha, 'aaa5000', 'the card shows the short commit id');

    // On GitHub: pending, then the answer, as "Liftoff", linking to the app.
    const of = (sha) => gh.statuses.filter((s) => s.sha === sha);
    assert.deepEqual(of(S('aaa5')).map((s) => s.state), ['pending', 'failure']);
    assert.deepEqual(of(S('bbb6')).map((s) => s.state), ['pending', 'success']);
    assert.equal(of(S('aaa5'))[1].description, 'Secret key added: Stripe secret key in app/lib/pay.ts');
    assert.equal(of(S('aaa5'))[1].context, 'Liftoff');
    assert.equal(of(S('aaa5'))[1].target_url, `${t.base}/#${slug}`);
    assert.equal(of(S('bbb6'))[1].description, 'No secret keys added, and no launch checks broken');

    // And to Slack, once.
    assert.equal(web.hooks.length, 1);
    assert.match(web.hooks[0], /^Liftoff alert: pull request #5 "Add billing" on .+: Secret key added: Stripe secret key in app\/lib\/pay\.ts\.\nhttps:\/\/github\.com\/acme\/shop\/pull\/5$/);

    // Nothing new: nothing checked again.
    await t.ctx.prs.check(uid, slug);
    assert.equal(gh.statuses.length, 4);
    assert.equal(web.hooks.length, 1);

    // A new commit fixes #5; #6 is merged and leaves the list.
    gh.pr(5, 'Add billing', S('ccc5'), ['app/lib/pay.ts'], [['app/lib/pay.ts', 'export const key = process.env.STRIPE_SECRET_KEY;']]);
    gh.open = gh.open.filter((p) => p.number !== 6);
    await t.ctx.prs.check(uid, slug);
    v = await view();
    assert.deepEqual(v.prs.map((p) => [p.number, p.result]), [[5, 'ok']]);
    assert.deepEqual(of(S('ccc5')).map((s) => s.state), ['pending', 'success']);

    // GitHub refusing the status doesn't lose the answer.
    gh.statusAnswer = 403;
    gh.pr(7, 'Docs', S('ddd7'), ['README.md']);
    await t.ctx.prs.check(uid, slug);
    v = await view();
    const seven = v.prs.find((p) => p.number === 7);
    assert.equal(seven.result, 'ok');
    assert.match(seven.statusError, /not accessible/);

    // GitHub not answering the list is kept for the card, not thrown.
    gh.listAnswer = 401;
    await t.ctx.prs.check(uid, slug);
    assert.match((await view()).error, /Couldn’t list the pull requests on GitHub: Bad credentials/);
    gh.listAnswer = 200;

    // Paused watching stops it; turning it off clears it.
    await me.post(`/api/apps/${slug}/watch`, { paused: true });
    assert.equal((await view()).why, 'not-watched');
    assert.equal(t.ctx.prs.due().length, 0);
    await me.post(`/api/apps/${slug}/watch`, { paused: false });
    r = await me.post(`/api/apps/${slug}/watch/prs`, { on: false });
    v = r.body.cloud.prs;
    assert.deepEqual([v.on, v.prs.length], [false, 0]);
    const before = gh.statuses.length;
    await t.ctx.watch.runDue();
    assert.equal(gh.statuses.length, before);
  } finally {
    await t.stop();
  }
});

test("a pull request that can't be downloaded is marked on GitHub and tried again on its next commit", async () => {
  const { t, me, gh, slug, uid, view } = await setup();
  try {
    gh.open = [{ number: 9, title: 'Huge', html_url: 'https://github.com/acme/shop/pull/9', user: { login: 'dev' }, head: { sha: S('eee9') } }];
    await me.post(`/api/apps/${slug}/watch/prs`, { on: true });
    await t.ctx.prs.idle();
    const nine = (await view()).prs[0];
    assert.equal(nine.result, 'error');
    assert.match(nine.detail, /Couldn’t check this pull request/);
    assert.deepEqual(gh.statuses.map((s) => s.state), ['pending', 'error']);
    gh.pr(9, 'Huge', S('fff9'), ['app/page.tsx']);
    await t.ctx.prs.check(uid, slug);
    assert.equal((await view()).prs[0].result, 'ok');
  } finally {
    await t.stop();
  }
});

test('only apps from GitHub can turn it on', async () => {
  const t = await startTest();
  try {
    const me = await signIn(t.base);
    const { zipDirectory } = await import('../lib/archive.mjs');
    const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
    const slug = (await me.call('POST', '/api/import/zip?name=shop.zip', zip, { 'content-type': 'application/zip' })).body.slug;
    assert.equal((await me.get(`/api/apps/${slug}`)).body.cloud.prs, null);
    const r = await me.post(`/api/apps/${slug}/watch/prs`, { on: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /imported from GitHub/);
  } finally {
    await t.stop();
  }
});

test('a launch check that passes on the branch and fails with the pull request', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ expo: { name: 'Mise', ios: { bundleIdentifier: 'com.example.mise' } } }));
  const state = { platforms: ['ios'], checklist: { 'ios-export': { done: true } }, lastScan: { findings: [{ id: 'ios-export', ok: true }] } };
  const problems = problemsIn(state, dir, new Set(['app.json']));
  assert.deepEqual(problems.map((p) => p.id), ['ios-export']);
  assert.match(problems[0].title, /: stops passing$/);
  assert.match(problems[0].detail, /ITSAppUsesNonExemptEncryption/);
  // One that already failed on the branch isn't this pull request's doing.
  state.lastScan.findings[0].ok = false;
  assert.deepEqual(problemsIn(state, dir, new Set(['app.json'])), []);
  assert.equal(statusText([]), 'No secret keys added, and no launch checks broken');
  assert.equal(statusText([{ title: 'A', detail: 'b' }, { title: 'C', detail: 'd' }]), '2 problems. A: b');
  assert.equal(statusText([{ title: 'A', detail: 'x'.repeat(300) }]).length, 140);
});
