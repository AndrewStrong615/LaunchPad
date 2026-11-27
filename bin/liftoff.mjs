#!/usr/bin/env node
// Liftoff command line. The plugin's slash commands call this to read and
// record launch progress; you can run it yourself too.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ACCOUNTS, STEPS, accountsFor, accountsForStep, needsFor, stepsFor } from '../lib/catalog.mjs';
import {
  CONFIG_KEYS, addDeploy, addTask, connectAccount, credentialEnv, disconnectAccount, findProject, initProject,
  listAccounts, listProjects, loadState, migrateToKeychain, recordChange, removeTask, resetStep, saveState,
  secretStore, setCheck, setConfig, setStep, setTaskDone, summarize, undoPlan, waitingOn,
} from '../lib/state.mjs';
import { startServer } from '../lib/server.mjs';
import { applyVerify, runVerify } from '../lib/verify.mjs';
import { applyScan, storeScan, walk } from '../lib/scan.mjs';
import { collectPulse, recordPulse, revenueOf } from '../lib/pulse.mjs';
import { nextAction } from '../lib/advice.mjs';
import { costReport } from '../lib/costs.mjs';
import { renderScaffold } from '../lib/scaffold.mjs';


const HELP = `liftoff: launch your app and track it in Mission Control

  liftoff init [dir]                       read the app, create .liftoff/state.json, register it
  liftoff plan [--explain]                 steps in order, what each waits on, the accounts each needs
  liftoff next [--json]                    the single most useful thing to do now
  liftoff status [app] [--json]            progress for this app (or all apps with --all)
  liftoff step <id> <todo|running|done|skipped|blocked> [--provider P] [--note N] [--force]
  liftoff verify [--only a,b] [--json]     check readiness items against the real services
  liftoff scan [--json]                    App Store rejection pre-scan of the code
  liftoff pulse [--json]                   live numbers: revenue, sign-ups, conversion, crashes, uptime
  liftoff costs [--json]                   monthly cost of the services this app uses
  liftoff scaffold <money-test|money-test-mobile|uptime> [--force]
  liftoff set <key> <value> | liftoff settings   per-app settings verify and pulse read
  liftoff record <step> --file F | --resource R  log what a step changed
  liftoff undo <step> [--yes]              what undoing a step involves; --yes resets it
  liftoff task add "<title>" [--blocks]    add a task for you (--blocks = blocks release)
  liftoff task done <id> | task undo <id> | task rm <id> | task list
  liftoff check <item-id> [--undo]         tick a readiness checklist item
  liftoff checklist [--json]               show the readiness checklist
  liftoff deploy --target T --platform P [--version V] [--url U] [--status S]
  liftoff accounts                         which accounts are connected
  liftoff accounts connect <id> [--from-env]
  liftoff accounts disconnect <id>
  liftoff accounts migrate                 move keys from credentials.env into the OS keychain
  liftoff exec [--only a,b] -- <command...>  run a command with stored keys (only those accounts' with --only)
  liftoff dashboard [--port 4747]          open Mission Control

Options: --dir <path> picks the app (default: current folder).`;

function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      flags._rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else args.push(a);
  }
  return { args, flags };
}

const out = (s = '') => process.stdout.write(s + '\n');
const icon = { todo: '○', running: '◐', done: '✓', skipped: '–', blocked: '✗' };

function bar(done, total, width = 20) {
  const n = total ? Math.round((done / total) * width) : 0;
  return '█'.repeat(n) + '░'.repeat(width - n);
}

function dirOf(flags) {
  return flags.dir || process.env.LIFTOFF_DIR || process.cwd();
}

