// An app that's already live: its owner adds the address, and the free
// Verify checks the live site without a run.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { zipDirectory } from '../lib/archive.mjs';
import { validateLiveUrl } from '../lib/tools.mjs';
import { FIXTURES, signIn, startTest } from './helpers.mjs';

function fakeSite() {
  const seen = [];
  const fetch = async (url) => {
    const u = new URL(url);
    seen.push(u.href);
    const page = (status, body = '') => new Response(body, { status, headers: { 'content-type': 'text/html' } });
    if (u.host !== 'greenrow.app') return page(404);
    if (u.pathname === '/') return page(200, '<title>Greenrow</title><h1>Plan your garden</h1>');
    if (['/privacy', '/terms'].includes(u.pathname)) return page(200);
    return page(404);
  };
  return { fetch, seen };
}

test('the live address is checked and tidied', () => {
  assert.equal(validateLiveUrl('greenrow.app'), 'https://greenrow.app', 'a bare domain means https');
  assert.equal(validateLiveUrl(' https://greenrow.app/pricing?x=1 '), 'https://greenrow.app');
  assert.equal(validateLiveUrl('http://greenrow.app'), 'http://greenrow.app', 'Verify then reports that HTTPS is off');
  assert.equal(validateLiveUrl(''), null, 'empty removes it');
  for (const bad of ['not a url', 'localhost:3000', 'ftp://greenrow.app', 'https://me:pw@greenrow.app', 'javascript:alert(1)']) {
    assert.throws(() => validateLiveUrl(bad), /like https:\/\/myapp\.com/, bad);
  }
});

test('adding the live address lets the free Verify check the live site', async () => {
  const site = fakeSite();
  const t = await startTest({ safeFetch: site.fetch });
  try {
    const me = await signIn(t.base);
    const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
    const slug = (await me.call('POST', '/api/import/zip?name=greenrow.zip', zip, { 'content-type': 'application/zip' })).body.slug;
    const item = (app, id) => app.checklist.find((c) => c.id === id);

    // Before: nothing to check against.
    let r = await me.post(`/api/apps/${slug}/verify`);
    assert.equal(item(r.body, 'host-deploy').verify.ok, null);

    r = await me.post(`/api/apps/${slug}/live`, { url: 'nope' });
    assert.equal(r.status, 400);
    r = await me.post(`/api/apps/${slug}/live`, { url: 'greenrow.app' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.liveUrl, 'https://greenrow.app');
    assert.match(r.body.log.at(-1).msg, /Live address set to https:\/\/greenrow\.app/);

    r = await me.post(`/api/apps/${slug}/verify`);
    assert.equal(item(r.body, 'host-deploy').verify.ok, true, JSON.stringify(item(r.body, 'host-deploy').verify));
    assert.equal(item(r.body, 'host-deploy').by, 'verified');
    assert.equal(item(r.body, 'land-legal').verify.ok, true);
    assert.ok(site.seen.includes('https://greenrow.app/privacy'));

    // Saving it empty removes it.
    r = await me.post(`/api/apps/${slug}/live`, { url: '' });
    assert.equal(r.body.liveUrl, null);
    assert.equal(r.body.log.at(-1).msg, 'Live address removed');
  } finally {
    await t.stop();
  }
});
