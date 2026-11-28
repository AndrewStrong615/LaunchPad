// Run records: one per cloud run, about the launch and not the person, and
// the numbers the admin page shows from them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { zipDirectory } from '../lib/archive.mjs';
import { scrub, summarize } from '../lib/records.mjs';
import { fakeAnthropic } from './fake-anthropic.mjs';
import { FIXTURES, signIn, startTest, until } from './helpers.mjs';

const ADMIN = { LIFTOFF_ADMIN_LOGINS: 'someone-else, YOU' };

async function setup({ anthropic, env = {} }) {
  const t = await startTest({ anthropic, env });
  const me = await signIn(t.base);
  const r = await me.call('POST', '/api/import/zip?name=invoicely.zip', zipDirectory(path.join(FIXTURES, 'next-saas')), { 'content-type': 'application/zip' });
  assert.equal(r.status, 200, r.text);
  const slug = r.body.slug;
  const uid = fs.readdirSync(path.join(t.dataDir, 'users'))[0];
  const record = (id) => JSON.parse(fs.readFileSync(path.join(t.dataDir, 'records', 'runs', `${id}.json`), 'utf8'));
  const run = async (body, until_ = (s) => s === 'finished') => {
    const res = await me.post(`/api/apps/${slug}/runs`, body);
    assert.equal(res.status, 200, res.text);
    await until(async () => until_((await me.get(`/api/apps/${slug}/runs/${res.body.id}`)).body.status));
    return res.body.id;
  };
  return { t, me, slug, uid, record, run };
}

test('scrubbing takes out links, hosts, addresses, emails, keys and the app’s own names', () => {
  const s = scrub(
    'invoicely: POST https://invoicely.vercel.app/api/stripe?x=1 failed for me@acme.dev from 10.0.0.12 with sk_test_51Habc123 and whsec_abcdef123456, ' +
      'token ghp_ABCdef1234567890, jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig, blob a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8, host shop.example.com. ' +
      'Kept: src/app/api/stripe/webhook/route.ts, next.config.js, STRIPE_WEBHOOK_SECRET.',
    ['Invoicely', 'acme', 'ab'],
  );
  for (const gone of ['invoicely', 'vercel.app', 'me@', '10.0.0.12', 'sk_test', 'whsec_', 'ghp_', 'eyJ', 'a1b2c3', 'example.com', 'acme']) assert.ok(!s.toLowerCase().includes(gone.toLowerCase()), `${gone} is gone: ${s}`);
  assert.match(s, /^<app>: POST <link> failed for <email> from <ip> with <key> and <key>/);
  assert.match(s, /<host>\./);
  assert.match(s, /Kept: src\/app\/api\/stripe\/webhook\/route\.ts, next\.config\.js, STRIPE_WEBHOOK_SECRET\./, 'file names and setting names stay');
  assert.ok(!scrub('ab cd').includes('<app>'), 'short words are not names');
  assert.equal(scrub('x'.repeat(500)).length, 241, 'clipped');
});

