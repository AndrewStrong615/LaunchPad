// Running cost view: fixed fees for the services an app uses, free-tier
// limits, and the cut payment providers take. Prices are approximate list
// prices (late 2026) and change; each row links to the pricing page.
import { accountsFor } from './catalog.mjs';
import { revenueOf } from './pulse.mjs';

export const PRICING = {
  'apple-developer': { monthly: 99 / 12, note: '$99 a year', url: 'https://developer.apple.com/support/enrollment/' },
  'google-play': { monthly: 0, oneTime: 25, note: '$25 once', url: 'https://support.google.com/googleplay/android-developer/answer/6112435' },
  vercel: {
    monthly: 20,
    note: 'Hobby is free but not for commercial use; a paid app needs Pro ($20 per member a month)',
    url: 'https://vercel.com/pricing',
  },
  cloudflare: { monthly: 0, note: 'Pages free tier covers most launches; Workers Paid is $5 a month', url: 'https://www.cloudflare.com/plans/developer-platform/' },
  supabase: { monthly: 0, note: 'Free projects pause after a week without activity and have no backups; Pro is $25 a month', url: 'https://supabase.com/pricing', upgradeAt: 'launch', upgradeTo: 25 },
  posthog: { monthly: 0, note: '1M events a month free', url: 'https://posthog.com/pricing', limit: { metric: 'events', free: 1_000_000 } },
  sentry: { monthly: 0, note: '5k errors a month free; Team is about $26 a month', url: 'https://sentry.io/pricing/' },
  resend: { monthly: 0, note: '3,000 emails a month free (100 a day); Pro is $20 a month', url: 'https://resend.com/pricing' },
  revenuecat: { monthly: 0, note: 'Free up to $2.5k monthly tracked revenue, then 1% of it', url: 'https://www.revenuecat.com/pricing/', revenueShare: { above: 2500, rate: 0.01 } },
  stripe: { monthly: 0, note: '2.9% + 30¢ per card charge (US)', url: 'https://stripe.com/pricing', revenueShare: { above: 0, rate: 0.029 } },
  expo: { monthly: 0, note: 'Free plan has a monthly build allowance with slower queues; Starter is $19 a month', url: 'https://expo.dev/pricing' },
  github: { monthly: 0, note: '2,000 Actions minutes a month free on private repos (macOS minutes count 10x)', url: 'https://github.com/pricing' },
};

// Store commission on in-app purchases (Small Business Program rates).
const STORE_CUT = { rate: 0.15, note: 'App Store and Google Play take 15% under their small business programs (under $1M a year), 30% otherwise' };

export function costReport(summary) {
  const accounts = accountsFor(summary.platforms);
  const pulse = summary.pulse;
  const rows = accounts.filter((id) => PRICING[id]).map((id) => ({ id, ...PRICING[id] }));
  const warnings = [];
  let fixed = 0;
  for (const r of rows) {
    fixed += r.monthly;
    if (r.upgradeTo && summary.readyForRelease) {
      warnings.push(`${r.id}: ${r.note}. Upgrade before launch.`);
      fixed += r.upgradeTo;
    }
  }
  if (rows.some((r) => r.id === 'vercel')) warnings.push('Vercel: a paid app on the Hobby plan breaks its terms. Budget for Pro.');

  const mrr = revenueOf(pulse);
  let fees = null;
  if (mrr) {
    const mobile = summary.platforms.some((p) => p === 'ios' || p === 'android');
    const web = summary.platforms.includes('web');
    // Without a split, assume mobile revenue goes through the stores.
    fees = mobile && !web ? mrr * STORE_CUT.rate : mrr * PRICING.stripe.revenueShare.rate;
    if (mobile && mrr > PRICING.revenuecat.revenueShare.above) fees += (mrr - PRICING.revenuecat.revenueShare.above) * PRICING.revenuecat.revenueShare.rate;
    fees = Math.round(fees * 100) / 100;
  }
  return {
    rows,
    fixedMonthly: Math.round(fixed * 100) / 100,
    revenueFeesMonthly: fees,
    mrr,
    storeCut: summary.platforms.some((p) => p === 'ios' || p === 'android') ? STORE_CUT.note : null,
    warnings,
    note: 'Approximate list prices; check each pricing page before you decide.',
  };
}
