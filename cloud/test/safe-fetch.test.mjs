import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSafeFetch, isBlockedAddress } from '../lib/safe-fetch.mjs';

test('private, loopback, link-local and metadata addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.32.0.1']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('safe fetch refuses private hosts by address and by name', async () => {
  const f = createSafeFetch();
  await assert.rejects(f('http://127.0.0.1:1/'), /private address/);
  await assert.rejects(f('http://[::1]:1/'), /private address/);
  await assert.rejects(f('http://localhost:1/'), /private address/);
  await assert.rejects(f('file:///etc/passwd'), /Only http and https/);
});

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('redirects are followed hop by hop and drop credentials across origins', async () => {
  let seenAuth = 'unset';
  const b = await server((req, res) => {
    seenAuth = req.headers.authorization || null;
    res.end('landed');
  });
  const a = await server((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${b.address().port}/next` });
    res.end();
  });
  try {
    const f = createSafeFetch({ allowPrivate: true });
    const res = await f(`http://127.0.0.1:${a.address().port}/`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'landed');
    assert.equal(seenAuth, null);
    const manual = await f(`http://127.0.0.1:${a.address().port}/`, { redirect: 'manual' });
    assert.equal(manual.status, 302);
    // Without allowPrivate, a redirect into a private address is refused at that hop.
    await assert.rejects(createSafeFetch()(`http://127.0.0.1:${a.address().port}/`), /private address/);
  } finally {
    a.close();
    b.close();
  }
});

test('responses over the size cap are cut off', async () => {
  const s = await server((req, res) => res.end(Buffer.alloc(4096, 97)));
  try {
    const f = createSafeFetch({ allowPrivate: true, maxBytes: 1000 });
    await assert.rejects(f(`http://127.0.0.1:${s.address().port}/`), /too large/);
  } finally {
    s.close();
  }
});
