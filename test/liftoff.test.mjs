import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-'));
process.env.LIFTOFF_HOME = path.join(tmp, 'home');
process.env.LIFTOFF_SECRET_STORE = 'file';
for (const k of ['STRIPE_SECRET_KEY', 'VERCEL_TOKEN']) delete process.env[k];

const { detectProject } = await import('../lib/detect.mjs');
const state = await import('../lib/state.mjs');
const { startServer } = await import('../lib/server.mjs');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'liftoff.mjs');

function makeApp(name, files) {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

let web, expo;
before(() => {
  web = makeApp('ledger', {
    'package.json': { name: 'ledger', dependencies: { next: '15', react: '19', stripe: '17' } },
    'app/privacy/page.tsx': '',
    'app/terms/page.tsx': '',
    '.github/workflows/ci.yml': 'on: push',
  });
  expo = makeApp('fernweh', {
    'package.json': { name: 'fernweh', dependencies: { expo: '52', 'react-native': '0.76', '@sentry/react-native': '6' } },
    'app.json': { expo: { name: 'Fernweh' } },
  });
});

test('detects a Next.js web app and its integrations', () => {
  const d = detectProject(web);
  assert.equal(d.framework, 'Next.js');
  assert.deepEqual(d.platforms, ['web']);
  assert.equal(d.integrations.stripe, true);
  assert.equal(d.integrations.githubActions, true);
  assert.equal(d.integrations.posthog, false);
});

test('detects an Expo app as iOS + Android with its display name', () => {
  const d = detectProject(expo);
  assert.equal(d.framework, 'Expo');
  assert.deepEqual(d.platforms, ['android', 'ios']);
  assert.equal(d.name, 'Fernweh');
  assert.equal(d.integrations.sentry, true);
});

test('init picks steps for the platforms and auto-ticks what exists', () => {
  const s = state.initProject(web);
  assert.ok(s.steps.hosting);
  assert.ok(!s.steps.testflight, 'web app has no TestFlight step');
  assert.equal(s.checklist['pay-sdk'].done, true);
  assert.equal(s.checklist['ci-workflow'].done, true);
  assert.equal(s.checklist['land-legal'].done, true);
  assert.equal(s.checklist['ana-sdk'].done, false);

  const m = state.initProject(expo);
  assert.ok(m.steps.testflight && m.steps['play-testing'] && m.steps['store-checks']);
  assert.ok(!m.steps.hosting, 'mobile-only app has no web hosting step');
  assert.ok(m.checklist['ios-delete']);
});

test('re-running init keeps progress', () => {
  const s = state.loadState(web);
  const paperwork = s.tasks.length;
  state.setStep(s, 'payments', 'done', { provider: 'stripe', force: true });
  state.addTask(s, 'Add DNS records', { blocksRelease: true });
  state.saveState(s);
  const again = state.initProject(web);
  assert.equal(again.steps.payments.status, 'done');
  assert.equal(again.tasks.length, paperwork + 1, 'paperwork tasks are not added twice');
});

test('summary counts blockers and readiness', () => {
  const s = state.loadState(web);
  const sum = state.summarize(s);
  const paperworkBlocking = s.tasks.filter((t) => t.key && t.blocksRelease).length;
  assert.equal(sum.blockingTasks, 1 + paperworkBlocking);
  assert.equal(sum.readyForRelease, false);
  assert.equal(sum.stepsDone, 1);
  for (const step of sum.steps) state.setStep(s, step.id, 'done');
  for (const t of s.tasks) state.setTaskDone(s, t.id);
  assert.equal(state.summarize(s).readyForRelease, true);
});

test('rejects unknown steps and statuses', () => {
  const s = state.loadState(web);
  assert.throws(() => state.setStep(s, 'testflight', 'done'), /doesn't apply/);
  assert.throws(() => state.setStep(s, 'payments', 'finished'), /Status must be/);
});

test('accounts are stored once with private permissions and reused', () => {
  state.connectAccount('stripe', { STRIPE_SECRET_KEY: 'sk_test_123' });
  const file = path.join(process.env.LIFTOFF_HOME, 'credentials.env');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(state.listAccounts().find((a) => a.id === 'stripe').connected, true);
  // Both apps see the same connected account.
  for (const dir of [web, expo]) {
    const accts = state.summarize(state.loadState(dir)).accounts;
    const stripe = accts.find((a) => a.id === 'stripe');
    if (stripe) assert.equal(stripe.connected, true);
  }
  assert.throws(() => state.connectAccount('vercel', {}), /Missing VERCEL_TOKEN/);
});

test('CLI: exec injects stored keys without printing them elsewhere', () => {
  const out = execFileSync('node', [CLI, 'exec', '--', 'node', '-e', 'process.stdout.write(process.env.STRIPE_SECRET_KEY)'], { env: process.env });
  assert.equal(out.toString(), 'sk_test_123');
  const list = execFileSync('node', [CLI, 'accounts', '--json'], { env: process.env }).toString();
  assert.ok(!list.includes('sk_test_123'));
});

test('CLI: step, task, check, deploy and status', () => {
  const run = (...a) => execFileSync('node', [CLI, ...a, '--dir', expo], { env: process.env }).toString();
  run('step', 'testflight', 'done', '--provider', 'eas', '--force');
  run('task', 'add', 'Create app in App Store Connect', '--blocks');
  run('check', 'ios-delete');
  run('deploy', '--target', 'testflight', '--platform', 'ios', '--version', '1.4 (12)');
  const s = JSON.parse(run('status', '--json'));
  assert.equal(s.steps.find((x) => x.id === 'testflight').status, 'done');
  assert.equal(s.tasks.filter((t) => !t.key && t.blocksRelease).length, 1);
  assert.equal(s.checklist.find((c) => c.id === 'ios-delete').done, true);
  assert.equal(s.deploys[0].version, '1.4 (12)');
  assert.match(run('status'), /Fernweh/);
});

test('Mission Control API lists apps and edits tasks and checks', async () => {
  const { server, url } = await startServer({ port: 0 });
  try {
    const apps = await (await fetch(`${url}/api/apps`)).json();
    assert.deepEqual(apps.map((a) => a.slug).sort(), ['fernweh', 'ledger']);

    const html = await (await fetch(url)).text();
    assert.match(html, /Mission Control/);

    const post = (p, body) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let res = await post('/api/apps/ledger/tasks', { title: 'Pick a domain', blocksRelease: true });
    let app = await res.json();
    const task = app.tasks.find((t) => t.title === 'Pick a domain');
    assert.ok(task.blocksRelease);

    app = await (await post(`/api/apps/ledger/tasks/${task.id}`, { done: true })).json();
    assert.equal(app.tasks.find((t) => t.id === task.id).done, true);

    app = await (await post('/api/apps/ledger/checklist/sec-rls', { done: true })).json();
    assert.equal(app.checklist.find((c) => c.id === 'sec-rls').by, 'you');

    // Cross-site and non-JSON writes are refused.
    res = await fetch(`${url}/api/apps/ledger/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"title":"x"}' });
    assert.equal(res.status, 403);
    res = await fetch(`${url}/api/apps/ledger/tasks`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"title":"x"}' });
    assert.equal(res.status, 415);

    const accounts = await (await fetch(`${url}/api/accounts`)).json();
    assert.ok(accounts.every((a) => !('env' in a)));
  } finally {
    server.close();
  }
});
