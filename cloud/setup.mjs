#!/usr/bin/env node
// Creates or updates the Claude agent and sandbox environment that cloud runs
// use, and saves their ids to <data>/agent.json. The server also does this on
// start when ANTHROPIC_API_KEY is set, so this is only needed to do it by hand
// or to get the ids for LIFTOFF_AGENT_ID / LIFTOFF_ENVIRONMENT_ID.
//
//   npm run setup               create or update, save ids
//   npm run setup -- --print    also print the ids as env vars
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from './lib/config.mjs';
import { provision } from './lib/provision.mjs';

const config = loadConfig();
if (!config.anthropic.configured) {
  console.error('Set ANTHROPIC_API_KEY first.');
  process.exit(1);
}
const res = await provision(new Anthropic(), config, { force: true, log: console.log });
console.log(`Saved to ${config.dataDir}/agent.json`);
if (process.argv.includes('--print')) console.log(`\nLIFTOFF_AGENT_ID=${res.agentId}\nLIFTOFF_ENVIRONMENT_ID=${res.environmentId}`);
