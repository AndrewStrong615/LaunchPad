// What people see of the AI behind Liftoff Cloud: the assistant's Liftoff
// name, run modes instead of models, and tokens instead of dollars.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assistantName, fromTokens, toTokens, tokenWord, tokensPerUsd } from '../lib/brand.mjs';
import { agentDefinition, modelFor, MODELS, systemPrompt, TIERS, tierOf } from '../lib/agent.mjs';
import { renderReport } from '../lib/report.mjs';
import { zipDirectory } from '../lib/archive.mjs';
import { fakeAnthropic } from './fake-anthropic.mjs';
import { FIXTURES, signIn, startTest, until } from './helpers.mjs';

test('the name, the token rate and the modes', () => {
  assert.equal(assistantName(undefined), 'Pilot');
  assert.equal(assistantName('  Houston  '), 'Houston');
  assert.equal(assistantName('<b>Ace</b>`'), 'bAceb', 'only letters, digits, spaces and a little punctuation');
  assert.equal(assistantName('!!!'), 'Pilot');
  assert.equal(assistantName('A very long name for an assistant'), 'A very long name for an');
  assert.equal(tokensPerUsd(undefined), 100);
  assert.equal(tokensPerUsd('-5'), 100);
  assert.equal(tokensPerUsd('10'), 10);
  assert.equal(toTokens(2.5, 100), 250);
  assert.equal(toTokens(0.004, 100), 0);
  assert.equal(toTokens(null, 100), null);
  assert.equal(fromTokens(1000, 100), 10);
  assert.equal(tokenWord(5000), '5,000 tokens');
  assert.equal(tokenWord(1), '1 token');

  // The web app gets modes, never model ids.
  assert.deepEqual(TIERS.map((t) => Object.keys(t).sort()), [['hint', 'id', 'label'], ['hint', 'id', 'label']]);
  assert.doesNotMatch(JSON.stringify(TIERS), /claude|sonnet|opus/i);
  assert.equal(modelFor('cruise'), 'claude-sonnet-5-5');
  assert.equal(modelFor('boost'), 'claude-opus-5-5');
  assert.equal(modelFor('claude-opus-5-5'), 'claude-opus-5-5', 'LIFTOFF_RUN_MODEL can still name a model');
  assert.equal(modelFor('warp'), null);
  assert.equal(tierOf('claude-sonnet-5-5'), 'cruise');
  assert.equal(MODELS.length, TIERS.length);
});

test('the assistant introduces itself by its name and says plainly what it runs on', () => {
  assert.match(systemPrompt(), /^You are Pilot, Liftoff's launch assistant/);
  assert.match(systemPrompt('Houston'), /^You are Houston,/);
  assert.match(systemPrompt('Houston'), /The user knows you as Houston\. You run on Claude, an AI model made by Anthropic: if the user asks which AI or model you are, say so plainly\./);
  assert.equal(agentDefinition({ assistant: 'Houston' }).system, systemPrompt('Houston'));
});

test('a public report names the assistant for what it ticked by hand', () => {
  const html = renderReport({
    id: 'rp_AAAAAAAAAAAAAAAAAAAA', createdAt: new Date().toISOString(), app: { name: 'Greenrow', framework: 'nextjs', platforms: ['web'] },
    certified: false, score: 40, counts: { proven: 0, total: 1 }, missing: ['x'],
    checks: [{ id: 'sec-confirm', title: 'Liftoff asks before money, DNS or store actions', status: 'reported', by: 'claude', at: new Date().toISOString() }], open: [],
  }, { assistant: 'Houston' });
  assert.match(html, /marked done by Houston/);
  assert.match(html, /Done according to the team or Houston\./);
  assert.doesNotMatch(html, /Claude/);
});

test('another name and token rate from the environment show everywhere a person looks', async (t) => {
  const client = fakeAnthropic(async (s, tools) => {
    await tools.custom('liftoff_step', { step: 'hosting', status: 'running' });
    tools.end('375');
  });
  const srv = await startTest({ anthropic: client, env: { LIFTOFF_ASSISTANT_NAME: 'Houston', LIFTOFF_TOKENS_PER_USD: '10', LIFTOFF_RUN_MODEL: 'boost' } });
  t.after(() => srv.stop());

  const opts = await (await fetch(`${srv.base}/login/options`)).json();
  assert.equal(opts.assistant, 'Houston');
  const me = await signIn(srv.base);
  let r = await me.get('/api/me');
  assert.equal(r.body.assistant.name, 'Houston');
  assert.equal(r.body.tiers.server, 'boost', 'LIFTOFF_RUN_MODEL takes a mode');
  assert.equal(r.body.limits.runBudgetTokens, 150, '$15 at 10 tokens to the dollar');
  assert.equal(r.body.limits.topUpTokens, 100);

  const zip = zipDirectory(path.join(FIXTURES, 'next-saas'));
  await me.call('POST', '/api/import/zip?name=a.zip', zip, { 'content-type': 'application/zip' });
  r = await me.post('/api/apps/invoicely/runs', { steps: ['hosting'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.tier, 'boost');
  const url = `/api/apps/invoicely/runs/${r.body.id}`;
  const run = await until(async () => { const x = (await me.get(url)).body; return x.status === 'finished' && x.tokens !== null && x; });
  assert.equal(run.tokens, 38, '$3.75 at 10 tokens to the dollar, rounded');
  assert.ok(run.events.some((e) => e.text === 'Houston got the launch brief'));
  assert.ok(run.events.some((e) => e.text === 'Houston finished. Send a message to keep going.'));
  assert.equal(client.calls.find((c) => c[0] === 'sessions.create')[1].agent.model.id, 'claude-opus-5-5');
});
