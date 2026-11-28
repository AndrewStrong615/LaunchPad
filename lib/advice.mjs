// One recommended next action, from the checklist, tasks, steps and Pulse.
// Rules run in priority order; the first that fires wins. Each returns what
// to do, why (with the number behind it), and which skill or command does it.
import { revenueOf } from './pulse.mjs';

const CRITICAL = ['host-deploy', 'pay-webhook', 'sec-keys', 'sec-rls', 'pay-live', 'land-legal'];
const pct = (x) => `${Math.round(x * 1000) / 10}%`;

// What the owner sees Liftoff thinks the app does, in a few words.
const doing = (summary) => {
  const on = (summary.profile?.features || []).filter((f) => f.on).map((f) => f.label.toLowerCase());
  return on.length ? on.join(', ') : 'no payments, sign-in or server data';
};

const RULES = [
  ({ pulse }) =>
    pulse?.uptime && !pulse.uptime.up && {
      title: 'Your live site is down',
      why: `${pulse.uptime.status ? `It answered ${pulse.uptime.status}` : `It didn't answer (${pulse.uptime.error})`} just now.`,
      do: 'Check the latest deploy and roll back if it broke production.',
      skill: 'hosting',
    },
  ({ summary }) => {
    const bad = summary.checklist.filter((c) => CRITICAL.includes(c.id) && c.verify?.ok === false);
    return bad.length && {
      title: `Fix ${bad[0].title.toLowerCase()}`,
      why: `liftoff verify found: ${bad[0].verify.detail}.`,
      do: `Fix it, then run liftoff verify again.${bad.length > 1 ? ` ${bad.length - 1} more critical check(s) also failed.` : ''}`,
      command: 'liftoff verify',
    };
  },
  ({ pulse }) =>
    pulse?.sentry?.crashFreeSessions != null && pulse.sentry.crashFreeSessions < 0.99 && {
      title: 'Fix the top crash',
      why: `Crash-free sessions are ${pct(pulse.sentry.crashFreeSessions)} this week (aim for 99.5%+).${pulse.sentry.topIssue ? ` Top issue: ${pulse.sentry.topIssue.title} (${pulse.sentry.topIssue.events} events).` : ''}`,
      do: 'Open the issue, reproduce it and ship a fix.',
      url: pulse.sentry.topIssue?.url,
      skill: 'crash-reports',
    },
  ({ pulse }) =>
    pulse?.stripe?.failedPayments7d >= 3 && {
      title: 'Recover failed payments',
      why: `${pulse.stripe.failedPayments7d} payments failed in the last 7 days.`,
      do: 'Turn on Stripe Smart Retries and failed-payment emails, and add a "fix your card" banner in the app.',
      skill: 'payments',
    },
  // A new app: the steps, paperwork and checks follow from what Liftoff
  // thinks the app does, so the owner checks that before anything runs.
  ({ summary, pulse }) =>
    summary.profile && !summary.profile.confirmedAt && !pulse && !summary.steps.some((s) => s.status !== 'todo') && {
      title: `Check what ${summary.name} does`,
      why: `Liftoff picked ${summary.stepsTotal} launch steps and ${summary.checksTotal} checks from what it found: ${doing(summary)}.`,
      do: 'Turn off anything that doesn’t apply and turn on anything still to come, then confirm it.',
      command: 'liftoff profile',
      profile: true,
    },
  ({ summary }) => {
    const t = summary.tasks.find((x) => !x.done && x.startNow);
    return t && {
      title: 'Start the slow paperwork now',
      why: `"${t.title}" usually takes ${t.leadTime}, and the launch can't finish without it.`,
      do: t.url ? `Start it at ${t.url}, then mark the task done.` : 'Start it, then mark the task done.',
      taskId: t.id,
    };
  },
  ({ summary }) => {
    const stale = summary.steps.find((s) => s.stale);
    return stale && {
      title: `Finish or restart ${stale.label}`,
      why: `It has said "running" since ${stale.updatedAt}, so the session that ran it probably stopped.`,
      do: `Run /liftoff:launch ${stale.id}.`,
      command: `/liftoff:launch ${stale.id}`,
    };
  },
  ({ summary }) => {
    const id = summary.nextSteps[0];
    const step = summary.steps.find((s) => s.id === id);
    return step && {
      title: `Run ${step.label}`,
      why: `${summary.stepsDone} of ${summary.stepsTotal} launch steps are done and this one is ready to go.`,
      do: `Run /liftoff:launch ${id}.`,
      command: `/liftoff:launch ${id}`,
      skill: step.skill,
    };
  },
  ({ summary }) => {
    const t = summary.tasks.find((x) => !x.done && x.blocksRelease);
    return t && { title: 'Clear the release blocker', why: `${summary.blockingTasks} task(s) block release.`, do: t.title, taskId: t.id };
  },
  ({ pulse }) => {
    const p = pulse?.posthog;
    return p && p.paywallViews7d >= 100 && p.upgrades7d / p.paywallViews7d < 0.02 && {
      title: 'Test your paywall offer',
      why: `${p.paywallViews7d} paywall views and ${p.upgrades7d} upgrades this week (${pct(p.upgrades7d / p.paywallViews7d)}, typical is 2–5%).`,
      do: 'Run a pricing experiment: add a 7-day trial or test a lower yearly price against the current one.',
      skill: 'pricing-experiments',
    };
  },
  ({ pulse }) => {
    const s = pulse?.stripe;
    return s && s.cancellations7d > s.newSubscriptions7d && s.cancellations7d >= 3 && {
      title: 'Find out why people cancel',
      why: `${s.cancellations7d} cancellations and ${s.newSubscriptions7d} new subscriptions this week.`,
      do: 'Add a one-question cancellation survey in the Billing Portal and read the answers before changing anything.',
      skill: 'pricing-experiments',
    };
  },
  ({ pulse }) => {
    const p = pulse?.posthog;
    return p && p.signupsPrev7d >= 10 && p.signups7d < p.signupsPrev7d * 0.7 && {
      title: 'Sign-ups dropped, push reach',
      why: `${p.signups7d} sign-ups this week, down from ${p.signupsPrev7d}.`,
      do: 'Post one piece from the launch kit, or ask happy users for a review.',
      skill: 'growth',
    };
  },
  ({ pulse }) => {
    const p = pulse?.posthog;
    return p && p.signups7d >= 20 && p.activations7d / p.signups7d < 0.4 && {
      title: 'Help new users reach the core action',
      why: `Only ${pct(p.activations7d / p.signups7d)} of this week's ${p.signups7d} sign-ups reached the activation event.`,
      do: 'Shorten onboarding to the first success moment and watch three session recordings of people who dropped.',
      skill: 'growth',
    };
  },
  ({ summary, pulse }) =>
    summary.readyForRelease && !revenueOf(pulse) && {
      title: 'Get your first users',
      why: summary.features?.payments === false ? 'Everything is set up and nothing blocks release.' : 'Everything is set up and nothing blocks release, but there is no revenue yet.',
      do: 'Post the launch kit (Product Hunt, X, Reddit) and invite the waitlist.',
      skill: 'growth',
    },
];

export function nextAction(summary, pulse = summary.pulse) {
  for (const rule of RULES) {
    const r = rule({ summary, pulse });
    if (r) return r;
  }
  return { title: 'Keep going', why: 'Nothing needs attention right now.', do: 'Check back after the next release, or run liftoff pulse for fresh numbers.' };
}
