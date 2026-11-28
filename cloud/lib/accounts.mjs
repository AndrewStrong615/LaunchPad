// Each user's service accounts (the same list as the plugin's), stored
// encrypted on this server and mirrored into an Anthropic vault so Claude's
// sandbox only ever sees placeholders that turn into the real key on the way
// to that service's API.
import { ACCOUNTS } from '../../lib/catalog.mjs';
import { fingerprint } from './crypto.mjs';

// API hosts each account's keys may be sent to from Claude's sandbox. These
// are also the hosts the sandbox can reach (see agent.mjs).
export const ACCOUNT_HOSTS = {
  stripe: ['api.stripe.com'],
  revenuecat: ['api.revenuecat.com'],
  vercel: ['api.vercel.com'],
  cloudflare: ['api.cloudflare.com'],
  supabase: ['api.supabase.com'],
  posthog: ['us.posthog.com', 'eu.posthog.com', 'app.posthog.com'],
  sentry: ['sentry.io', 'us.sentry.io', 'de.sentry.io'],
  github: ['api.github.com', 'uploads.github.com'],
  expo: ['api.expo.dev'],
  resend: ['api.resend.com'],
};

// Identifiers that aren't secret and are used in URL paths, where vault
// substitution doesn't happen: given to Claude as plain values instead.
export const PLAIN_ENV = new Set(['CLOUDFLARE_ACCOUNT_ID', 'APP_STORE_CONNECT_KEY_ID', 'APP_STORE_CONNECT_ISSUER_ID']);