test('a run leaves a record of the stack, the steps, the checklist, the cost and the errors, with nothing personal', async (t) => {
  const client = fakeAnthropic(async (s, tools) => {
    await tools.custom('liftoff_step', { step: 'hosting', status: 'running' });
    await tools.custom('liftoff_step', { step: 'hosting', status: 'done', provider: 'vercel', note: 'Deployed invoicely' });
    await tools.custom('liftoff_step', { step: 'payments', status: 'blocked', note: 'The invoicely webhook at https://invoicely.vercel.app/api/stripe answered 500; ask me@acme.dev' });
    await tools.custom('liftoff_check', { item: 'pay-e2e' });
    tools.emit({ type: 'agent.message', content: [{ type: 'text', text: 'Hosting is done for invoicely. Payments is blocked.' }] });
    tools.end('250');
  });
  const { t: srv, me, slug, uid, record, run } = await setup({ anthropic: client });
  t.after(() => srv.stop());
  await me.post('/api/accounts/stripe', { values: { STRIPE_SECRET_KEY: 'sk_test_supersecret' } });
  await me.post(`/api/apps/${slug}/checklist/land-legal`, { done: true });

  const id = await run({ steps: ['hosting'], note: 'Use Vercel for invoicely' });
  const rec = record(id);
  assert.equal(rec.v, 1);
  assert.equal(rec.id, id);
  assert.match(rec.app, /^a_[0-9a-f]{16}$/);
  assert.equal(rec.outcome, 'finished');
  assert.equal(rec.cost, 2.5);
  assert.equal(rec.budgetUsd, 15);
  assert.equal(rec.model, 'claude-sonnet-5-5');
  assert.equal(rec.mode, 'upload');
  assert.deepEqual(rec.asked, ['hosting']);
  assert.deepEqual(rec.accounts, ['stripe']);
  assert.equal(rec.stack.framework, 'Next.js');
  assert.deepEqual(rec.stack.platforms, ['web']);
  assert.equal(rec.stack.source, 'upload');
  assert.equal(rec.before.steps.hosting, 'todo');
  assert.equal(rec.before.checks['land-legal'], 'ticked');
  assert.equal(rec.after.steps.hosting, 'done');
  assert.deepEqual(rec.steps.find((s) => s.id === 'hosting'), { id: 'hosting', from: 'todo', to: 'done', provider: 'vercel' });
  const blocked = rec.steps.find((s) => s.id === 'payments');
  assert.equal(blocked.to, 'blocked');
  assert.equal(blocked.why, 'The <app> webhook at <link> answered 500; ask <email>');
  assert.equal(rec.stepsDone, 1);
  assert.ok(rec.errors.some((e) => e.where === 'liftoff_check' && /proven from Stripe/.test(e.text)), JSON.stringify(rec.errors));
  assert.equal(rec.counts.liftoffTools, 4);
  assert.equal(rec.counts.messages, 1);
  assert.equal(rec.settled, 1);
  assert.ok(rec.minutes >= 0);

  // Nothing in it names the person, the app, its code or its keys.
  const raw = JSON.stringify(rec).toLowerCase();
  for (const word of ['invoicely', uid, slug, 'you', 'sk_test_supersecret', 'use vercel', 'payments is blocked']) assert.ok(!raw.includes(word.toLowerCase()), `the record leaves out "${word}"`);

  // Not on the person's own run list, and no route reads it without admin rights.
  let r = await me.get('/api/me');
  assert.equal(r.body.admin, false);
  r = await me.get('/api/records');
  assert.equal(r.status, 404);
  r = await me.get('/api/records/export');
  assert.equal(r.status, 404);

  // Deleting the app, then the account, leaves the record.
  r = await me.del(`/api/apps/${slug}`);
  assert.equal(r.status, 200);
  assert.equal(record(id).outcome, 'finished');
  r = await me.call('DELETE', '/api/me', { confirm: 'you' });
  assert.equal(r.status, 200, r.text);
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'users', uid)));
  assert.equal(record(id).stepsDone, 1, 'the record outlives the account');
});

test('a run paused at its budget is recorded, and brought up to date when it finishes', async (t) => {
  const client = fakeAnthropic(async (s, tools) => {
    await tools.custom('liftoff_step', { step: 'hosting', status: 'running' });
    await tools.budget('1500');
    await tools.custom('liftoff_step', { step: 'hosting', status: 'done', provider: 'vercel' });
    tools.end('1800');
  });
  const { t: srv, me, slug, record, run } = await setup({ anthropic: client });
  t.after(() => srv.stop());
  const id = await run({ steps: ['hosting'], tier: 'boost' }, (s) => s === 'budget');
  let rec = record(id);
  assert.equal(rec.outcome, 'budget');
  assert.equal(rec.cost, 15);
  assert.equal(rec.after.steps.hosting, 'running');
  assert.equal(rec.stepsDone, 0);
  assert.equal(rec.model, 'claude-opus-5-5');

  const r = await me.post(`/api/apps/${slug}/runs/${id}/budget`, { addTokens: 500 });
  assert.equal(r.status, 200, r.text);
  await until(async () => (await me.get(`/api/apps/${slug}/runs/${id}`)).body.status === 'finished' && record(id).cost === 18);
  rec = record(id);
  assert.equal(rec.outcome, 'finished');
  assert.equal(rec.budgetUsd, 20);
  assert.equal(rec.stepsDone, 1);
  assert.ok(rec.settled >= 2);
});

test('a run that fails to start is recorded with its error, scrubbed', async (t) => {
  const client = fakeAnthropic();
  client.beta.sessions.create = async () => {
    throw new Error('Overloaded at https://api.anthropic.com/v1/sessions for key sk-ant-api03-abcdef123456');
  };
  const { t: srv, me, slug, record } = await setup({ anthropic: client });
  t.after(() => srv.stop());
  const res = await me.post(`/api/apps/${slug}/runs`, { steps: ['hosting'] });
  await until(async () => (await me.get(`/api/apps/${slug}/runs/${res.body.id}`)).body.status === 'failed');
  await until(() => record(res.body.id).outcome === 'failed');
  const rec = record(res.body.id);
  assert.deepEqual(rec.errors, [{ where: 'run', text: 'Overloaded at <link> for key <key>' }]);
  assert.equal(rec.cost, null);
});

