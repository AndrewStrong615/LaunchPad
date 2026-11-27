// Unpacking imported code (GitHub tarballs, uploaded zips) and packing a copy
// for Claude's sandbox, with no dependencies. Every entry path is checked so
// nothing lands outside the target folder, links are skipped, and size and
// file-count limits stop zip bombs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Folders that are rebuilt by tools and never needed to read or launch an app.
const SKIP_DIRS = new Set(['node_modules', '.git', '.liftoff', 'Pods', '.expo', '.gradle', 'DerivedData', '.turbo', '.vercel', '__MACOSX', '.dart_tool', '.pub-cache', 'venv', '.venv', '__pycache__']);
const SKIP_PATHS = [/^\.next\/cache(\/|$)/, /(^|\/)\.DS_Store$/];

export class ArchiveError extends Error {}

// Normalise an archive path, or return null if it must be skipped.
export function safeRelPath(name) {
  const clean = String(name).replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!clean || clean.includes('\0')) return null;
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) throw new ArchiveError(`Unsafe path in archive: ${name}`);
  const parts = clean.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new ArchiveError(`Unsafe path in archive: ${name}`);
  if (!parts.length) return null;
  if (parts.some((p) => SKIP_DIRS.has(p))) return null;
  const rel = parts.join('/');
  if (SKIP_PATHS.some((re) => re.test(rel))) return null;
  return rel;
}

function limitsFor(opts) {
  return { maxBytes: opts.maxBytes ?? 200 * 1048576, maxFiles: opts.maxFiles ?? 40000, bytes: 0, files: 0 };
}

function writeEntry(dest, rel, data, limits) {
  limits.files++;
  limits.bytes += data.length;
  if (limits.files > limits.maxFiles) throw new ArchiveError(`More than ${limits.maxFiles} files. Leave out build output and dependencies.`);
  if (limits.bytes > limits.maxBytes) throw new ArchiveError(`More than ${Math.round(limits.maxBytes / 1048576)} MB of code. Leave out build output and dependencies.`);
  const abs = path.join(dest, rel);
  const root = path.resolve(dest) + path.sep;
  if (!path.resolve(abs).startsWith(root)) throw new ArchiveError(`Unsafe path in archive: ${rel}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data, { mode: 0o644 });
}

// Drop a single shared top folder ("repo-main/…"), like GitHub tarballs and most zips have.
function topFolder(names) {
  const tops = new Set(names.map((n) => n.split('/')[0]));
  return tops.size === 1 && names.every((n) => n.includes('/')) ? [...tops][0] + '/' : '';
}

// ---------- tar.gz ----------

function octal(buf, start, len) {
  const s = buf.toString('latin1', start, start + len).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function cstr(buf, start, len) {
  return buf.toString('utf8', start, start + len).replace(/\0.*$/s, '');
}

function paxPath(data) {
  let i = 0;
  const text = data.toString('utf8');
  let found = null;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!len) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (rec.slice(0, eq) === 'path') found = rec.slice(eq + 1);
    i += len;
  }
  return found;
}

export function extractTarGz(buffer, dest, opts = {}) {
  const limits = limitsFor(opts);
  let tar;
  try {
    tar = zlib.gunzipSync(buffer, { maxOutputLength: limits.maxBytes + 64 * 1048576 });
  } catch (e) {
    throw new ArchiveError(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'The repository is too large to import.' : 'Could not read the repository archive.');
  }
  const entries = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const magic = h.toString('latin1', 257, 262);
    let name = cstr(h, 0, 100);
    if (magic === 'ustar') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = off + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      longName = paxPath(data);
      continue;
    }
    if (type === 'L') {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === 'g') continue;
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type === '0' || type === '\0' || type === '7') entries.push({ name, data });
    // Directories, links, devices: skipped.
  }
  for (const e of entries) safeRelPath(e.name); // refuse ../ before any top folder is stripped
  const strip = topFolder(entries.map((e) => e.name));
  for (const e of entries) {
    const rel = safeRelPath(e.name.slice(strip.length));
    if (rel) writeEntry(dest, rel, e.data, limits);
  }
  return { files: limits.files, bytes: limits.bytes };
}

// ---------- zip ----------

export function extractZip(buffer, dest, opts = {}) {
  const limits = limitsFor(opts);
  // End of central directory: last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError("That file isn't a zip.");
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  let p = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || p === 0xffffffff) throw new ArchiveError('Zip64 archives are not supported. Zip a smaller folder (leave out node_modules and build output).');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new ArchiveError('The zip is damaged.');
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const extAttr = buffer.readUInt32LE(p + 38);
    const localOff = buffer.readUInt32LE(p + 42);
    const name = buffer.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const unixMode = (extAttr >>> 16) & 0o170000;
    if (unixMode === 0o120000) continue; // symlink
    if (flags & 0x1) throw new ArchiveError('Encrypted zips are not supported.');
    entries.push({ name, method, compSize, size, localOff });
  }
  for (const e of entries) safeRelPath(e.name); // refuse ../ before any top folder is stripped
  const strip = topFolder(entries.map((e) => e.name).filter((n) => !n.startsWith('__MACOSX/')));
  for (const e of entries) {
    if (!e.name.startsWith(strip)) continue;
    const rel = safeRelPath(e.name.slice(strip.length));
    if (!rel) continue;
    if (e.size > limits.maxBytes) throw new ArchiveError(`${rel} is too large.`);
    const lh = e.localOff;
    if (lh + 30 > buffer.length || buffer.readUInt32LE(lh) !== 0x04034b50) throw new ArchiveError('The zip is damaged.');
    const start = lh + 30 + buffer.readUInt16LE(lh + 26) + buffer.readUInt16LE(lh + 28);
    const raw = buffer.subarray(start, start + e.compSize);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
      } catch {
        throw new ArchiveError(`Could not unpack ${rel}.`);
      }
    } else throw new ArchiveError(`${rel} uses a zip compression method that isn't supported (use standard Deflate).`);
    if (data.length !== e.size) throw new ArchiveError(`${rel} is damaged in the zip.`);
    writeEntry(dest, rel, data, limits);
  }
  return { files: limits.files, bytes: limits.bytes };
}

// ---------- zip writer ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs);
      } else if (e.isFile() && safeRelPath(rel)) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

// Zip a folder (Deflate, UTF-8 names), skipping the same folders imports skip.
export function zipDirectory(root, { prefix = '' } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const rel of listFiles(root)) {
    const data = fs.readFileSync(path.join(root, rel));
    const comp = zlib.deflateRawSync(data);
    const useDeflate = comp.length < data.length;
    const body = useDeflate ? comp : data;
    const name = Buffer.from(prefix + rel, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x0314, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
    if (offset > 0xffffffff) throw new ArchiveError('The app is too large to zip.');
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const n = central.length / 2;
  end.writeUInt16LE(n, 8);
  end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
