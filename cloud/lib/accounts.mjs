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
      connected: !!rec && def.env.every((k) => rec.values?.[k]),
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
