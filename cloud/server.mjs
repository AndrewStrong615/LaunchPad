#!/usr/bin/env node
// Liftoff Cloud: the Liftoff plugin as a web app. Start with `npm start` in cloud/
// (settings in cloud/README.md).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { makeKeys } from './lib/crypto.mjs';
import { Store } from './lib/store.mjs';
import { GitHub } from './lib/github.mjs';
import { createSafeFetch } from './lib/safe-fetch.mjs';
import { RunManager } from './lib/runs.mjs';
import { ProofRunner } from './lib/proof.mjs';
import { Billing } from './lib/billing.mjs';
import { Records } from './lib/records.mjs';
import { createApp } from './lib/app.mjs';
import { provision } from './lib/provision.mjs';

// Everything the routes need. Tests pass fakes for `anthropic`, `fetch`
// (GitHub, and Liftoff's own Stripe account), `safeFetch` (the services
// verify reaches) and `proof` options.
export async function buildContext(config, { anthropic, fetch, safeFetch, proof } = {}) {
  const store = new Store(config.dataDir, makeKeys(config.secret));
  fs.rmSync(path.join(config.dataDir, 'tmp'), { recursive: true, force: true });
  let client = anthropic;
  if (client === undefined && config.anthropic.configured) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    client = new Anthropic();
  }
  const ctx = {
    config,
    store,
    github: new GitHub(config, fetch || globalThis.fetch),
    safeFetch: safeFetch || createSafeFetch({ allowPrivate: config.allowPrivateFetch }),
    anthropic: client || null,
  };
  ctx.records = new Records(ctx);
  ctx.runs = new RunManager(ctx);
  ctx.proof = new ProofRunner(ctx, proof);
  ctx.billing = new Billing(ctx, fetch || globalThis.fetch);
  return ctx;
}

export async function startCloud(config = loadConfig(), deps = {}) {
  const ctx = await buildContext(config, deps);
  if (ctx.anthropic && config.anthropic.configured) {
    try {
      await provision(ctx.anthropic, config, { log: (m) => console.log(`[liftoff-cloud] ${m}`) });
    } catch (e) {
      console.error(`[liftoff-cloud] Couldn't set up the Claude agent: ${e.message}`);
    }
  }
  const server = http.createServer(createApp(ctx));
  server.requestTimeout = 10 * 60 * 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const resumed = ctx.runs.resumeAll();
  const stop = async () => {
    server.close();
    await ctx.runs.close();
  };
  return { server, ctx, stop, resumed, url: `http://localhost:${server.address().port}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const config = loadConfig();
  const { ctx, stop, resumed } = await startCloud(config);
  const ready = ctx.runs.readiness();
  console.log(`Liftoff Cloud on ${config.publicUrl} (listening on ${config.host}:${config.port})`);
  console.log(`  sign-in: ${ctx.github.oauthEnabled ? 'GitHub' : 'GitHub not set up'}${config.devLogin ? ' + local dev login' : ''}`);
  console.log(`  purchase test: ${ctx.proof.enabled ? `test browser at ${config.proof.url}` : config.proof.problem || 'off (set LIFTOFF_PROOF_URL and LIFTOFF_PROOF_SECRET)'}`);
  const pay = config.billing;
  console.log(`  Launch Pass: ${ctx.billing.enabled ? `$${pay.passUsd} with $${pay.claudeUsd} of Claude time (Stripe ${/^(sk|rk)_live_/.test(pay.secretKey) ? 'live' : 'test'} mode${pay.webhookSecret ? '' : ', no webhook secret'})` : 'off, everything is free (set LIFTOFF_STRIPE_SECRET_KEY)'}`);
  console.log(`  cloud runs: ${ready.ok ? `ready on ${ctx.runs.defaultModel()}${resumed ? `, following ${resumed} run(s)` : ''}` : ready.why}`);
  if (config.runModel && config.runModel !== ctx.runs.defaultModel()) console.log(`  LIFTOFF_RUN_MODEL=${config.runModel} isn't one of the models runs can use, so runs default to ${ctx.runs.defaultModel()}`);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, async () => {
      await stop();
      process.exit(0);
    });
  }
}
