// Files `liftoff scaffold` writes into an app: the purchase flow test and the
// uptime check. Shared by the CLI and Liftoff Cloud (which hands them to Claude).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export const SCAFFOLDS = {
  'money-test': [['money-path.spec.ts', 'e2e/liftoff-money-path.spec.ts'], ['playwright.liftoff.config.ts', 'playwright.liftoff.config.ts']],
  'money-test-mobile': [['money-path.maestro.yaml', '.maestro/liftoff-money-path.yaml']],
  uptime: [['uptime.yml', '.github/workflows/liftoff-uptime.yml']],
};

// [{ path, content }] for one scaffold, with the app's name and health path filled in.
export function renderScaffold(kind, state) {
  const files = SCAFFOLDS[kind];
  if (!files) throw new Error(`Scaffold one of: ${Object.keys(SCAFFOLDS).join(', ')}`);
  return files.map(([from, to]) => ({
    path: to,
    content: fs
      .readFileSync(path.join(TEMPLATES, from), 'utf8')
      .replaceAll('{{APP_NAME}}', state.name)
      .replaceAll('{{HEALTH_PATH}}', state.config?.['health.path'] || '/api/health'),
  }));
}
