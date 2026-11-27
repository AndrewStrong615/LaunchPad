---
name: pricing-experiments
description: Improve conversion with a trial and a pricing or paywall A/B test (PostHog feature flags on web, RevenueCat Experiments on mobile), then read the result from Pulse. Use when liftoff next suggests testing the paywall, or when the user asks about pricing.
---

# Pricing and paywall experiments

Price and paywall timing usually move revenue more than any feature. Only test with enough traffic: at least ~100 paywall views a week, or the test will run for months.

1. **Look first.** `liftoff pulse` gives paywall views, upgrades and cancellations. Watch three PostHog session recordings of people who saw the paywall and left.
2. **Pick one change** and tell the user the hypothesis in one line, e.g. "A 7-day trial will lift upgrades from 1.2% to 2%+". Good first tests, in order:
   - Add a free trial (7 days for most apps; 3 for daily-use apps).
   - Show the paywall at a success moment instead of on launch, or the reverse.
   - Yearly price: current vs. ~20% lower.
3. **Web**: create a PostHog feature flag experiment with two variants, read it in the paywall, create the extra Stripe price (test mode first), and track `paywall_viewed` / `upgraded_to_pro` with the variant as a property. **Mobile**: create a second RevenueCat offering and a RevenueCat Experiment; the app already reads the current offering, so no release is needed.
4. **Run it** until each variant has ~100 upgrades or 4 weeks pass, whichever comes first. Don't stop early on a good day.
5. **Decide** with the user from the experiment results, roll out the winner, and archive the loser's price (never delete prices existing subscribers use).

Never change live prices or start an experiment on live traffic without the user's yes.
