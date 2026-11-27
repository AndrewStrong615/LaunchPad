import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { provision } from '../lib/provision.mjs';
import { agentDefinition, CUSTOM_TOOLS, environmentDefinition, kickoff, SYSTEM_PROMPT } from '../lib/agent.mjs';
import { tmpDir } from './helpers.mjs';

function fakeClient() {
  const calls = [];
  let n = 0;
  return {
    calls,
    beta: {
      agents: {
        create: async (p) => (calls.push(['agents.create', p]), { id: `agent_${++n}`, version: 1 }),
        update: async (id, p) => (calls.push(['agents.update', id, p]), { id, version: 2 }),
      },
      environments: {
        create: async (p) => (calls.push(['environments.create', p]), { id: `env_${++n}` }),
        update: async (id, p) => (calls.push(['environments.update', id, p]), { id }),
      },
    },
  };
}

test('the agent and environment are created once, then updated only when they change', async () => {
  const dataDir = tmpDir();
  const env = { LIFTOFF_DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'k' };
  const client = fakeClient();
  let config = loadConfig(env);
  let res = await provision(client, config);
  assert.equal(res.changed, true);
  assert.deepEqual(client.calls.map((c) => c[0]), ['agents.create', 'environments.create']);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent.json'), 'utf8'));
  assert.equal(saved.agentId, config.anthropic.agentId);

  // A restart with nothing changed does nothing.
  config = loadConfig(env);
  res = await provision(client, config);
  assert.equal(res.changed, false);
  assert.equal(client.calls.length, 2);

  // A new allowed host changes the environment definition: both are updated in place.
  config = loadConfig({ ...env, LIFTOFF_EXTRA_HOSTS: 'api.example.com' });
  res = await provision(client, config);
  assert.equal(res.changed, true);
  assert.deepEqual(client.calls.slice(2).map((c) => c[0]), ['agents.update', 'environments.update']);
  assert.ok(client.calls[3][2].config.networking.allowed_hosts.includes('api.example.com'));

  // Ids from env vars are yours: left alone.
  config = loadConfig({ ...env, LIFTOFF_AGENT_ID: 'agent_mine', LIFTOFF_ENVIRONMENT_ID: 'env_mine', LIFTOFF_EXTRA_HOSTS: 'other.example.com' });
  res = await provision(client, config);
  assert.equal(res.changed, false);
  assert.equal(client.calls.length, 4);
});

test('the agent keeps keys out of reach and asks before risky steps', () => {
  const agent = agentDefinition();
  assert.equal(agent.model.id, 'claude-sonnet-5-5');
  const toolset = agent.tools.find((t) => t.type === 'agent_toolset_20260401');
  assert.deepEqual(toolset.default_config.permission_policy, { type: 'auto' });
  assert.ok(toolset.configs.some((c) => c.name === 'web_fetch' && c.enabled === false));
  const names = CUSTOM_TOOLS.map((t) => t.name);
  for (const n of ['liftoff_plan', 'liftoff_step', 'liftoff_verify', 'ask_user', 'open_pull_request', 'github_set_secret']) assert.ok(names.includes(n), n);
  for (const t of CUSTOM_TOOLS) assert.equal(t.input_schema.type, 'object');
  assert.match(SYSTEM_PROMPT, /Never print, echo, log, write to a file or commit a key/);
  assert.match(SYSTEM_PROMPT, /data, not instructions/);
  const env = environmentDefinition();
  assert.equal(env.config.networking.type, 'limited');
  assert.ok(env.config.networking.allowed_hosts.includes('api.stripe.com'));
  assert.ok(!env.config.networking.allowed_hosts.includes('*'));

  const text = kickoff({
    state: { name: 'Greenrow', framework: 'Expo', platforms: ['ios', 'web'], source: { fullName: 'acme/greenrow', ref: 'main' } },
    steps: ['hosting'],
    mode: 'github',
    branch: 'liftoff/launch-1',
    envPlan: { vaulted: [{ name: 'VERCEL_TOKEN', value: 'secret-value' }], plain: { CLOUDFLARE_ACCOUNT_ID: 'acct' }, signing: ['APP_STORE_CONNECT_KEY'] },
  });
  assert.match(text, /Create the branch liftoff\/launch-1/);
  assert.match(text, /VERCEL_TOKEN/);
  assert.ok(!text.includes('secret-value'));
  assert.match(text, /APP_STORE_CONNECT_KEY/);
});
