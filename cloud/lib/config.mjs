// Liftoff Cloud settings, all from environment variables (see cloud/README.md).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MB = 1024 * 1024;

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
    // The model runs use unless the person picks another (see MODELS in lib/agent.mjs).
    runModel: env.LIFTOFF_RUN_MODEL || null,
    maxRunsPerUser: Number(env.LIFTOFF_MAX_ACTIVE_RUNS || 3),
    maxUploadBytes: Number(env.LIFTOFF_MAX_UPLOAD_MB || 50) * MB,
    maxSourceBytes: Number(env.LIFTOFF_MAX_SOURCE_MB || 200) * MB,
    maxSourceFiles: Number(env.LIFTOFF_MAX_SOURCE_FILES || 40000),
    // Only for tests and local development: lets verify and Pulse reach private addresses.
    allowPrivateFetch: env.LIFTOFF_ALLOW_PRIVATE_FETCH === '1' && !production,
    extraHosts: (env.LIFTOFF_EXTRA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
  };
}
