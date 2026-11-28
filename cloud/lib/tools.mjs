// The Liftoff tools Claude calls during a cloud run. They run on this server,
// against the app's stored state and the user's stored keys, so the sandbox
// never holds Liftoff's records or a real key.
import fs from 'node:fs';
import path from 'node:path';
import {
  addDeploy, addTask, recordChange, setCheck, setConfig, setStep, summarize, CONFIG_KEYS,
} from '../../lib/state.mjs';
import { STEPS, accountsForStep, checklistFor } from '../../lib/catalog.mjs';
import { nextAction } from '../../lib/advice.mjs';
import { renderScaffold, SCAFFOLDS } from '../../lib/scaffold.mjs';
import { applyVerify, purchaseProvenByStripe, runVerify, VERIFIABLE } from '../../lib/verify.mjs';
import { collectPulse, recordPulse } from '../../lib/pulse.mjs';
import { walk } from '../../lib/scan.mjs';
import { ACCOUNT_HOSTS, listUserAccounts, sandboxEnvPlan, stripeConnected, userEnv } from './accounts.mjs';
import { githubToken } from './importer.mjs';
import { ROOT, SKILLS } from './agent.mjs';
import { HttpError } from './http.mjs';

// Items the server can prove; they're ticked only by verify or the pre-scan.
const PROVABLE = new Set([...VERIFIABLE, 'sec-keys']);

// The purchase flow test is proven from Stripe's records for web apps that pay
// through Stripe. Apps that sell through the stores (or Paddle, Lemon Squeezy)
// can't be checked that way yet, so Claude still records their test run.
function isProvable(state, item, stripe) {
  if (item === 'pay-e2e') return purchaseProvenByStripe(state, { stripeConnected: stripe });
  return PROVABLE.has(item);
}

const POSTHOG_HOSTS = ACCOUNT_HOSTS.posthog;
const ID_LIKE = /^[\w.-]{1,100}$/;

// Settings are interpolated into API URLs that carry the user's keys, so they
// are checked here: a setting can never send a key to another host.
export function validateSetting(key, value) {
  if (!CONFIG_KEYS[key]) throw new HttpError(400, `Unknown setting "${key}"`);
  const v = String(value ?? '').trim();
  if (!v) return '';
  const bad = (why) => {
    throw new HttpError(400, `${key}: ${why}`);
  };
  switch (key) {
    case 'posthog.host': {
      let u;
      try {
        u = new URL(v);
      } catch {
        bad('use a URL like https://us.posthog.com');
      }
      if (u.protocol !== 'https:' || !POSTHOG_HOSTS.includes(u.hostname) || (u.pathname !== '/' && u.pathname !== '')) bad(`use one of ${POSTHOG_HOSTS.map((h) => `https://${h}`).join(', ')}`);
      return `https://${u.hostname}`;
    }
    case 'github.repo':
      if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(v)) bad('use owner/name');
      return v;
    case 'health.path':
    case 'signup.path':
      if (!/^\/[\w./~-]{0,200}$/.test(v) || v.includes('..')) bad(`use a path like ${key === 'signup.path' ? '/signup' : '/api/health'}`);
      return v;
    case 'preview.url': {
      let u;
      try {
        u = new URL(v);
      } catch {
        bad('use a URL like https://my-app-git-main.vercel.app');
      }
      if (u.protocol !== 'https:' || u.username || u.password) bad('use an https URL without a username or password');
      return u.origin;
    }
    case 'email.domain':
      if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(v)) bad('use a domain like example.com');
      return v.toLowerCase();
    default:
      if (!ID_LIKE.test(v)) bad('letters, numbers, dots, dashes and underscores only');
      return v;
  }
}

// The address of an app that's already live, typed in by its owner so the
// free Verify can check it without a run (Pilot's deploys set it too, through
// liftoff_deploy). "myapp.com" means https://myapp.com. Verify fetches it
// through safeFetch, so it can't reach this server's own network.
export function validateLiveUrl(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const bad = () => {
    throw new HttpError(400, 'Use your site’s address, like https://myapp.com');
  };
  if (v.length > 500) bad();
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    bad();
  }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || !u.hostname.includes('.')) bad();
  return u.origin;
}