// Keys used to sign requests locally (App Store Connect .p8, Google service
// account JSON) can't work as placeholders; they go to CI as GitHub secrets.
export const SIGNING_ENV = new Set(['APP_STORE_CONNECT_KEY', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON']);

const MAX_VALUE = 20000;

// What a key looks like, so a typo or the wrong key is caught when it's
// typed, not later in Verify. Only formats the services have kept for years
// are checked; any other key just has to be one line with no spaces.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_FORMATS = {
  STRIPE_SECRET_KEY: {
    hint: 'sk_test_… or sk_live_…',
    check: (v) => (/^(sk|rk)_(test|live)_[A-Za-z0-9_]+$/.test(v) ? null
      : /^pk_/.test(v) ? 'That’s the publishable key (pk_…). Paste the secret key (sk_…) or a restricted key (rk_…) from the same page.'
        : 'That isn’t a Stripe secret key. Those start with sk_test_ or sk_live_ (rk_ for a restricted key).'),
  },
  REVENUECAT_API_KEY: {
    hint: 'sk_…',
    check: (v) => (/^(appl|goog|amzn|strp|rcb)_/.test(v) ? 'That’s a public app key. Paste a secret API key (sk_…) from your RevenueCat project’s API keys.' : null),
  },
  GITHUB_TOKEN: {
    hint: 'github_pat_… or ghp_…',
    check: (v) => (/^(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|[0-9a-f]{40})$/.test(v) ? null : 'That isn’t a GitHub token. Those start with github_pat_ or ghp_.'),
  },
  SUPABASE_ACCESS_TOKEN: {
    hint: 'sbp_…',
    check: (v) => (/^sbp_[A-Za-z0-9_]+$/.test(v) ? null : 'That isn’t a Supabase access token. Those start with sbp_ (a project’s anon or service_role key won’t work here).'),
  },
  POSTHOG_PERSONAL_API_KEY: {
    hint: 'phx_…',
    check: (v) => (/^phx_[A-Za-z0-9_]+$/.test(v) ? null
      : /^phc_/.test(v) ? 'That’s the project key (phc_…), which can’t read data. Paste a personal API key (phx_…).'
        : 'That isn’t a PostHog personal API key. Those start with phx_.'),
  },
  SENTRY_AUTH_TOKEN: {
    hint: 'sntryu_… or sntrys_…',
    check: (v) => (/^(sntry[su]_[A-Za-z0-9_=+/.-]+|[0-9a-f]{64})$/.test(v) ? null : 'That isn’t a Sentry auth token. Those start with sntryu_ or sntrys_.'),
  },
  RESEND_API_KEY: {
    hint: 're_…',
    check: (v) => (/^re_[A-Za-z0-9_]+$/.test(v) ? null : 'That isn’t a Resend API key. Those start with re_.'),
  },
  APP_STORE_CONNECT_KEY_ID: {
    hint: '10 letters and numbers',
    check: (v) => (/^[A-Z0-9]{10}$/.test(v) ? null : 'The key ID is the 10 letters and numbers next to the key in App Store Connect.'),
  },
  APP_STORE_CONNECT_ISSUER_ID: {
    hint: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    check: (v) => (UUID.test(v) ? null : 'The issuer ID is the long ID with dashes at the top of App Store Connect’s API keys page.'),
  },
  APP_STORE_CONNECT_KEY: {
    hint: 'The whole .p8 file',
    check: (v) => (/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(v) ? null : 'Paste the whole .p8 file, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----.'),
  },
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: {
    hint: 'The whole JSON key file',
    check: (v) => {
      let j;
      try {
        j = JSON.parse(v);
      } catch {
        return 'Paste the whole JSON key file you downloaded for the service account.';
      }
      return j?.type === 'service_account' && j.client_email && j.private_key ? null : 'That JSON isn’t a service account key. Download a JSON key for the service account in Google Cloud.';
    },
  },
};
const MULTILINE = new Set(['APP_STORE_CONNECT_KEY', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON']);

// Why a value can't be this key, or null when it looks right.
export function keyProblem(name, value) {
  const f = KEY_FORMATS[name];
  if (f) return f.check(value);
  if (!MULTILINE.has(name) && /\s/.test(value)) return `${name} is one line with no spaces. Copy it again from the service.`;
  return null;
}

export function listUserAccounts(store, uid) {
  const secrets = store.getSecrets(uid);
  return Object.entries(ACCOUNTS).map(([id, def]) => {
    const rec = secrets.accounts[id];
    return {
      id,
      label: def.label,
      note: def.note,
      url: def.url,
      fields: def.env,
      hints: Object.fromEntries(def.env.filter((k) => KEY_FORMATS[k]).map((k) => [k, KEY_FORMATS[k].hint])),
      connected:!!rec && def.env.every((k) => rec.values?.[k]),
      connectedAt: rec?.connectedAt || null,
      source: rec?.source || null,
      store: rec ? 'cloud' : null,
    };
  });
}

export const stripeConnected = (store, uid) => listUserAccounts(store, uid).some((a) => a.id === 'stripe' && a.connected);

export function connectUserAccount(store, uid, id, values, source = 'you') {
  const def = ACCOUNTS[id];
  if (!def) throw Object.assign(new Error(`Unknown account "${id}"`), { status: 404 });
  const clean = {};
  for (const k of def.env) {
    const v = typeof values?.[k] === 'string' ? values[k].trim() : '';
    if (!v) throw Object.assign(new Error(`Enter ${k} for ${def.label}.`), { status: 400 });
    if (v.length > MAX_VALUE) throw Object.assign(new Error(`${k} is too long.`), { status: 400 });
    const problem = keyProblem(k, v);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    clean[k] = store.encrypt(v);
  }
  const secrets = store.getSecrets(uid);
  secrets.accounts[id] = { connectedAt: new Date().toISOString(), source, values: clean };
  store.saveSecrets(uid, secrets);
}

export function disconnectUserAccount(store, uid, id) {
  if (!ACCOUNTS[id]) throw Object.assign(new Error(`Unknown account "${id}"`), { status: 404 });
  const secrets = store.getSecrets(uid);
  delete secrets.accounts[id];
  store.saveSecrets(uid, secrets);
}

// Decrypted keys for server-side checks (verify, Pulse), optionally only some accounts.
export function userEnv(store, uid, only = null) {
  const secrets = store.getSecrets(uid);
  const env = {};
  for (const [id, rec] of Object.entries(secrets.accounts)) {
    if (only && !only.includes(id)) continue;
    for (const [k, box] of Object.entries(rec.values || {})) {
      try {
        env[k] = store.decrypt(box);
      } catch {}
    }
  }
  return env;
}

export function connectedEnvNames(store, uid) {
  return Object.keys(userEnv(store, uid));
}

// What the sandbox will see: which variables are placeholders (vaulted), which
// are plain values, which are signing keys kept out of the sandbox.
export function sandboxEnvPlan(store, uid) {
  const env = userEnv(store, uid);
  const vaulted = [];
  const plain = {};
  const signing = [];
  for (const [id, def] of Object.entries(ACCOUNTS)) {
    for (const k of def.env) {
      if (!(k in env)) continue;
      if (PLAIN_ENV.has(k)) plain[k] = env[k];
      else if (SIGNING_ENV.has(k) || !ACCOUNT_HOSTS[id]) signing.push(k);
      else vaulted.push({ account: id, name: k, value: env[k], hosts: ACCOUNT_HOSTS[id] });
    }
  }
  return { vaulted, plain, signing };
}

// Make the user's Anthropic vault match their connected accounts. Creates the
// vault once, adds new or changed keys, archives removed ones. Returns the vault id
// (or null when no key needs a vault).
export async function syncVault(client, store, uid) {
  const { vaulted } = sandboxEnvPlan(store, uid);
  const secrets = store.getSecrets(uid);
  let vault = secrets.vault;
  if (!vault && !vaulted.length) return null;
  if (!vault) {
    const v = await client.beta.vaults.create({ display_name: `Liftoff ${uid}`, metadata: { liftoff_user: uid } });
    vault = { id: v.id, creds: {} };
    secrets.vault = vault;
    store.saveSecrets(uid, secrets);
  }
  // Saved after every change, so a failure part way never loses track of a credential.
  const persist = () => {
    const fresh = store.getSecrets(uid);
    fresh.vault = vault;
    store.saveSecrets(uid, fresh);
  };
  const want = new Map(vaulted.map((v) => [v.name, v]));
  for (const [name, cred] of Object.entries(vault.creds)) {
    const w = want.get(name);
    if (w && cred.hash === fingerprint(w.value, w.hosts.join(','))) continue;
    try {
      await client.beta.vaults.credentials.archive(cred.id, { vault_id: vault.id });
    } catch {}
    delete vault.creds[name];
    persist();
  }
  for (const w of want.values()) {
    if (vault.creds[w.name]) continue;
    const c = await client.beta.vaults.credentials.create(vault.id, {
      display_name: `${w.account} ${w.name}`,
      auth: {
        type: 'environment_variable',
        secret_name: w.name,
        secret_value: w.value,
        networking: { type: 'limited', allowed_hosts: w.hosts },
        injection_location: { header: true, body: false },
      },
    });
    vault.creds[w.name] = { id: c.id, hash: fingerprint(w.value, w.hosts.join(',')) };
    persist();
  }
  return vault.id;
}
