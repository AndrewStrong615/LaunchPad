// Playwright config for the Liftoff purchase-flow test only.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /liftoff-money-path\.spec\.ts/,
  timeout: 180_000,
  retries: 1,
  use: {
    baseURL: process.env.LIFTOFF_BASE_URL,
    trace: 'retain-on-failure',
  },
});
