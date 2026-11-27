// Bring an app's code in (GitHub repo or zip), read it with the plugin's
// detection, and run the scans that need no accounts: the App Store pre-scan
// and leaked-secret scan. The result is the same state the plugin keeps.
import fs from 'node:fs';
import path from 'node:path';
import { detectProject, slugify } from '../../lib/detect.mjs';
import { refreshState, shallowFiles } from '../../lib/state.mjs';
import { applyScan, scanSecrets, storeScan } from '../../lib/scan.mjs';
import { extractTarGz, extractZip, ArchiveError } from './archive.mjs';
import { parseRepoUrl } from './github.mjs';
import { HttpError } from './http.mjs';

export function githubToken(store, uid) {
  const secrets = store.getSecrets(uid);
  const box = secrets.accounts.github?.values?.GITHUB_TOKEN || secrets.github;
  if (!box) return null;
  try {
    return store.decrypt(box);
  } catch {
    return null;
  }
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

// Scans that run on the imported copy: App Store pre-scan and secrets in code.
export function scanSource(state) {
  const findings = storeScan(state.root, state);
  const hits = scanSecrets(state.root);
  findings.push({
    id: 'sec-keys',
    ok: hits.length === 0,
    detail: hits.length
      ? hits.slice(0, 3).map((h) => `${h.kind} in ${h.file}`).join('; ') + (hits.length > 3 ? ` (+${hits.length - 3} more)` : '')
      : 'no secret keys in client code or build output',
  });
  applyScan(state, findings);
  return findings;
}

function uniqueSlug(store, uid, base) {
  const taken = new Set(store.listApps(uid));
  let slug = slugify(base).slice(0, 50) || 'app';
  if (!taken.has(slug)) return slug;
  for (let i = 2; ; i++) if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`;
}

function sameGithubApp(store, uid, fullName) {
  return store.listApps(uid).find((slug) => {
    const s = store.loadApp(uid, slug);
    return s?.source?.type === 'github' && s.source.fullName.toLowerCase() === fullName.toLowerCase();
  });
}

// Move freshly unpacked code into place and build or refresh the app's state.
function finish(store, uid, tmpSrc, source, slug = null) {
  if (!fs.existsSync(tmpSrc) || countFiles(tmpSrc) === 0) throw new HttpError(400, 'No files found. Leave node_modules and build output out, but include the app itself.');
  const first = detectProject(tmpSrc);
  // With no package name to go on, detection names the app after its folder ("src").
  const fallbackName = source.repo || String(source.filename || 'app').replace(/\.zip$/i, '');
  slug ||= (source.type === 'github' && sameGithubApp(store, uid, source.fullName)) || uniqueSlug(store, uid, first.slug === 'src' ? fallbackName : first.slug);
  const dest = store.sourceDir(uid, slug);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const old = fs.existsSync(dest) ? `${dest}.old-${Date.now()}` : null;
  if (old) fs.renameSync(dest, old);
  fs.renameSync(tmpSrc, dest);
  if (old) fs.rmSync(old, { recursive: true, force: true });

  const existing = store.loadApp(uid, slug);
  const detected = detectProject(dest);
  const state = refreshState(existing, detected, shallowFiles(dest));
  state.root = dest;
  state.slug = slug;
  if (!existing && slugify(state.name) === 'src') state.name = fallbackName;
  if (source.type === 'github') state.config['github.repo'] ||= source.fullName;
  state.source = { ...source, importedAt: new Date().toISOString() };
  scanSource(state);
  const where = source.type === 'github' ? `${source.fullName}@${source.ref}` : source.filename;
  state.log.push({ at: new Date().toISOString(), msg: `${existing ? 'Rescanned' : 'Imported'} ${where}: ${state.framework}, ${state.platforms.join(', ')}` });
  store.saveApp(uid, state);
  return state;
}

export async function importFromGitHub({ store, github, config }, uid, { url, ref, slug = null }) {
  const parsed = parseRepoUrl(url);
  if (!parsed) throw new HttpError(400, 'Paste a GitHub repository link, like https://github.com/you/app.');
  const token = githubToken(store, uid);
  const info = await github.getRepo(token, parsed.owner, parsed.repo);
  const branch = String(ref || parsed.ref || info.default_branch || 'main').trim();
  if (!/^[\w./-]{1,200}$/.test(branch) || branch.includes('..')) throw new HttpError(400, 'That branch name looks wrong.');
  const tarball = await github.downloadTarball(token, info.owner.login, info.name, branch, config.maxSourceBytes);
  const commit = await github.latestCommit(token, info.owner.login, info.name, branch);
  const tmp = store.tmpDir();
  try {
    extractTarGz(tarball, path.join(tmp, 'src'), { maxBytes: config.maxSourceBytes, maxFiles: config.maxSourceFiles });
    return finish(store, uid, path.join(tmp, 'src'), {
      type: 'github',
      owner: info.owner.login,
      repo: info.name,
      fullName: info.full_name,
      url: info.html_url,
      ref: branch,
      defaultBranch: info.default_branch,
      private: !!info.private,
      commit,
    }, slug);
  } catch (e) {
    if (e instanceof ArchiveError) throw new HttpError(400, e.message);
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function importFromZip({ store, config }, uid, buffer, filename, slug = null) {
  const tmp = store.tmpDir();
  try {
    const name = String(filename || 'app.zip').replace(/[^\w .()-]/g, '').slice(0, 120) || 'app.zip';
    const { bytes } = extractZip(buffer, path.join(tmp, 'src'), { maxBytes: config.maxSourceBytes, maxFiles: config.maxSourceFiles });
    return finish(store, uid, path.join(tmp, 'src'), { type: 'upload', filename: name, bytes }, slug);
  } catch (e) {
    if (e instanceof ArchiveError) throw new HttpError(400, e.message);
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Rescan: fetch the code again (GitHub) or re-read the stored copy (upload).
export async function rescan(ctx, uid, slug) {
  const state = ctx.store.loadApp(uid, slug);
  if (!state) throw new HttpError(404, 'No such app');
  if (state.source?.type === 'github') return importFromGitHub(ctx, uid, { url: state.source.fullName, ref: state.source.ref, slug });
  const detected = detectProject(state.root);
  refreshState(state, detected, shallowFiles(state.root));
  state.root = ctx.store.sourceDir(uid, slug);
  state.slug = slug;
  scanSource(state);
  state.log.push({ at: new Date().toISOString(), msg: 'Rescanned the uploaded code' });
  return ctx.store.saveApp(uid, state);
}
