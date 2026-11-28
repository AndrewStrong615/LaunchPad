// Liftoff Cloud settings, all from environment variables (see cloud/README.md).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assistantName, tokensPerUsd } from './brand.mjs';

const MB = 1024 * 1024;
const positive = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8787);
  const dataDir = path.resolve(env.LIFTOFF_DATA_DIR || path.join(process.cwd(), 'data'));
  // Render sets RENDER_EXTERNAL_URL to the service's own https address.
  const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const production = env.NODE_ENV === 'production';
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // The master secret encrypts stored keys and signs cookies. Production must set it;
  // locally one is generated once and kept in the data folder.
  let secret = env.LIFTOFF_CLOUD_SECRET || null;
  if (!secret) {
    if (production) throw new Error('Set LIFTOFF_CLOUD_SECRET (32+ random characters) in production.');
    const file = path.join(dataDir, 'secret.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
    secret = fs.readFileSync(file, 'utf8').trim();
  }
  if (secret.length < 32) throw new Error('LIFTOFF_CLOUD_SECRET must be at least 32 characters.');

  // Liftoff's test browser (proof/), a private service. Render's blueprint
  // gives its address as host:port.
  let proofUrl = (env.LIFTOFF_PROOF_URL || '').trim().replace(/\/+$/, '') || null;
  if (proofUrl && !/^https?:\/\//.test(proofUrl)) proofUrl = `http://${proofUrl}`;
  const proofSecret = env.LIFTOFF_PROOF_SECRET || '';
  // A missing secret turns the test off instead of stopping the whole site.
  const proofProblem = proofUrl && proofSecret.length < 32 ? 'LIFTOFF_PROOF_URL is set but LIFTOFF_PROOF_SECRET (32+ characters, the same on the test browser) is not' : null;

  // Agent and environment ids come from the environment or from `npm run setup`.
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent.json'), 'utf8'));
  } catch {}

  return {
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    production,
    dataDir,
    secret,
    github: {
      clientId: env.GITHUB_CLIENT_ID || null,
      clientSecret: env.GITHUB_CLIENT_SECRET || null,
      api: env.GITHUB_API_URL || 'https://api.github.com',
      web: env.GITHUB_WEB_URL || 'https://github.com',
    },
    // A one-click local sign-in for running Liftoff Cloud on your own machine.
    devLogin: env.LIFTOFF_DEV_LOGIN === '1' && !production,
    anthropic: {
      configured: !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
      agentId: env.LIFTOFF_AGENT_ID || saved.agentId || null,
      // Ids given as env vars are managed by you; otherwise the server creates and updates them.
      managed: !env.LIFTOFF_AGENT_ID,
      savedHash: saved.hash || null,
      environmentId: env.LIFTOFF_ENVIRONMENT_ID || saved.environmentId || null,
      workspace: env.ANTHROPIC_WORKSPACE_ID || 'default',
    },
    runBudgetUsd: Number(env.LIFTOFF_RUN_BUDGET_USD || 15),
    // The model runs use unless the person picks another: a model id or a mode
    // (see MODELS in lib/agent.mjs).
    runModel: env.LIFTOFF_RUN_MODEL || null,
    // What people see (lib/brand.mjs): the assistant's name, and how many
    // tokens make a dollar of model spend.
    assistant: assistantName(env.LIFTOFF_ASSISTANT_NAME),
    tokensPerUsd: tokensPerUsd(env.LIFTOFF_TOKENS_PER_USD),
    maxRunsPerUser: Number(env.LIFTOFF_MAX_ACTIVE_RUNS || 3),
    maxUploadBytes: Number(env.LIFTOFF_MAX_UPLOAD_MB || 50) * MB,
    maxSourceBytes: Number(env.LIFTOFF_MAX_SOURCE_MB || 200) * MB,
    maxSourceFiles: Number(env.LIFTOFF_MAX_SOURCE_FILES || 40000),
    // Only for tests and local development: lets verify and Pulse reach private addresses.
    allowPrivateFetch: env.LIFTOFF_ALLOW_PRIVATE_FETCH === '1' && !production,
    // Ask each service whether a key works when it's connected (one read-only
    // request). Tests turn it off so they never reach real services.
    checkKeys: env.LIFTOFF_CHECK_KEYS !== '0',
    proof: { url: proofProblem ? null : proofUrl, secret: proofProblem || !proofUrl ? null : proofSecret, problem: proofProblem },
    // GitHub logins that can read the run records (lib/records.mjs).
    adminLogins: (env.LIFTOFF_ADMIN_LOGINS || '').split(',').map((l) => l.trim().toLowerCase()).filter(Boolean),
    extraHosts: (env.LIFTOFF_EXTRA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
    // Watching launched apps (lib/watch.mjs): uptime every few minutes, every
    // check again once a day. Runs inside this server, so it needs no worker.
    watch: {
      on: env.LIFTOFF_WATCH !== '0',
      uptimeMinutes: positive(env.LIFTOFF_UPTIME_MINUTES, 5),
      dailyHours: positive(env.LIFTOFF_DAILY_CHECK_HOURS, 24),
      // How often open pull requests are looked at, where checking them is on (lib/prs.mjs).
      prMinutes: positive(env.LIFTOFF_PR_CHECK_MINUTES, 10),
    },
    // The Launch Pass and Pro, paid through Liftoff's own Stripe account. Off until the key is set.
    billing: {
      secretKey: env.LIFTOFF_STRIPE_SECRET_KEY || null,
      webhookSecret: env.LIFTOFF_STRIPE_WEBHOOK_SECRET || null,
      passUsd: positive(env.LIFTOFF_PASS_USD, 149),
      // Pro, the monthly plan per app for watching it (lib/watch.mjs).
      proUsd: positive(env.LIFTOFF_PRO_USD, 29),
      claudeUsd: positive(env.LIFTOFF_PASS_CLAUDE_USD, 50),
      freeLogins: (env.LIFTOFF_FREE_LOGINS || '').split(',').map((l) => l.trim().toLowerCase()).filter(Boolean),
      api: 'https://api.stripe.com',
    },
  };
}
