// GitHub: sign-in (OAuth), listing repos, downloading code, opening pull
// requests and setting Actions secrets. Every call takes the user's token.
import { HttpError } from './http.mjs';

const UA = 'LiftoffCloud/1.0';

// "https://github.com/acme/app", "github.com/acme/app/tree/dev", "acme/app", "git@github.com:acme/app.git"
export function parseRepoUrl(input) {
  const s = String(input || '').trim();
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^?#]+))?\/?(?:[?#].*)?$/);
  if (!m) m = s.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!m) m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  const [, owner, repo, ref] = m;
  if (owner.startsWith('.') || repo.startsWith('.')) return null;
  return { owner, repo, ref: ref ? decodeURIComponent(ref).replace(/\/+$/, '') : null };
}

export class GitHub {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.cfg = config.github;
    this.fetch = fetchImpl;
    this.redirectUri = `${config.publicUrl}/auth/github/callback`;
  }

  get oauthEnabled() {
    return !!(this.cfg.clientId && this.cfg.clientSecret);
  }

  authorizeUrl(state) {
    const q = new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: this.redirectUri, scope: 'repo read:user', state, allow_signup: 'true' });
    return `${this.cfg.web}/login/oauth/authorize?${q}`;
  }

  async exchangeCode(code) {
    const res = await this.fetch(`${this.cfg.web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code, redirect_uri: this.redirectUri }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new HttpError(400, body.error_description || 'GitHub sign-in failed');
    return { token: body.access_token, scope: body.scope || '' };
  }

  // Takes back the access the user gave Liftoff Cloud on GitHub (the OAuth
  // grant), so it no longer shows under their authorized apps.
  async revokeGrant(token) {
    if (!this.oauthEnabled || !token) return false;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await this.fetch(`${this.cfg.api}/applications/${encodeURIComponent(this.cfg.clientId)}/grant`, {
      method: 'DELETE',
      headers: { accept: 'application/vnd.github+json', authorization: `Basic ${basic}`, 'content-type': 'application/json', 'user-agent': UA, 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(15000),
    });
    return res.status === 204 || res.status === 404;
  }

  async api(token, pathname, { method = 'GET', body, accept = 'application/vnd.github+json', raw = false, timeout = 20000 } = {}) {
    const headers = { accept, 'user-agent': UA, 'x-github-api-version': '2022-11-28' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetch(`${this.cfg.api}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    if (raw) return res;
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.message || `GitHub answered ${res.status}`;
      const status = res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 403 : 502;
      throw new HttpError(status, res.status === 404 ? `GitHub couldn't find that (${msg}). For a private repo, sign in with GitHub or connect a GitHub token.` : msg);
    }
    return data;
  }

  getUser(token) {
    return this.api(token, '/user');
  }

  async listRepos(token) {
    const repos = await this.api(token, '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    return repos.map((r) => ({ fullName: r.full_name, owner: r.owner.login, repo: r.name, private: r.private, defaultBranch: r.default_branch, pushedAt: r.pushed_at, description: r.description, url: r.html_url }));
  }

  getRepo(token, owner, repo) {
    return this.api(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  async latestCommit(token, owner, repo, ref) {
    try {
      const c = await this.api(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`);
      return c.sha;
    } catch {
      return null;
    }
  }

  // The repo at `ref` as a .tar.gz buffer, refusing anything over maxBytes.
  async downloadTarball(token, owner, repo, ref, maxBytes) {
    const res = await this.api(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(ref)}`, { raw: true, timeout: 120000 });
    if (!res.ok) {
      if (res.status === 404) throw new HttpError(404, `GitHub couldn't find ${owner}/${repo}@${ref}. For a private repo, sign in with GitHub or connect a GitHub token.`);
      throw new HttpError(502, `GitHub answered ${res.status} when downloading the code`);
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new HttpError(413, 'The repository is too large to import.');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, 'The repository is too large to import.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  createPullRequest(token, owner, repo, { head, base, title, body, draft = true }) {
    return this.api(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, { method: 'POST', body: { head, base, title, body, draft } });
  }

  async findOpenPullRequest(token, owner, repo, head) {
    const list = await this.api(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
    return list[0] || null;
  }

  // Store a GitHub Actions secret. The value is sealed with the repo's public key
  // (libsodium sealed box), as GitHub requires, before it leaves this server.
  async setActionsSecret(token, owner, repo, name, value) {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/secrets`;
    const key = await this.api(token, `${base}/public-key`);
    const { default: sodium } = await import('libsodium-wrappers');
    await sodium.ready;
    const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
    await this.api(token, `${base}/${encodeURIComponent(name)}`, { method: 'PUT', body: { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: key.key_id } });
  }
}
