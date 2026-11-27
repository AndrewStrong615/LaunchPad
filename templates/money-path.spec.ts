// Liftoff purchase-flow test for {{APP_NAME}}.
// Buys Pro with a Stripe test card, checks Pro unlocks, cancels the
// subscription, and checks Pro locks again. Run it against a preview or
// staging deploy that uses Stripe TEST keys, never production.
//
//   LIFTOFF_BASE_URL=https://preview.example.com \
//   STRIPE_SECRET_KEY=sk_test_... \
//   npx playwright test -c playwright.liftoff.config.ts
//
// The app needs these data-testid attributes (Claude adds them in the
// money-path-test skill): signup-email, signup-password, signup-submit,
// upgrade-button, pro-active (shown only to Pro users).
import { test, expect, type Page } from '@playwright/test';

const SECRET = process.env.STRIPE_SECRET_KEY || '';
const email = `liftoff+${Date.now()}@example.com`;
const password = `Lf-${Math.random().toString(36).slice(2)}-9!`;

test.skip(!SECRET.startsWith('sk_test_'), 'Needs a Stripe TEST secret key (sk_test_...)');

async function stripe(path: string, body?: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: body ? new URLSearchParams(body) : undefined,
  });
  if (!res.ok) throw new Error(`Stripe ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// The webhook updates the plan asynchronously, so reload until it shows.
async function waitForPro(page: Page, active: boolean) {
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('pro-active')).toHaveCount(active ? 1 : 0);
  }).toPass({ timeout: 60_000, intervals: [2_000, 3_000, 5_000] });
}

test('a new user can buy Pro, gets it, cancels, and loses it', async ({ page }) => {
  // 1. Sign up.
  await page.goto('/');
  await page.getByTestId('signup-email').fill(email);
  await page.getByTestId('signup-password').fill(password);
  await page.getByTestId('signup-submit').click();

  // 2. Free users don't have Pro.
  await expect(page.getByTestId('upgrade-button')).toBeVisible();
  await expect(page.getByTestId('pro-active')).toHaveCount(0);

  // 3. Pay on Stripe Checkout with the 4242 test card.
  await page.getByTestId('upgrade-button').click();
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  const emailField = page.locator('#email');
  if (await emailField.isEditable().catch(() => false)) await emailField.fill(email);
  await page.locator('#cardNumber').fill('4242 4242 4242 4242');
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill('Liftoff Test');
  const zip = page.locator('#billingPostalCode');
  if (await zip.isVisible().catch(() => false)) await zip.fill('10001');
  await page.locator('button[type=submit]').click();

  // 4. Back in the app, the webhook unlocks Pro.
  await page.waitForURL((u) => !u.hostname.endsWith('stripe.com'), { timeout: 60_000 });
  await waitForPro(page, true);

  // 5. Cancel the subscription (as the Billing Portal would) and check Pro locks.
  const customers = await stripe(`customers?email=${encodeURIComponent(email)}&limit=1`);
  expect(customers.data.length, 'Checkout should create a Stripe customer for this email').toBe(1);
  const subs = await stripe(`subscriptions?customer=${customers.data[0].id}&status=all&limit=1`);
  expect(subs.data.length, 'Checkout should create a subscription').toBe(1);
  await fetch(`https://api.stripe.com/v1/subscriptions/${subs.data[0].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${SECRET}` } });
  await waitForPro(page, false);
});