export function setLiveUrl(state, url) {
  if ((state.liveUrl || null) === url) return state;
  state.liveUrl = url;
  state.log.push({ at: new Date().toISOString(), msg: url ? `Live address set to ${url}` : 'Live address removed' });
  return state;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// The plan Claude works from: liftoff_plan's answer.
export function planFor(state, accounts, envPlan) {
  const summary = summarize(state, { accounts });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return {
    app: { name: state.name, framework: state.framework, platforms: state.platforms, auth: state.auth || null, payments: state.payments || [], packageManager: state.packageManager || null, apps: state.apps || [] },
    source: state.source ? { type: state.source.type, repo: state.source.fullName || null, branch: state.source.ref || null } : null,
    liveUrl: state.liveUrl,
    steps: summary.steps.map((s) => {
      const def = STEPS.find((x) => x.id === s.id);
      return {
        id: s.id,
        label: s.label,
        skill: s.skill,
        status: s.status,
        provider: s.provider || undefined,
        note: s.note || undefined,
        waitsOn: s.waitingOn.length ? s.waitingOn : undefined,
        accounts: accountsForStep(def, state.platforms).map((id) => ({ id, connected: !!byId.get(id)?.connected })),
        does: def.does,
      };
    }),
    canRunNow: summary.nextSteps,
    openTasks: state.tasks.filter((t) => !t.done).map((t) => ({ title: t.title, blocksRelease: t.blocksRelease || undefined, leadTime: t.leadTime })),
    settings: state.config || {},
    preScan: (state.lastScan?.findings || []).filter((f) => !f.ok).map((f) => ({ id: f.id, detail: f.detail })),
    keys: { inSandbox: envPlan.vaulted.map((v) => v.name), plain: Object.keys(envPlan.plain), signingForCI: envPlan.signing },
    deploys: state.deploys,
    nextAction: nextAction({ ...summary, pulse: state.pulse?.latest || null }),
  };
}

function checklistView(state, hasStripe) {
  return checklistFor(state.platforms).map((c) => {
    const cur = state.checklist[c.id] || {};
    return { id: c.id, category: c.category, title: c.title, done: !!cur.done, by: cur.by || undefined, verify: cur.verify ? `${cur.verify.ok === true ? 'pass' : cur.verify.ok === false ? 'FAIL' : 'not checked'}: ${cur.verify.detail}` : undefined, provable: isProvable(state, c.id, hasStripe) || undefined };
  });
}

// Server-side verify (and the Flight Board's Verify button).
// `extra` passes check options through, like { checkout } after a purchase test.
export async function verifyApp(ctx, uid, slug, only = null, extra = {}) {
  const snap = ctx.store.loadApp(uid, slug);
  if (!snap) throw new HttpError(404, 'No such app');
  const results = await runVerify(snap, {
    ...extra,
    env: userEnv(ctx.store, uid),
    files: walk(snap.root),
    only,
    fetch: ctx.safeFetch,
    repo: snap.config?.['github.repo'] || null,
  });
  const state = ctx.store.updateApp(uid, slug, (s) => applyVerify(s, results));
  return { state, results };
}

export async function pulseApp(ctx, uid, slug) {
  const snap = ctx.store.loadApp(uid, slug);
  if (!snap) throw new HttpError(404, 'No such app');
  const snapshot = await collectPulse(snap, { env: userEnv(ctx.store, uid), fetch: ctx.safeFetch });
  return ctx.store.updateApp(uid, slug, (s) => recordPulse(s, snapshot));
}

const str = (v, n = 500) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

// Each handler gets (ctx, run, input) and returns text for Claude. Throwing
// returns the message to Claude as an error result.
const HANDLERS = {
  liftoff_plan(ctx, run) {
    const state = ctx.store.loadApp(run.uid, run.slug);
    return planFor(state, listUserAccounts(ctx.store, run.uid), sandboxEnvPlan(ctx.store, run.uid));
  },

  liftoff_skill(ctx, run, input) {
    const name = str(input.name, 60);
    if (!SKILLS.includes(name)) throw new Error(`No skill "${name}". Skills: ${SKILLS.join(', ')}`);
    return fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  },

  liftoff_template(ctx, run, input) {
    const kind = str(input.kind, 40);
    if (!SCAFFOLDS[kind]) throw new Error(`No template "${kind}". Templates: ${Object.keys(SCAFFOLDS).join(', ')}`);
    const state = ctx.store.loadApp(run.uid, run.slug);
    return renderScaffold(kind, state).map((f) => `=== ${f.path} ===\n${f.content}`).join('\n\n');
  },

  liftoff_step(ctx, run, input) {
    const step = str(input.step, 60);
    let out;
    ctx.store.updateApp(run.uid, run.slug, (s) => {
      setStep(s, step, str(input.status, 20), {
        provider: input.provider === undefined ? undefined : str(input.provider, 60) || null,
        note: input.note === undefined ? undefined : str(input.note, 300) || null,
        force: input.force === true,
      });
      out = { step, ...s.steps[step] };
    });
    return out;
  },

  liftoff_task(ctx, run, input) {
    const title = str(input.title, 300);
    if (!title) throw new Error('title is required');
    let url = str(input.url, 500) || undefined;
    if (url && !/^https:\/\//.test(url)) url = undefined;
    let task;
    ctx.store.updateApp(run.uid, run.slug, (s) => {
      const dup = s.tasks.find((t) => !t.done && t.title === title);
      task = dup || addTask(s, title, { blocksRelease: input.blocks_release === true, owner: 'you', url });
    });
    return { added: task.title, id: task.id, blocksRelease: task.blocksRelease };
  },

  liftoff_checklist(ctx, run) {
    return checklistView(ctx.store.loadApp(run.uid, run.slug), stripeConnected(ctx.store, run.uid));
  },

  liftoff_check(ctx, run, input) {
    const item = str(input.item, 60);
    const done = input.done !== false;
    if (done && isProvable(ctx.store.loadApp(run.uid, run.slug), item, stripeConnected(ctx.store, run.uid))) {
      if (item === 'pay-e2e') throw new Error('"pay-e2e" is proven from Stripe\'s records, not ticked by hand. Once the test ids are in the app and a preview that uses Stripe test keys is deployed (preview.url), call liftoff_prove_purchase: Liftoff runs the purchase in a real browser and checks Stripe. If the test already ran in CI, liftoff_verify (only: ["pay-e2e"]) looks in Stripe test mode for that paid Checkout and its cancellation.');
      throw new Error(`"${item}" is checked against the real service. Prove it with liftoff_verify (only: ["${item}"]) instead.`);
    }
    let out;
    ctx.store.updateApp(run.uid, run.slug, (s) => {
      out = setCheck(s, item, done, 'claude');
    });
    return { item, ...out };
  },

  liftoff_record(ctx, run, input) {
    const value = str(input.value, 300);
    if (!value) throw new Error('value is required');
    let list;
    ctx.store.updateApp(run.uid, run.slug, (s) => {
      list = recordChange(s, str(input.step, 60), str(input.kind, 20), value);
    });
    return { recorded: value, step: input.step, total: list.length };
  },

  liftoff_deploy(ctx, run, input) {
    const platform = str(input.platform, 20);
    if (!['web', 'ios', 'android'].includes(platform)) throw new Error('platform must be web, ios or android');
    let url = str(input.url, 500) || null;
    if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new Error('url must be an http(s) URL');
    const status = ['live', 'processing', 'failed'].includes(input.status) ? input.status : 'live';
    let deploy;
    ctx.store.updateApp(run.uid, run.slug, (s) => {
      deploy = addDeploy(s, { target: str(input.target, 60) || platform, platform, url, version: str(input.version, 60) || null, status });
      s.log.push({ at: deploy.at, msg: `Deployed ${deploy.target}${url ? ` → ${url}` : ''} (${status})` });
    });
    return deploy;
  },

  liftoff_set(ctx, run, input) {
    const key = str(input.key, 60);
    const value = validateSetting(key, input.value);
    let config;
    ctx.store.updateApp(run.uid, run.slug, (s) => {
      config = setConfig(s, key, value || null);
    });
    return config;
  },

  async liftoff_verify(ctx, run, input) {
    const only = Array.isArray(input.only) && input.only.length ? input.only.map((x) => str(x, 60)).filter(Boolean) : null;
    const { results } = await verifyApp(ctx, run.uid, run.slug, only);
    return results.map((r) => `${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP'} ${r.id}: ${r.detail}`).join('\n') || 'No verifiable items apply.';
  },

  async liftoff_prove_purchase(ctx, run) {
    if (!ctx.proof) throw new Error("Liftoff's test browser isn't available on this server.");
    const rec = await ctx.proof.start(run.uid, run.slug).done;
    const lines = [`${rec.status.toUpperCase()}: ${rec.detail}`, ...rec.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`)];
    if (rec.status === 'passed') lines.push('pay-e2e is ticked as verified. Screenshots of each step are on the Flight Board.');
    if (rec.status === 'failed') lines.push('Fix what failed on your branch, deploy the preview again, then call liftoff_prove_purchase again. Screenshots of each step are on the Flight Board.');
    if (rec.status === 'error') lines.push("This stopped for a reason outside the app's code. Tell the user what it says; don't change code because of it.");
    return lines.join('\n');
  },

  async open_pull_request(ctx, run, input) {
    const state = ctx.store.loadApp(run.uid, run.slug);
    if (state.source?.type !== 'github') throw new Error('This app was uploaded, not imported from GitHub. Write the patch and zip to /mnt/session/outputs instead.');
    const branch = str(input.branch, 200);
    if (branch !== run.branch && !branch.startsWith('liftoff/')) throw new Error(`Push your work to ${run.branch} and open the pull request from it.`);
    const token = githubToken(ctx.store, run.uid);
    if (!token) throw new Error('No GitHub sign-in for this user. Push the branch and tell the user to open the pull request.');
    const { owner, repo, ref } = state.source;
    const body = `${str(input.body, 20000)}\n\n---\n_Opened by Liftoff Cloud for a launch run. Review before merging._`;
    let pr;
    try {
      pr = await ctx.github.createPullRequest(token, owner, repo, { head: branch, base: ref, title: str(input.title, 200) || 'Launch setup by Liftoff', body, draft: true });
    } catch (e) {
      pr = await ctx.github.findOpenPullRequest(token, owner, repo, branch).catch(() => null);
      if (!pr) throw new Error(`GitHub refused the pull request: ${e.message}. Check that ${branch} was pushed.`);
    }
    run.pr = { number: pr.number, url: pr.html_url, branch };
    ctx.store.updateApp(run.uid, run.slug, (s) => {
      if (!s.tasks.some((t) => t.url === pr.html_url)) addTask(s, `Review and merge Liftoff's pull request #${pr.number}`, { url: pr.html_url, owner: 'you' });
      s.log.push({ at: new Date().toISOString(), msg: `Opened pull request #${pr.number}` });
    });
    return { number: pr.number, url: pr.html_url, draft: pr.draft };
  },
};

// Tools that wait on the user before they run (see runs.mjs).
export const NEEDS_APPROVAL = {
  github_set_secret(ctx, run, input) {
    const state = ctx.store.loadApp(run.uid, run.slug);
    return `Copy your ${str(input.from, 80)} into the GitHub Actions secret ${str(input.name, 100)} on ${state.source?.fullName || 'the repo'}`;
  },
};

HANDLERS.github_set_secret = async (ctx, run, input) => {
  const state = ctx.store.loadApp(run.uid, run.slug);
  if (state.source?.type !== 'github') throw new Error('Only GitHub apps have Actions secrets.');
  const name = str(input.name, 100);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith('GITHUB_')) throw new Error('Secret names are upper-case letters, digits and underscores, and cannot start with GITHUB_.');
  const from = str(input.from, 100);
  const value = userEnv(ctx.store, run.uid)[from];
  if (!value) throw new Error(`${from} is not connected. Add a task asking the user to connect it.`);
  const token = githubToken(ctx.store, run.uid);
  if (!token) throw new Error('No GitHub sign-in for this user.');
  await ctx.github.setActionsSecret(token, state.source.owner, state.source.repo, name, value);
  ctx.store.updateApp(run.uid, run.slug, (s) => s.log.push({ at: new Date().toISOString(), msg: `Set GitHub secret ${name}` }));
  return `Set ${name} on ${state.source.fullName}.`;
};