function printStatus(s) {
  out(`${s.name}  (${s.framework} · ${s.platforms.join(', ')})`);
  if (s.liveUrl) out(`Live: ${s.liveUrl}`);
  out(`Launch steps ${bar(s.stepsDone, s.stepsTotal)} ${s.stepsDone}/${s.stepsTotal}`);
  for (const st of s.steps) {
    const extra = st.stale ? ' · stale, rerun it' : st.status === 'todo' && st.waitingOn.length ? ` · waits on ${st.waitingOn.join(', ')}` : '';
    out(`  ${icon[st.status] || '?'} ${st.label}${st.provider ? ` (${st.provider})` : ''}${st.note ? ` · ${st.note}` : ''}${extra}`);
  }
  const verified = s.checklist.filter((c) => c.by === 'verified').length;
  const failed = s.checklist.filter((c) => c.verify?.ok === false);
  out(`Readiness    ${bar(s.checksDone, s.checksTotal)} ${s.checksDone}/${s.checksTotal}${verified ? ` (${verified} verified)` : ''}`);
  for (const c of failed) out(`  ✗ ${c.title}: ${c.verify.detail}`);
  const open = s.tasks.filter((t) => !t.done);
  if (open.length) {
    out(`Your tasks (${open.length} open, ${s.blockingTasks} blocking release):`);
    for (const t of open) out(`  ${t.blocksRelease ? '!' : '·'} [${t.id}] ${t.title}${t.leadTime ? ` (takes ${t.leadTime}, start now)` : ''}`);
  }
  if (s.pulse) printPulse(s.pulse, '  ');
  if (s.deploys.length) {
    out('Deploys:');
    for (const d of s.deploys) out(`  ${d.target} (${d.platform}) ${d.version || ''} ${d.status}${d.url ? ` ${d.url}` : ''}`);
  }
  const missing = s.accounts.filter((a) => !a.connected);
  if (missing.length) out(`Accounts still needed: ${missing.map((a) => a.label).join(', ')}`);
  out(s.readyForRelease ? 'Ready for users ✓' : 'Not ready for release yet');
  const a = nextAction(s);
  out(`Next: ${a.title}. ${a.why} ${a.do}`);
}

const money = (n, cur = 'usd') => (n === null || n === undefined ? '–' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(n));

function printPulse(p, pad = '') {
  out(`${pad}Pulse (${p.at.slice(0, 16).replace('T', ' ')} UTC)`);
  const rev = revenueOf(p);
  if (rev !== null) {
    const cur = p.revenuecat?.currency || p.stripe?.currency;
    const ch = p.change?.mrr;
    out(`${pad}  MRR ${money(rev, cur)}${ch !== null && ch !== undefined ? ` (${ch >= 0 ? '+' : ''}${money(ch, cur)} vs last week)` : ''}`);
  }
  if (p.stripe) out(`${pad}  Subscriptions ${p.stripe.activeSubscriptions} active, ${p.stripe.trials} trialing, +${p.stripe.newSubscriptions7d} new, -${p.stripe.cancellations7d} cancelled, ${p.stripe.failedPayments7d} failed payments (7d)`);
  if (p.revenuecat) out(`${pad}  RevenueCat ${p.revenuecat.activeSubscriptions ?? '–'} active, ${p.revenuecat.trials ?? '–'} trials, ${p.revenuecat.newCustomers28d ?? '–'} new customers (28d)`);
  if (p.posthog) {
    const h = p.posthog;
    const conv = h.paywallViews7d ? ` (${Math.round((h.upgrades7d / h.paywallViews7d) * 1000) / 10}% of paywall views)` : '';
    out(`${pad}  Users ${h.activeUsers7d} active, ${h.signups7d} sign-ups (last week ${h.signupsPrev7d}), ${h.upgrades7d} upgrades${conv} (7d)`);
  }
  if (p.sentry) out(`${pad}  Crashes ${p.sentry.crashFreeSessions !== null ? `${Math.round(p.sentry.crashFreeSessions * 1000) / 10}% crash-free, ` : ''}${p.sentry.newIssues7d} new issues (7d)${p.sentry.topIssue ? `, top: ${p.sentry.topIssue.title}` : ''}`);
  if (p.uptime) out(`${pad}  Uptime ${p.uptime.up ? `up, ${p.uptime.ms} ms` : `DOWN (${p.uptime.status || p.uptime.error})`}`);
  for (const [k, v] of Object.entries(p.errors || {})) out(`${pad}  ${k}: couldn't read (${v})`);
}

