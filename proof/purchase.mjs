// One purchase test in a real browser: open the app, sign up as a new user,
// buy Pro on Stripe Checkout with the 4242 test card, and check Pro unlocks.
// Then it waits while Liftoff Cloud cancels the subscription with the user's
// Stripe test key (this process never holds a key), and checks Pro locks again.
//
// The app needs the data-testid attributes the money-path-test skill adds:
// signup-email, signup-password, signup-submit, upgrade-button, and
// pro-active (shown only to Pro users). Same flow as templates/money-path.spec.ts.
import { startGuard } from './guard.mjs';
import { STEPS } from './protocol.mjs';

export const TIMEOUTS = { page: 30000, checkout: 30000, back: 60000, pro: 60000, cancel: 120000, job: 8 * 60000 };

class Stop extends Error {
  constructor(step, message, extra = {}) {
    super(message);
    Object.assign(this, { step, ...extra });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (id) => `${id.slice(0, 8)}…${id.slice(-4)}`;
const CHECKOUT_ID = /\/(cs_(?:test|live)_[A-Za-z0-9]+)/;

// The webhook updates the plan on its own time, so reload until Pro shows (or goes).
async function waitForPro(page, active, timeout) {
  const end = Date.now() + timeout;
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    const n = await page.getByTestId('pro-active').count().catch(() => -1);
    if ((n > 0) === active && n >= 0) return Math.round((Date.now() - t0) / 1000);
    if (Date.now() > end) return null;
    await sleep([1000, 2000, 3000, 5000][Math.min(i, 3)]);
    await page.reload({ waitUntil: 'load', timeout: TIMEOUTS.page }).catch(() => {});
  }
}

async function visible(locator, timeout) {
  return locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
}

// Fill Stripe's hosted Checkout page. Field ids are Stripe's own.
async function payWithTestCard(page, email) {
  const card = page.locator('#cardNumber');
  if (!(await visible(card, 8000))) {
    // Checkout shows a payment method list when the account has several turned on.
    const pick = page.locator('[data-testid="card-accordion-item-button"], button:has-text("Card")');
    if (await visible(pick, 2000)) await pick.first().click();
    if (!(await visible(card, 8000))) throw new Error("Stripe Checkout showed no card form");
  }
  const emailField = page.locator('#email');
  if (await emailField.isEditable({ timeout: 1000 }).catch(() => false)) await emailField.fill(email);
  await card.fill('4242 4242 4242 4242');
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  const name = page.locator('#billingName');
  if (await name.isVisible().catch(() => false)) await name.fill('Liftoff Test');
  const zip = page.locator('#billingPostalCode');
  if (await zip.isVisible().catch(() => false)) await zip.fill('10001');
  // Don't sign the test user up for Link (it would ask for a phone number).
  const link = page.locator('#enableStripePass');
  if (await link.isChecked({ timeout: 500 }).catch(() => false)) await link.uncheck().catch(() => {});
}

// opts: { chromium, url, email, password, allowPrivate, checkoutHost, timeouts,
//         onStep(steps), onWait(sessionId) → Promise<{ cancelled, detail }>, signal }
// Resolves { ok, steps: [{ name, ok, detail, shot? (Buffer) }], sessionId, failedAt?, detail, refused?, blocked }.
export async function runPurchase(opts) {
  const { chromium, url, email, password, allowPrivate = false, checkoutHost = 'checkout.stripe.com', onStep = () => {}, onWait, signal } = opts;
  const T = { ...TIMEOUTS, ...(opts.timeouts || {}) };
  const steps = [];
  const report = () => onStep(steps.map(({ shot, ...s }) => ({ ...s, shot: !!shot })));
  let sessionId = null;
  const guard = await startGuard({ allowPrivate });
  let browser = null;
  let page = null;
  const shoot = async () => (page ? page.screenshot({ type: 'jpeg', quality: 60, timeout: 10000 }).catch(() => null) : null);
  const done = async (name, detail) => {
    steps.push({ name, ok: true, detail, shot: await shoot() });
    report();
  };
  const onCheckout = (u) => {
    try {
      return new URL(u).hostname === checkoutHost;
    } catch {
      return false;
    }
  };

  try {
    if (signal?.aborted) throw new Stop('open', 'Stopped');
    browser = await chromium.launch({
      proxy: { server: guard.url },
      args: ['--disable-dev-shm-usage', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    signal?.addEventListener('abort', () => browser?.close().catch(() => {}), { once: true });
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 }, locale: 'en-US' });
    context.setDefaultTimeout(T.page);
    page = await context.newPage();

    // 1. Open the app.
    let res;
    const blockedWhy = () => guard.blocked.length && `Liftoff blocked it (${guard.blocked[0]})`;
    try {
      res = await page.goto(url, { waitUntil: 'load', timeout: T.page });
    } catch (e) {
      throw new Stop('open', `Couldn't open ${url}: ${blockedWhy() || e.message.split('\n')[0]}`);
    }
    if (res && res.status() >= 400) throw new Stop('open', `Couldn't open ${url}: ${blockedWhy() || `it answered ${res.status()}`}`);
    await done('open', `Opened ${new URL(page.url()).host}`);

    // 2. Sign up; a free user sees Upgrade and no Pro.
    const ids = ['signup-email', 'signup-password', 'signup-submit'];
    for (const id of ids) {
      if (!(await visible(page.getByTestId(id), 10000))) throw new Stop('sign-up', `No element with data-testid="${id}" on ${page.url()}. The purchase flow test step adds the test ids the test needs.`);
    }
    await page.getByTestId('signup-email').first().fill(email);
    await page.getByTestId('signup-password').first().fill(password);
    await page.getByTestId('signup-submit').first().click();
    if (!(await visible(page.getByTestId('upgrade-button'), T.page))) throw new Stop('sign-up', `After signing up, no data-testid="upgrade-button" appeared on ${page.url()}. If the app asks new users to confirm their email first, that step needs a test inbox, which Liftoff doesn't have yet.`);
    if (await page.getByTestId('pro-active').count()) throw new Stop('sign-up', 'A brand-new user already shows data-testid="pro-active", so Pro isn\'t locked for free users.');
    await done('sign-up', `Signed up as ${email}; the free plan shows Upgrade`);

    // 3. Upgrade → Stripe Checkout → pay with the test card.
    const popup = page.context().waitForEvent('page', { timeout: T.checkout }).catch(() => null);
    await page.getByTestId('upgrade-button').first().click();
    const reached = await Promise.race([
      page.waitForURL(onCheckout, { timeout: T.checkout }).then(() => page, () => null),
      popup.then(async (p) => {
        if (!p) return null;
        await p.waitForURL(onCheckout, { timeout: T.checkout }).catch(() => {});
        return onCheckout(p.url()) ? p : null;
      }),
    ]);
    if (!reached) throw new Stop('checkout', `Pressing Upgrade didn't open Stripe Checkout (${checkoutHost}) within ${T.checkout / 1000} seconds; the page stayed on ${page.url()}`);
    page = reached;
    const m = CHECKOUT_ID.exec(new URL(page.url()).pathname);
    if (!m) throw new Stop('checkout', `Couldn't read the Checkout Session id from ${page.url()}`);
    sessionId = m[1];
    if (sessionId.startsWith('cs_live_')) throw new Stop('checkout', 'Upgrade opened a LIVE Stripe Checkout. Liftoff never pays for real: point preview.url at a deploy that uses Stripe test keys.', { refused: true });
    try {
      await payWithTestCard(page, email);
    } catch (e) {
      throw new Stop('checkout', `Couldn't fill Stripe Checkout: ${e.message.split('\n')[0]}`);
    }
    const filled = await shoot();
    await page.locator('[data-testid="hosted-payment-submit-button"], .SubmitButton, button[type=submit]').first().click();

    // 4. Back in the app, the webhook unlocks Pro.
    try {
      await page.waitForURL((u) => !onCheckout(u), { timeout: T.back });
    } catch {
      const text = (await page.locator('[role=alert], .FieldError, .Notice').allInnerTexts().catch(() => [])).join(' ').trim();
      throw new Stop('checkout', `Stripe Checkout didn't send the buyer back to the app within ${T.back / 1000} seconds${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    steps.push({ name: 'checkout', ok: true, detail: `Paid ${short(sessionId)} with the 4242 test card`, shot: filled });
    report();
    const unlocked = await waitForPro(page, true, T.pro);
    if (unlocked === null) throw new Stop('pro', `Paid, but data-testid="pro-active" didn't appear within ${T.pro / 1000} seconds of returning to ${new URL(page.url()).host}. Check that the webhook marks the user as Pro.`);
    await done('pro', `Pro unlocked ${unlocked ? `${unlocked} s after paying` : 'right away'}`);

    // 5. Liftoff Cloud cancels the subscription in Stripe.
    const answer = await Promise.race([onWait(sessionId), sleep(T.cancel).then(() => null)]);
    if (!answer) throw new Stop('cancel', "Liftoff didn't cancel the test subscription in time");
    if (answer.error) throw new Stop('cancel', answer.error);
    if (!answer.cancelled) {
      steps.push({ name: 'cancel', ok: true, detail: answer.detail || 'One-time purchase: nothing to cancel' });
      report();
      return { ok: true, steps, sessionId, detail: 'Bought, and Pro unlocked', blocked: guard.blocked };
    }
    steps.push({ name: 'cancel', ok: true, detail: answer.detail || 'Cancelled the subscription in Stripe' });
    report();

    // 6. Pro locks again.
    const locked = await waitForPro(page, false, T.pro);
    if (locked === null) throw new Stop('locked', `The subscription was cancelled, but data-testid="pro-active" was still there after ${T.pro / 1000} seconds. Check that customer.subscription.deleted removes Pro.`);
    await done('locked', `Pro locked again ${locked ? `${locked} s after cancelling` : 'right away'}`);
    return { ok: true, steps, sessionId, detail: 'Bought, Pro unlocked, cancelled, Pro locked again', blocked: guard.blocked };
  } catch (e) {
    const step = e instanceof Stop ? e.step : STEPS[steps.length]?.[0] || 'locked';
    const detail = signal?.aborted ? 'Stopped' : e instanceof Stop ? e.message : `The test browser failed: ${String(e.message || e).split('\n')[0]}`;
    steps.push({ name: step, ok: false, detail, shot: await shoot() });
    report();
    return { ok: false, failedAt: step, detail, steps, sessionId, refused: !!e.refused, crashed: !(e instanceof Stop), blocked: guard.blocked };
  } finally {
    await browser?.close().catch(() => {});
    await guard.close();
  }
}
