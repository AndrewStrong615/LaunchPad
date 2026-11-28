// Creates the Claude agent and sandbox environment cloud runs use, and keeps
// them in step with agent.mjs: their ids and a hash of their definitions are
// saved in <data>/agent.json, and a changed definition is pushed as an update.
// Ids given as LIFTOFF_AGENT_ID / LIFTOFF_ENVIRONMENT_ID are left alone.
import fs from 'node:fs';
import path from 'node:path';
import { agentDefinition, environmentDefinition } from './agent.mjs';
import { fingerprint } from './crypto.mjs';

export async function provision(client, config, { force = false, log = () => {} } = {}) {
  const a = config.anthropic;
  if (!a.managed && !force) return { changed: false };
  const agent = agentDefinition({ assistant: config.assistant });
  const environment = environmentDefinition(config.extraHosts);
  const hash = fingerprint(JSON.stringify(agent), JSON.stringify(environment));
  if (!force && a.agentId && a.environmentId && a.savedHash === hash) return { changed: false };

  if (a.agentId) {
    const res = await client.beta.agents.update(a.agentId, agent);
    log(`Updated agent ${a.agentId} (version ${res.version})`);
  } else {
    const res = await client.beta.agents.create(agent);
    a.agentId = res.id;
    log(`Created agent ${res.id}`);
  }
  if (a.environmentId) {
    await client.beta.environments.update(a.environmentId, environment);
    log(`Updated environment ${a.environmentId}`);
  } else {
    const res = await client.beta.environments.create(environment);
    a.environmentId = res.id;
    log(`Created environment ${res.id}`);
  }
  a.savedHash = hash;
  const file = path.join(config.dataDir, 'agent.json');
  fs.writeFileSync(file, JSON.stringify({ agentId: a.agentId, environmentId: a.environmentId, hash, at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  return { changed: true, agentId: a.agentId, environmentId: a.environmentId };
}