async function prompt(question, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  if (hidden && process.stdin.isTTY) {
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) rl.output.write(question);
    };
  }
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  if (hidden && process.stdin.isTTY) process.stdout.write('\n');
  return answer.trim();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { args, flags } = parse(rest);

  switch (cmd) {
    case 'init': {
      const s = initProject(args[0] || dirOf(flags));
      if (flags.json) return out(JSON.stringify(summarize(s), null, 2));
      out(`Read ${s.name}: ${s.framework}, ships to ${s.platforms.join(', ')}`);
      const found = Object.entries(s.integrations).filter(([, v]) => v).map(([k]) => k);
      out(`Already set up: ${found.length ? found.join(', ') : 'nothing yet'}`);
      out(`State saved to ${s.root}/.liftoff/state.json`);
      return;
    }
    case 'plan': {
      const s = loadState(dirOf(flags));
      const accounts = listAccounts();
      const plan = stepsFor(s.platforms).map((step) => ({
        id: step.id,
        label: step.label,
        skill: step.skill,
        status: s.steps[step.id]?.status,
        needs: needsFor(step, s.platforms),
        waitingOn: waitingOn(s, step.id),
        does: step.does,
        accounts: accountsForStep(step, s.platforms).map((id) => {
          const a = accounts.find((x) => x.id === id);
          return { id, label: a.label, connected: a.connected };
        }),
      }));
      if (flags.json) return out(JSON.stringify({ app: s.name, platforms: s.platforms, plan, accountsNeeded: accountsFor(s.platforms) }, null, 2));
      out(`Plan for ${s.name} (${s.platforms.join(', ')}):`);
      for (const p of plan) {
        const acc = p.accounts.map((a) => `${a.label} ${a.connected ? '✓' : '✗'}`).join(', ');
        const wait = p.status !== 'done' && p.waitingOn.length ? `  waits on ${p.waitingOn.join(', ')}` : '';
        out(`  ${icon[p.status]} ${p.label.padEnd(20)} skill: ${p.skill.padEnd(18)} ${acc}${wait}`);
        if (flags.explain) out(`      ${p.does}`);
      }
      if (flags.explain) out('\nNothing that spends money, changes DNS, goes live or submits to a store happens without your yes.');
      return;
    }
    case 'status': {
      if (flags.all) {
        const all = listProjects().map((p) => summarize(loadState(p.root)));
        if (flags.json) return out(JSON.stringify(all, null, 2));
        if (!all.length) return out('No apps yet. Run /liftoff:onboard in an app.');
        for (const s of all) out(`${s.name.padEnd(20)} steps ${s.stepsDone}/${s.stepsTotal}  checks ${s.checksDone}/${s.checksTotal}  to do ${s.openTasks}${s.liveUrl ? `  ${s.liveUrl}` : ''}`);
        return;
      }
      const p = args[0] ? findProject(args[0]) : null;
      const s = summarize(loadState(p ? p.root : dirOf(flags)));
      if (flags.json) return out(JSON.stringify(s, null, 2));
      return printStatus(s);
    }
    case 'next': {
      const s = summarize(loadState(dirOf(flags)));
      const a = nextAction(s);
      if (flags.json) return out(JSON.stringify({ ...a, runnableSteps: s.nextSteps }, null, 2));
      out(`${a.title}\n  Why: ${a.why}\n  Do: ${a.do}`);
      if (a.url) out(`  ${a.url}`);
      if (s.nextSteps.length) out(`Steps ready to run: ${s.nextSteps.join(', ')}`);
      return;
    }
    case 'verify': {
      const s = loadState(dirOf(flags));
      const only = typeof flags.only === 'string' ? flags.only.split(',') : null;
      const results = await runVerify(s, { env: credentialEnv(), files: walk(s.root), only });
      applyVerify(s, results);
      saveState(s);
      if (flags.json) return out(JSON.stringify(results, null, 2));
      for (const r of results) out(`  ${r.ok === true ? '✓' : r.ok === false ? '✗' : '–'} ${r.id.padEnd(16)} ${r.detail}`);
      const n = (v) => results.filter((r) => r.ok === v).length;
      out(`${n(true)} verified, ${n(false)} failed, ${n(null)} couldn't check`);
      if (n(false)) process.exitCode = 2;
      return;
    }
    case 'scan': {
      const s = loadState(dirOf(flags));
      const findings = storeScan(s.root, s);
      applyScan(s, findings);
      saveState(s);
      if (flags.json) return out(JSON.stringify(findings, null, 2));
      for (const f of findings) out(`  ${f.ok ? '✓' : '✗'} ${f.id.padEnd(18)} ${f.detail}`);
      if (findings.some((f) => !f.ok)) process.exitCode = 2;
      return;
    }
    case 'pulse': {
      const s = loadState(dirOf(flags));
      const snap = recordPulse(s, await collectPulse(s, { env: credentialEnv() }));
      saveState(s);
      if (flags.json) return out(JSON.stringify(snap, null, 2));
      const sources = ['stripe', 'revenuecat', 'posthog', 'sentry', 'uptime'].filter((k) => snap[k]);
      if (!sources.length) return out('No numbers yet: connect Stripe/RevenueCat, PostHog and Sentry and set their projects (liftoff settings).');
      printPulse(snap);
      const a = nextAction(summarize(s));
      return out(`Next: ${a.title}. ${a.why} ${a.do}`);
    }
    case 'costs': {
      const r = costReport(summarize(loadState(dirOf(flags))));
      if (flags.json) return out(JSON.stringify(r, null, 2));
      out(`Fixed costs about ${money(r.fixedMonthly)} a month:`);
      for (const row of r.rows) out(`  ${row.id.padEnd(16)} ${row.monthly ? money(row.monthly).padStart(8) : '    free'}  ${row.note}`);
      if (r.revenueFeesMonthly !== null) out(`Payment fees about ${money(r.revenueFeesMonthly)} a month on ${money(r.mrr)} MRR`);
      if (r.storeCut) out(r.storeCut);
      for (const w of r.warnings) out(`! ${w}`);
      return out(r.note);
    }
    case 'scaffold': {
      const s = loadState(dirOf(flags));
      for (const file of renderScaffold(args[0], s)) {
        const dest = path.join(s.root, file.path);
        if (fs.existsSync(dest) && !flags.force) {
          out(`  – ${file.path} exists (use --force to replace)`);
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.content);
        out(`  ✓ wrote ${file.path}`);
      }
      return;
    }
    case 'set': {
      const s = loadState(dirOf(flags));
      setConfig(s, args[0], args[1] ?? null);
      saveState(s);
      return out(`${args[0]} = ${args[1] ?? '(cleared)'}`);
    }
    case 'settings': {
      const s = loadState(dirOf(flags));
      for (const [k, d] of Object.entries(CONFIG_KEYS)) out(`  ${k.padEnd(20)} ${(s.config?.[k] || '–').padEnd(24)} ${d}`);
      return;
    }
    case 'record': {
      const s = loadState(dirOf(flags));
      if (flags.file) recordChange(s, args[0], 'file', flags.file);
      if (flags.resource) recordChange(s, args[0], 'resource', flags.resource);
      if (!flags.file && !flags.resource) throw new Error('record needs --file or --resource');
      saveState(s);
      return out(`Recorded for ${args[0]}`);
    }
    case 'undo': {
      const s = loadState(dirOf(flags));
      const plan = undoPlan(s, args[0]);
      if (flags.json && !flags.yes) return out(JSON.stringify(plan, null, 2));
      out(`Undoing ${args[0]}:`);
      out(plan.files.length ? `  Revert files: ${plan.files.join(', ')}` : '  No files recorded.');
      out(plan.resources.length ? `  Delete at the provider (ask first): ${plan.resources.join(', ')}` : '  No provider resources recorded.');
      if (plan.dependents.length) out(`  These steps build on it and may break: ${plan.dependents.join(', ')}`);
      if (!flags.yes) return out('Run again with --yes once the files and resources are reverted, to reset the step.');
      resetStep(s, args[0]);
      saveState(s);
      return out(`○ ${args[0]} reset to todo`);
    }
    case 'step': {
      const [id, status] = args;
      const s = loadState(dirOf(flags));
      setStep(s, id, status, { provider: flags.provider, note: flags.note, force: !!flags.force });
      saveState(s);
      return out(`${icon[status]} ${id} → ${status}`);
    }
    case 'task': {
      const [sub, arg] = args;
      const s = loadState(dirOf(flags));
      if (sub === 'add') {
        const t = addTask(s, arg, { blocksRelease: !!flags.blocks, owner: flags.owner || 'you' });
        saveState(s);
        return out(`Added task ${t.id}: ${t.title}${t.blocksRelease ? ' (blocks release)' : ''}`);
      }
      if (sub === 'done' || sub === 'undo') {
        const t = setTaskDone(s, arg, sub === 'done');
        saveState(s);
        return out(`${t.done ? '✓' : '○'} ${t.title}`);
      }
      if (sub === 'rm') {
        removeTask(s, arg);
        saveState(s);
        return out(`Removed ${arg}`);
      }
      for (const t of s.tasks) out(`${t.done ? '✓' : t.blocksRelease ? '!' : '·'} [${t.id}] ${t.title}`);
      return;
    }
    case 'check': {
      const s = loadState(dirOf(flags));
      setCheck(s, args[0], !flags.undo, flags.by || 'claude');
      saveState(s);
      return out(`${flags.undo ? '○' : '✓'} ${args[0]}`);
    }
    case 'checklist': {
      const s = summarize(loadState(dirOf(flags)));
      if (flags.json) return out(JSON.stringify(s.checklist, null, 2));
      let cat = null;
      for (const c of s.checklist) {
        if (c.category !== cat) out(`\n${(cat = c.category)}`);
        out(`  ${c.done ? '✓' : '○'} ${c.id.padEnd(22)} ${c.title}`);
      }
      return;
    }
    case 'deploy': {
      const s = loadState(dirOf(flags));
      if (!flags.target || !flags.platform) throw new Error('deploy needs --target and --platform');
      const d = addDeploy(s, { target: flags.target, platform: flags.platform, version: flags.version, url: flags.url, status: flags.status });
      saveState(s);
      return out(`Recorded ${d.target} ${d.version || ''} (${d.status})`);
    }
    case 'accounts': {
      const [sub, id] = args;
      if (sub === 'connect') {
        const def = ACCOUNTS[id];
        if (!def) throw new Error(`Unknown account "${id}". Known: ${Object.keys(ACCOUNTS).join(', ')}`);
        const values = {};
        for (const key of def.env) {
          values[key] = flags['from-env'] ? process.env[key] : await prompt(`${def.label} ${key}: `, true);
        }
        const a = connectAccount(id, values);
        return out(`✓ ${a.label} connected. Every app on this machine will reuse it.`);
      }
      if (sub === 'migrate') {
        const moved = migrateToKeychain();
        return out(moved.length ? `Moved ${moved.join(', ')} into the keychain.` : 'Nothing to move.');
      }
      if (sub === 'disconnect') {
        disconnectAccount(id);
        return out(`Disconnected ${id}`);
      }
      const list = listAccounts();
      if (flags.json) return out(JSON.stringify(list.map(({ env, ...a }) => a), null, 2));
      for (const a of list) out(`${a.connected ? '✓' : '○'} ${a.id.padEnd(16)} ${a.label}${a.connected ? `  (${a.store})` : `  (${a.note}) ${a.url}`}`);
      out(`New keys go to: ${secretStore() === 'keychain' ? 'the OS keychain' : '~/.liftoff/credentials.env (mode 600)'}`);
      return;
    }
    case 'exec': {
      const cmdline = flags._rest || [];
      if (!cmdline.length) throw new Error('Usage: liftoff exec [--only a,b] -- <command...>');
      const only = typeof flags.only === 'string' ? flags.only.split(',') : null;
      const child = spawn(cmdline[0], cmdline.slice(1), { stdio: 'inherit', env: credentialEnv(only) });
      child.on('exit', (code) => process.exit(code ?? 1));
      return;
    }
    case 'dashboard': {
      const port = Number(flags.port || process.env.LIFTOFF_PORT || 4747);
      const { url } = await startServer({ port });
      out(`Mission Control running at ${url}`);
      return;
    }
    case 'steps':
      for (const s of STEPS) out(`${s.id.padEnd(14)} ${s.label}`);
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return out(HELP);
    default:
      throw new Error(`Unknown command "${cmd}". Run \`liftoff help\`.`);
  }
}

main().catch((err) => {
  process.stderr.write(`liftoff: ${err.message}\n`);
  process.exit(1);
});
