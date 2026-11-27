import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractTarGz, extractZip, safeRelPath, zipDirectory, ArchiveError } from '../lib/archive.mjs';
import { tarGz, tmpDir, FIXTURES } from './helpers.mjs';

test('safeRelPath refuses traversal and skips dependency folders', () => {
  assert.equal(safeRelPath('src/app.ts'), 'src/app.ts');
  assert.equal(safeRelPath('./src//app.ts'), 'src/app.ts');
  assert.equal(safeRelPath('node_modules/x/index.js'), null);
  assert.equal(safeRelPath('app/.git/config'), null);
  assert.equal(safeRelPath('.next/cache/x'), null);
  assert.throws(() => safeRelPath('../etc/passwd'), ArchiveError);
  assert.throws(() => safeRelPath('a/../../b'), ArchiveError);
  assert.throws(() => safeRelPath('/etc/passwd'), ArchiveError);
  assert.throws(() => safeRelPath('C:/Windows/x'), ArchiveError);
});

test('tarballs unpack without their top folder, skipping links and node_modules', () => {
  const dest = path.join(tmpDir(), 'out');
  const buf = tarGz([
    { name: 'acme-app-1a2b3c/package.json', content: '{"name":"acme"}' },
    { name: 'acme-app-1a2b3c/src/index.js', content: 'console.log(1)' },
    { name: 'acme-app-1a2b3c/node_modules/x/index.js', content: 'nope' },
    { name: 'acme-app-1a2b3c/evil-link', content: '', type: '2' },
  ]);
  const { files } = extractTarGz(buf, dest);
  assert.equal(files, 2);
  assert.equal(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), '{"name":"acme"}');
  assert.ok(fs.existsSync(path.join(dest, 'src/index.js')));
  assert.ok(!fs.existsSync(path.join(dest, 'node_modules')));
  assert.ok(!fs.existsSync(path.join(dest, 'evil-link')));
});

test('tarballs with ../ paths are refused', () => {
  const buf = tarGz([{ name: 'top/../../escape.txt', content: 'x' }]);
  assert.throws(() => extractTarGz(buf, path.join(tmpDir(), 'out')), ArchiveError);
});

test('size and file limits stop oversized archives', () => {
  const big = tarGz([{ name: 'top/a.bin', content: Buffer.alloc(2048) }, { name: 'top/b.bin', content: Buffer.alloc(2048) }]);
  assert.throws(() => extractTarGz(big, path.join(tmpDir(), 'o1'), { maxBytes: 3000 }), /MB of code/);
  assert.throws(() => extractTarGz(big, path.join(tmpDir(), 'o2'), { maxFiles: 1 }), /More than 1 files/);
  assert.throws(() => extractTarGz(Buffer.from('not gzip'), path.join(tmpDir(), 'o3')), /Could not read/);
  // A gzip bomb: 70 MB of zeros that compresses to almost nothing.
  assert.throws(() => extractTarGz(zlib.gzipSync(Buffer.alloc(70 * 1048576)), path.join(tmpDir(), 'o4'), { maxBytes: 1024 }), /too large/);
});

test('zipDirectory and extractZip round-trip a project', () => {
  const src = path.join(FIXTURES, 'next-saas');
  const zip = zipDirectory(src, { prefix: 'next-saas/' });
  const dest = path.join(tmpDir(), 'out');
  const { files } = extractZip(zip, dest);
  assert.ok(files > 0);
  const want = fs.readFileSync(path.join(src, 'package.json'), 'utf8');
  assert.equal(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), want);
});

test('zip entries that escape the folder are refused', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'fine');
  const zip = zipDirectory(dir);
  // Rewrite the stored name "ok.txt" to "../k.txt" in both headers (same length).
  const evil = Buffer.from(zip.toString('latin1').replaceAll('ok.txt', '../k.t'), 'latin1');
  assert.throws(() => extractZip(evil, path.join(tmpDir(), 'out')), ArchiveError);
  assert.throws(() => extractZip(Buffer.from('PK nonsense'), path.join(tmpDir(), 'out2')), ArchiveError);
});