export async function runTool(ctx, run, name, input = {}) {
  const fn = HANDLERS[name];
  if (!fn) return { text: `Unknown tool ${name}`, isError: true };
  try {
    const out = await fn(ctx, run, input || {});
    const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
    return { text: clip(text, 60000), isError: false };
  } catch (e) {
    return { text: e.message || String(e), isError: true };
  }
}

// One line for the run's activity feed.
export function describeTool(name, input = {}) {
  const i = input || {};
  switch (name) {
    case 'liftoff_plan': return 'Read the launch plan';
    case 'liftoff_skill': return `Read the ${i.name} skill`;
    case 'liftoff_template': return `Got the ${i.kind} template`;
    case 'liftoff_step': return `${i.step} → ${i.status}${i.note ? `: ${i.note}` : ''}`;
    case 'liftoff_task': return `Added a task for you: ${i.title}`;
    case 'liftoff_checklist': return 'Read the readiness checklist';
    case 'liftoff_check': return `${i.done === false ? 'Unticked' : 'Ticked'} ${i.item}`;
    case 'liftoff_record': return `Recorded ${i.kind} ${i.value}`;
    case 'liftoff_deploy': return `Recorded a ${i.platform} deploy${i.url ? ` at ${i.url}` : ''}`;
    case 'liftoff_set': return `Set ${i.key}`;
    case 'liftoff_prove_purchase': return "Ran the purchase test in Liftoff's browser";
    case 'liftoff_verify': return `Verified ${Array.isArray(i.only) && i.only.length ? i.only.join(', ') : 'the checklist'} against the live services`;
    case 'open_pull_request': return `Opened a pull request from ${i.branch}`;
    case 'github_set_secret': return `Set GitHub secret ${i.name}`;
    case 'ask_user': return `Asked: ${i.question}`;
    case 'bash': return clip(String(i.command || ''), 300);
    case 'read': case 'write': case 'edit': return `${name} ${i.file_path || i.path || ''}`.trim();
    case 'glob': case 'grep': return `${name} ${i.pattern || ''}`.trim();
    default: return name;
  }
}
