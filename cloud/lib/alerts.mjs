// Alerts: when watching (lib/watch.mjs) opens or closes an incident, Liftoff
// tells the owner where they already are. The first channel is a Slack or
// Discord webhook: free, and nothing to set up on Liftoff's side. Email
// needs a sending service and a domain of Liftoff's own, so it comes later.
//
// The webhook address is a secret (anyone who has it can post to that
// channel), so it's kept encrypted with the person's other keys, and only
// its last characters are ever shown back.
import { HttpError } from './http.mjs';

const KINDS = {
  'hooks.slack.com': { kind: 'slack', label: 'Slack', path: /^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/ },
  'discord.com': { kind: 'discord', label: 'Discord', path: /^\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/ },
  'discordapp.com': { kind: 'discord', label: 'Discord', path: /^\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/ },
  'ptb.discord.com': { kind: 'discord', label: 'Discord', path: /^\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/ },
  'canary.discord.com': { kind: 'discord', label: 'Discord', path: /^\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/ },
};
const LABEL = { slack: 'Slack', discord: 'Discord' };
const PER_HOUR = 30; // alerts per person, so a flapping site can't flood a channel
const HOUR = 3_600_000;

// A Slack incoming webhook or a Discord channel webhook, nothing else: the
// server posts to it, so it must never point anywhere a person chooses.
export function validateHook(value) {
  const v = String(value ?? '').trim();
  const bad = () => {
    throw new HttpError(400, 'Paste a Slack incoming webhook (https://hooks.slack.com/services/…) or a Discord channel webhook (https://discord.com/api/webhooks/…).');
  };
  if (!v || v.length > 500) bad();
  let u;
  try {
    u = new URL(v);
  } catch {
    bad();
  }
  const k = KINDS[u.hostname];
  if (u.protocol !== 'https:' || u.port || u.username || u.password || !k || !k.path.test(u.pathname)) bad();
  return { url: `https://${u.hostname}${u.pathname}`, kind: k.kind };
}

// Slack reads <…> as links and mentions, Discord @ as a ping: neither should
// come from a site's answer or a check's details.
const slackText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function minutes(from, to) {
  const m = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
  return m < 60 ? `${m} minute${m === 1 ? '' : 's'}` : m < 2880 ? `${Math.round(m / 60)} hours` : `${Math.round(m / 1440)} days`;
}

// The words for one incident opening or closing.
export function alertText(app, ev, appUrl) {
  const i = ev.incident;
  const said = (x) => String(x || '').trim().replace(/[.\s]+$/, '');
  const check = i.title.replace(/: stopped passing$/, '');
  let line;
  if (ev.type === 'opened') {
    if (i.kind === 'down') line = `${i.title}. ${said(i.detail)}.`;
    else if (i.kind === 'check') line = `${app.name}, ${check}: stopped passing. ${said(i.detail)}.`;
    else line = `${app.name}, ${i.title}: ${said(i.detail)}.`;
  } else if (i.kind === 'down') line = `${i.title.replace(/ is down$/, '')} is back up, after ${minutes(i.openedAt, i.closedAt)}.`;
  else if (i.kind === 'check') line = `${app.name}, ${check}: passing again.`;
  else line = `${app.name}, ${i.title.replace(/ needs renewing$/, '')}: ${said(i.closeDetail) || 'fixed'}.`;
  return `${ev.type === 'opened' ? 'Liftoff alert' : 'Liftoff'}: ${line}\n${appUrl}`;
}

export class Alerts {
  constructor(ctx, { fetch } = {}) {
    this.ctx = ctx;
    this.fetch = fetch || ctx.safeFetch;
    this.sent = new Map(); // uid → send times in the last hour
  }

  record(uid) {
    return this.ctx.store.getSecrets(uid).alerts || null;
  }

  save(uid, fn) {
    const secrets = this.ctx.store.getSecrets(uid);
    secrets.alerts = fn(secrets.alerts || null);
    if (!secrets.alerts) delete secrets.alerts;
    this.ctx.store.saveSecrets(uid, secrets);
    return secrets.alerts || null;
  }

  // What Account settings shows: the channel, never the address.
  view(uid) {
    const a = this.record(uid);
    if (!a?.hook) return { channel: null };
    return { channel: { kind: a.kind, label: LABEL[a.kind] || a.kind, hint: a.hint, addedAt: a.addedAt, lastSentAt: a.lastSentAt || null, lastError: a.lastError || null } };
  }

  async post(url, kind, text) {
    const body = kind === 'discord' ? { content: text.slice(0, 1900), allowed_mentions: { parse: [] } } : { text: slackText(text).slice(0, 3000) };
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new HttpError(502, `${LABEL[kind]} didn’t answer (${e.cause?.code || e.message}).`);
    }
    if (!res.ok) throw new HttpError(400, `${LABEL[kind]} didn’t take the message (it answered ${res.status}). Check the webhook still exists.`);
  }

  // Save a channel, after a first message to it goes through.
  async set(uid, value) {
    const { url, kind } = validateHook(value);
    await this.post(url, kind, 'Liftoff is connected. Alerts about your apps will arrive in this channel.');
    const at = new Date().toISOString();
    this.save(uid, () => ({ hook: this.ctx.store.encrypt(url), kind, hint: url.slice(-4), addedAt: at, lastSentAt: at }));
    return this.view(uid);
  }

  remove(uid) {
    this.save(uid, () => null);
    return this.view(uid);
  }

  async test(uid) {
    await this.send(uid, 'Liftoff test: alerts about your apps arrive here.', { force: true });
    return this.view(uid);
  }

  // Send to the person's channel. Returns false when there's none, or when
  // they've had their hour's worth. Failures are kept for Account settings.
  async send(uid, text, { force = false } = {}) {
    const a = this.record(uid);
    if (!a?.hook) {
      if (force) throw new HttpError(400, 'Add a Slack or Discord webhook first.');
      return false;
    }
    const now = Date.now();
    const recent = (this.sent.get(uid) || []).filter((t) => now - t < HOUR);
    if (!force && recent.length >= PER_HOUR) return false;
    this.sent.set(uid, [...recent, now]);
    let url;
    try {
      url = this.ctx.store.decrypt(a.hook);
    } catch {
      this.save(uid, (cur) => cur && { ...cur, lastError: 'The saved webhook can’t be read any more. Add it again.' });
      if (force) throw new HttpError(400, 'The saved webhook can’t be read any more. Add it again.');
      return false;
    }
    try {
      await this.post(url, a.kind, text);
      this.save(uid, (cur) => cur && { ...cur, lastSentAt: new Date().toISOString(), lastError: null });
      return true;
    } catch (e) {
      this.save(uid, (cur) => cur && { ...cur, lastError: e.message });
      if (force) throw e;
      console.error(`[liftoff-cloud] alert for ${uid}: ${e.message}`);
      return false;
    }
  }

  // lib/watch.mjs calls this for every incident that opens or closes.
  async incident(uid, slug, ev) {
    if (ev.quiet) return false;
    const app = this.ctx.store.loadApp(uid, slug);
    if (!app) return false;
    return this.send(uid, alertText(app, ev, `${this.ctx.config.publicUrl}/#${encodeURIComponent(slug)}`));
  }
}
