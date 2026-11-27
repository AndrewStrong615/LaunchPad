#!/usr/bin/env node
// Liftoff command line. The plugin's slash commands call this to read and
// record launch progress; you can run it yourself too.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { ACCOUNTS, STEPS, accountsFor, accountsForStep, stepsFor } from '../lib/catalog.mjs';
import {
  addDeploy, addTask, connectAccount, credentialEnv, disconnectAccount, findProject, initProject,
  listAccounts, listProjects, loadState, removeTask, saveState, setCheck, setStep, setTaskDone, summarize,
} from '../lib/state.mjs';
import { startServer } from '../lib/server.mjs';

const HELP = `liftoff: launch your app and track it in Mission Control

  liftoff init [dir]                       read the app, create .liftoff/state.json, register it
  liftoff plan                             steps for this app and the accounts each one needs
  liftoff status [app] [--json]            progress for this app (or all apps with --all)
  liftoff step <id> <todo|running|done|skipped|blocked> [--provider P] [--note N]
  liftoff task add "<title>" [--blocks]    add a task for you (--blocks = blocks release)
  liftoff task done <id> | task undo <id> | task rm <id> | task list
  liftoff check <item-id> [--undo]         tick a readiness checklist item
  liftoff checklist [--json]               show the readiness checklist
  liftoff deploy --target T --platform P [--version V] [--url U] [--status S]
  liftoff accounts                         which accounts are connected
  liftoff accounts connect <id> [--from-env]
  liftoff accounts disconnect <id>
  liftoff exec -- <command...>             run a command with your stored keys in its environment
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
  for (const st of s.steps) out(`  ${icon[st.status] || '?'} ${st.label}${st.provider ? ` (${st.provider})` : ''}${st.note ? ` · ${st.note}` : ''}`);
  out(`Readiness    ${bar(s.checksDone, s.checksTotal)} ${s.checksDone}/${s.checksTotal}`);
  const open = s.tasks.filter((t) => !t.done);
  if (open.length) {
    out(`Your tasks (${open.length} open, ${s.blockingTasks} blocking release):`);
    for (const t of open) out(`  ${t.blocksRelease ? '!' : '·'} [${t.id}] ${t.title}`);
  }
  if (s.deploys.length) {
    out('Deploys:');
    for (const d of s.deploys) out(`  ${d.target} (${d.platform}) ${d.version || ''} ${d.status}${d.url ? ` ${d.url}` : ''}`);
  }
  const missing = s.accounts.filter((a) => !a.connected);
  if (missing.length) out(`Accounts still needed: ${missing.map((a) => a.label).join(', ')}`);
  out(s.readyForRelease ? 'Ready for users ✓' : 'Not ready for release yet');
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
        accounts: accountsForStep(step, s.platforms).map((id) => {
          const a = accounts.find((x) => x.id === id);
          return { id, label: a.label, connected: a.connected };
        }),
      }));
      if (flags.json) return out(JSON.stringify({ app: s.name, platforms: s.platforms, plan, accountsNeeded: accountsFor(s.platforms) }, null, 2));
      out(`Plan for ${s.name} (${s.platforms.join(', ')}):`);
      for (const p of plan) {
        const acc = p.accounts.map((a) => `${a.label} ${a.connected ? '✓' : '✗'}`).join(', ');
        out(`  ${icon[p.status]} ${p.label.padEnd(18)} skill: ${p.skill.padEnd(16)} ${acc}`);
      }
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
    case 'step': {
      const [id, status] = args;
      const s = loadState(dirOf(flags));
      setStep(s, id, status, { provider: flags.provider, note: flags.note });
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
      if (sub === 'disconnect') {
        disconnectAccount(id);
        return out(`Disconnected ${id}`);
      }
      const list = listAccounts();
      if (flags.json) return out(JSON.stringify(list.map(({ env, ...a }) => a), null, 2));
      for (const a of list) out(`${a.connected ? '✓' : '○'} ${a.id.padEnd(16)} ${a.label}${a.connected ? '' : `  (${a.note}) ${a.url}`}`);
      return;
    }
    case 'exec': {
      const cmdline = flags._rest || [];
      if (!cmdline.length) throw new Error('Usage: liftoff exec -- <command...>');
      const child = spawn(cmdline[0], cmdline.slice(1), { stdio: 'inherit', env: credentialEnv() });
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