test('admins get the numbers by stack, step and model, and every record as JSON lines', async (t) => {
  let n = 0;
  const client = fakeAnthropic(async (s, tools) => {
    n++;
    if (n === 1) {
      await tools.custom('liftoff_step', { step: 'hosting', status: 'done', provider: 'vercel' });
      await tools.custom('liftoff_step', { step: 'database', status: 'done', provider: 'supabase' });
      return tools.end('400');
    }
    await tools.custom('liftoff_step', { step: 'payments', status: 'blocked', note: 'Stripe key is missing' });
    tools.end('100');
  });
  const { t: srv, me, run } = await setup({ anthropic: client, env: ADMIN });
  t.after(() => srv.stop());
  let r = await me.get('/api/me');
  assert.equal(r.body.admin, true);
  r = await me.get('/api/records');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 0);
  assert.equal(r.body.avgCost, null);

  await run({ steps: ['hosting', 'database'] });
  await run({ steps: ['payments'] });
  r = await me.get('/api/records');
  const s = r.body;
  assert.equal(s.total, 2);
  assert.equal(s.apps, 1);
  assert.equal(s.finished, 2);
  assert.equal(s.cost, 5);
  assert.equal(s.avgCost, 2.5);
  assert.equal(s.stepsDone, 2);
  assert.equal(s.costPerStep, 2.5);
  assert.equal(s.byStack.length, 1);
  assert.equal(s.byStack[0].label, 'Next.js · web');
  assert.equal(s.byStack[0].runs, 2);
  assert.deepEqual(s.byModel.map((m) => [m.label, m.runs]), [['Cruise · Claude Sonnet 5.5', 2]], 'admins see the mode and the real model');
  const step = (id) => s.bySteps.find((x) => x.id === id);
  assert.deepEqual([step('database').label, step('database').tried, step('database').done, step('database').rate], ['Database', 1, 1, 100]);
  assert.deepEqual([step('payments').tried, step('payments').blocked, step('payments').rate], [1, 1, 0]);
  assert.deepEqual(step('payments').why, [{ text: 'Stripe key is missing', n: 1 }]);
  assert.deepEqual(step('hosting').providers, [{ provider: 'vercel', n: 1 }]);
  assert.deepEqual(s.bySteps.map((x) => x.id), ['database', 'hosting', 'payments'], 'in launch order');
  assert.equal(s.recent.length, 2);
  assert.equal(s.recent[0].steps[0].label, 'Payments');

  r = await me.get('/api/records/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/x-ndjson/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="liftoff-run-records-\d{4}-\d{2}-\d{2}\.jsonl"/);
  const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.v === 1 && l.outcome === 'finished'));
});

test('the numbers: failing checks and errors are counted, open runs left out of the cost', () => {
  const rec = (o) => ({ v: 1, app: 'a_1', stack: { framework: 'Expo', platforms: ['android', 'ios'] }, model: 'claude-opus-5-5', steps: [], errors: [], failing: [], ...o });
  const s = summarize([
    rec({ startedAt: '2026-11-01', outcome: 'failed', cost: 3, failing: [{ id: 'pay-restore', detail: 'Restore did nothing' }], errors: [{ where: 'run', text: 'Claude kept hitting errors and stopped.' }] }),
    rec({ startedAt: '2026-11-02', outcome: 'finished', cost: 6, stepsDone: 3, failing: [{ id: 'pay-restore', detail: 'Restore timed out' }] }),
    rec({ startedAt: '2026-11-03', outcome: 'running', app: 'a_2', cost: 50 }),
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.apps, 2);
  assert.equal(s.ended, 2);
  assert.equal(s.cost, 9, 'the open run is not counted yet');
  assert.equal(s.avgCost, 4.5);
  assert.equal(s.costPerStep, 3);
  assert.equal(s.since, '2026-11-01');
  assert.deepEqual(s.failures, [{ id: 'pay-restore', title: 'Restore purchases works', n: 2, example: 'Restore timed out' }]);
  assert.deepEqual(s.errors, [{ text: 'Claude kept hitting errors and stopped.', n: 1 }]);
  assert.equal(s.byStack[0].label, 'Expo · android + ios');
  assert.deepEqual(s.byStack[0].topFailure, { id: 'pay-restore', title: 'Restore purchases works', n: 2 });
  assert.equal(s.byModel[0].label, 'Boost · Claude Opus 5.5');
  assert.equal(s.recent[0].outcome, 'running');
});
