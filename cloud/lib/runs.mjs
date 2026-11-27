// Launch runs: one Claude Managed Agents session per run. This server starts
// the session (code mounted, keys in a vault), follows its event stream,
// carries out Liftoff tools, and holds Claude's questions and approval
// requests for the user, who answers them in the web app.
import crypto from 'node:crypto';
import { STEPS, stepsFor } from '../../lib/catalog.mjs';
import { DEFAULT_MODEL, EFFORT, MODELS, kickoff } from './agent.mjs';
import { sandboxEnvPlan, syncVault } from './accounts.mjs';
import { githubToken } from './importer.mjs';
import { zipDirectory } from './archive.mjs';
import { describeTool, NEEDS_APPROVAL, runTool } from './tools.mjs';
import { randomId } from './crypto.mjs';
import { HttpError } from './http.mjs';

// Statuses: starting → running ⇄ needs-you → finished | stopped | budget | failed
export const LIVE = new Set(['starting', 'running', 'needs-you']);
const OPEN = new Set([...LIVE, 'budget']);
const MAX_EVENTS = 600;
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The API takes and reports money in cents, as an integer string ("1500" is $15.00).
export const toCents = (usd) => String(Math.round(usd * 100));
export const fromCents = (amount) => {
  const n = Number(amount);
  return amount != null && amount !== '' && Number.isFinite(n) ? n / 100 : null;
};

// What the web app shows for a run.
export function publicRun(run, after = 0) {
  return {
    id: run.id,
    slug: run.slug,
    status: run.status,
    steps: run.steps,
    mode: run.mode,
    branch: run.branch || null,
    note: run.note || null,
    model: run.model || null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    endedAt: run.endedAt || null,
    cost: run.cost ?? null,
    budgetUsd: run.budgetUsd,
    pending: run.pending,
    pr: run.pr || null,
    outputs: run.outputs || [],
    error: run.error || null,
    seq: run.seq,
    events: run.events.filter((e) => e.n > after),
  };
}

export class RunManager {
  constructor(ctx) {
    this.ctx = ctx; // { store, config, github, anthropic, safeFetch }
    this.live = new Map(); // run id → the run object while this process follows it
    this.following = new Map(); // run id → { stop(), done }
    this.inflight = new Set(); // custom tool event ids being carried out
  }

  get client() {
    return this.ctx.anthropic;
  }

  // Whether runs can start, and why not.
  readiness() {
    const { config } = this.ctx;
    if (!this.client || !config.anthropic.configured) return { ok: false, why: 'The server has no Anthropic API key (ANTHROPIC_API_KEY).' };
    if (!config.anthropic.agentId || !config.anthropic.environmentId) return { ok: false, why: 'The Claude agent is not set up yet. Check the server log, or run `npm run setup` in cloud/.' };
    return { ok: true };
  }

  get(uid, slug, id) {
    const live = this.live.get(id);
    if (live && live.uid === uid && live.slug === slug) return live;
    return this.ctx.store.loadRun(uid, slug, id);
  }

  must(uid, slug, id) {
    const run = this.get(uid, slug, id);
    if (!run) throw new HttpError(404, 'No such run');
    return run;
  }

  list(uid, slug) {
    return this.ctx.store.listRuns(uid, slug).map((r) => this.live.get(r.id) || r);
  }

  save(run) {
    if (run.events.length > MAX_EVENTS) run.events = run.events.slice(-MAX_EVENTS);
    this.ctx.store.saveRun(run);
  }

  push(run, ev) {
    if (ev.id && run.events.some((e) => e.id === ev.id)) return null;
    const entry = { n: ++run.seq, at: ev.at || new Date().toISOString(), ...ev };
    run.events.push(entry);
    return entry;
  }

  // ---------- starting ----------

  // The model runs use when the person doesn't pick one.
  defaultModel() {
    const want = this.ctx.config.runModel;
    return MODELS.some((m) => m.id === want) ? want : DEFAULT_MODEL;
  }

  async start(uid, slug, { steps = [], note = '', model = null } = {}) {
    const ready = this.readiness();
    if (!ready.ok) throw new HttpError(503, ready.why);
    const { store, config } = this.ctx;
    if (model && !MODELS.some((m) => m.id === model)) throw new HttpError(400, `Pick one of these models: ${MODELS.map((m) => m.label).join(', ')}.`);
    const state = store.loadApp(uid, slug);
    if (!state) throw new HttpError(404, 'No such app');

    const valid = new Set(stepsFor(state.platforms).map((s) => s.id));
    const picked = [...new Set((Array.isArray(steps) ? steps : []).map(String))];
    const unknown = picked.filter((s) => !valid.has(s));
    if (unknown.length) throw new HttpError(400, `These steps don't apply to this app: ${unknown.join(', ')}`);
    const ordered = stepsFor(state.platforms).map((s) => s.id).filter((id) => picked.includes(id));

    const mine = store.allRuns((r) => r.uid === uid && LIVE.has(r.status));
    const open = store.listRuns(uid, slug).find((r) => OPEN.has(r.status));
    if (open) throw new HttpError(409, 'This app already has a run going. Continue or stop it first.');
    if (mine.length >= config.maxRunsPerUser) throw new HttpError(429, `You can have ${config.maxRunsPerUser} runs going at once.`);

    const token = githubToken(store, uid);
    const mode = state.source?.type === 'github' && token ? 'github' : 'upload';
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const run = {
      id: randomId('r_'),
      uid,
      slug,
      status: 'starting',
      steps: ordered,
      mode,
      branch: mode === 'github' ? `liftoff/launch-${day}-${crypto.randomBytes(2).toString('hex')}` : null,
      note: String(note || '').trim().slice(0, 1000) || null,
      model: model || this.defaultModel(),
      createdAt: new Date().toISOString(),
      budgetUsd: config.runBudgetUsd,
      cost: null,
      pending: [],
      events: [],
      seq: 0,
    };
    this.live.set(run.id, run);
    this.push(run, { kind: 'status', text: ordered.length ? `Starting a run for ${ordered.map((id) => STEPS.find((s) => s.id === id)?.label || id).join(', ')}` : 'Starting a run for every step that is left' });
    this.save(run);
    store.updateApp(uid, slug, (s) => s.log.push({ at: run.createdAt, msg: `Started a cloud run (${ordered.length ? ordered.join(', ') : 'all remaining steps'})` }));

    // The slow part (vault, upload, session) happens after the response.
    this.launch(run, state, token).catch((e) => this.fail(run, e));
    return run;
  }

  async launch(run, state, token) {
    const { store, config } = this.ctx;
    const client = this.client;
    const vaultId = await syncVault(client, store, run.uid);
    const resources = [];
    if (run.mode === 'github') {
      resources.push({
        type: 'github_repository',
        url: `https://github.com/${state.source.fullName}`,
        authorization_token: token,
        checkout: { type: 'branch', name: state.source.ref },
        mount_path: '/workspace/app',
      });
    } else {
      const zip = zipDirectory(state.root, { prefix: '' });
      const { toFile } = await import('@anthropic-ai/sdk');
      const file = await client.beta.files.upload({ file: await toFile(zip, 'app.zip', { type: 'application/zip' }) });
      run.uploadFileId = file.id;
      resources.push({ type: 'file', file_id: file.id, mount_path: '/app.zip' });
    }
    const text = kickoff({ state, steps: run.steps, mode: run.mode, branch: run.branch, envPlan: sandboxEnvPlan(store, run.uid), note: run.note });
    const session = await client.beta.sessions.create({
      // The agent's prompt and tools, on the model picked for this run.
      agent: { type: 'agent_with_overrides', id: config.anthropic.agentId, model: { id: run.model || DEFAULT_MODEL, effort: EFFORT } },
      environment_id: config.anthropic.environmentId,
      title: `Liftoff: ${state.name}`,
      metadata: { liftoff_user: run.uid, liftoff_app: run.slug, liftoff_run: run.id },
      resources,
      vault_ids: vaultId ? [vaultId] : [],
      budget: { type: 'limit', max_list_cost: { amount: toCents(run.budgetUsd), currency: 'USD' } },
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
    });
    run.sessionId = session.id;
    if (run.uploadFileId) client.beta.files.delete(run.uploadFileId).catch(() => {});
    if (run.status === 'stopped') {
      // Stopped while it was starting.
      await client.beta.sessions.events.send(session.id, { events: [{ type: 'user.interrupt' }] }).catch(() => {});
      this.save(run);
      return this.release(run);
    }
    run.status = 'running';
    this.follow(run);
  }

  fail(run, e) {
    const msg = e?.status === 401 ? 'The server\'s Anthropic API key was refused.' : e?.message || String(e);
    run.status = 'failed';
    run.error = clip(msg, 500);
    run.endedAt = new Date().toISOString();
    this.push(run, { kind: 'error', text: run.error });
    this.save(run);
    this.release(run);
  }

  release(run) {
    if (!this.following.has(run.id)) this.live.delete(run.id);
  }

  // ---------- following the session ----------

  follow(run) {
    if (!run.sessionId || this.following.has(run.id)) return;
    this.live.set(run.id, run);
    let stopped = false;
    let stream = null;
    const handle = {
      stop: () => {
        stopped = true;
        try {
          stream?.controller?.abort();
        } catch {}
      },
    };
    this.following.set(run.id, handle);
    handle.done = (async () => {
      for (let attempt = 0; !stopped; attempt++) {
        try {
          const keepGoing = await this.consume(run, (s) => (stream = s), () => stopped);
          if (!keepGoing) break;
          attempt = 0;
        } catch (e) {
          if (stopped) break;
          if (attempt >= 6) {
            this.push(run, { kind: 'note', text: 'Lost touch with Claude for a while. Open the run again to reconnect.' });
            run.disconnected = true;
            this.save(run);
            break;
          }
          await sleep(Math.min(60000, 2000 * 2 ** attempt));
        }
      }
    })().finally(() => {
      this.following.delete(run.id);
      if (!LIVE.has(run.status) || run.disconnected) this.live.delete(run.id);
    });
  }

  // Reopen following for a run that should be followed (after a restart or a drop).
  ensureFollowing(run) {
    if (run.sessionId && LIVE.has(run.status) && !this.following.has(run.id)) {
      run.disconnected = false;
      this.follow(run);
    }
  }

  // One connection: open the stream, read the history since the last event
  // handled (to cover any gap), then read live events, handling each event
  // once. Returns true to reconnect, false when the session is resting.
  async consume(run, setStream, isStopped) {
    const client = this.client;
    const stream = await client.beta.sessions.events.stream(run.sessionId);
    setStream(stream);
    const seen = new Set();
    const history = [];
    const since = run.cursor?.at ? { 'created_at[gte]': run.cursor.at } : undefined;
    for await (const ev of client.beta.sessions.events.list(run.sessionId, since)) history.push(ev);
    const answered = new Set();
    for (const ev of history) {
      if (ev.type === 'user.custom_tool_result') answered.add(ev.custom_tool_use_id);
      if (ev.type === 'user.tool_confirmation') answered.add(ev.tool_use_id);
    }
    for (const ev of history) {
      seen.add(ev.id);
      if (this.handled(run, ev)) continue;
      await this.onEvent(run, ev, answered);
      this.advance(run, ev);
    }
    this.save(run);
    if (isStopped() || this.resting(run)) return false;

    for await (const ev of stream) {
      if (isStopped()) return false;
      if (ev.id && seen.has(ev.id)) continue;
      if (ev.id) seen.add(ev.id);
      if (this.handled(run, ev)) continue;
      await this.onEvent(run, ev, answered);
      this.advance(run, ev);
      this.save(run);
      if (this.isRest(run, ev)) return false;
    }
    // The stream ended without the session resting: reconnect.
    return !isStopped();
  }

  // The cursor: the latest processed_at handled, and the ids handled at that instant.
  handled(run, ev) {
    const c = run.cursor;
    if (!c || !ev.processed_at) return false;
    return ev.processed_at < c.at || (ev.processed_at === c.at && c.ids.includes(ev.id));
  }

  advance(run, ev) {
    if (!ev.processed_at || !ev.id) return;
    const c = run.cursor;
    if (!c || ev.processed_at > c.at) run.cursor = { at: ev.processed_at, ids: [ev.id] };
    else if (ev.processed_at === c.at && !c.ids.includes(ev.id)) c.ids.push(ev.id);
  }

  // Whether nothing will happen until the user acts (after catching up on history).
  resting(run) {
    if (!LIVE.has(run.status)) return true;
    return run.status === 'needs-you' && run.pending.length > 0 && ![...this.inflight].some((id) => id.startsWith(`${run.id}:`));
  }

  // Whether the session is resting after this event, so nothing will arrive until the user acts.
  isRest(run, ev) {
    if (ev.type === 'session.status_terminated') return true;
    if (ev.type !== 'session.status_idle') return false;
    if (ev.stop_reason?.type !== 'requires_action') return true;
    return run.pending.length > 0 && ![...this.inflight].some((id) => id.startsWith(`${run.id}:`));
  }

  async onEvent(run, ev, answered) {
    const at = ev.processed_at || new Date().toISOString();
    switch (ev.type) {
      case 'user.message': {
        const text = textOf(ev.content);
        if (!run.events.some((e) => e.kind === 'kickoff')) this.push(run, { id: ev.id, at, kind: 'kickoff', text: 'Claude got the launch brief', detail: clip(text, 4000) });
        else if (!run.events.some((e) => e.id === ev.id) && !run.events.some((e) => e.kind === 'you' && e.text === text && !e.id)) this.push(run, { id: ev.id, at, kind: 'you', text: clip(text, 4000) });
        break;
      }
      case 'agent.message': {
        const text = textOf(ev.content);
        if (text.trim()) this.push(run, { id: ev.id, at, kind: 'message', text: clip(text, 8000) });
        break;
      }
      case 'agent.tool_use': {
        const entry = this.push(run, { id: ev.id, at, kind: 'tool', tool: ev.name, text: describeTool(ev.name, ev.input) });
        if (ev.evaluated_permission === 'ask' && !answered.has(ev.id) && !run.pending.some((p) => p.id === ev.id)) {
          const command = ev.name === 'bash' ? String(ev.input?.command || '') : null;
          run.pending.push({
            id: ev.id,
            kind: 'approval',
            tool: ev.name,
            text: command !== null ? 'Run this command in the sandbox' : describeTool(ev.name, ev.input),
            detail: clip(command ?? JSON.stringify(ev.input, null, 1), 3000),
            at,
          });
          run.status = 'needs-you';
        }
        if (entry && ev.evaluated_permission === 'deny') entry.out = 'Blocked as too risky';
        break;
      }
      case 'agent.tool_result':
      case 'agent.mcp_tool_result': {
        const target = run.events.find((e) => e.id === ev.tool_use_id);
        if (target) {
          target.out = clip(textOf(ev.content), 1500);
          if (ev.is_error) target.isError = true;
        }
        break;
      }
      case 'agent.custom_tool_use':
        await this.onCustomTool(run, ev, answered, at);
        break;
      case 'session.status_running':
        if (run.status !== 'needs-you' || run.pending.length === 0) run.status = 'running';
        run.disconnected = false;
        break;
      case 'session.status_rescheduled':
        this.push(run, { id: ev.id, at, kind: 'note', text: 'Claude hit a hiccup and is retrying' });
        break;
      case 'session.status_idle':
        this.onIdle(run, ev, at);
        break;
      case 'session.status_terminated':
        if (LIVE.has(run.status)) run.status = run.stopRequested ? 'stopped' : 'failed';
        run.endedAt ||= at;
        break;
      case 'session.error': {
        const msg = ev.error?.message || ev.error?.type || 'Unknown error';
        this.push(run, { id: ev.id, at, kind: 'error', text: clip(msg, 500) });
        break;
      }
      case 'session.usage': {
        const cost = fromCents(ev.usage?.list_cost?.amount);
        if (cost !== null) run.cost = cost;
        break;
      }
      case 'agent.thread_context_compacted':
        this.push(run, { id: ev.id, at, kind: 'note', text: 'Claude summarized its notes to keep going' });
        break;
      default:
        break;
    }
  }

  onIdle(run, ev, at) {
    const why = ev.stop_reason?.type;
    if (why === 'requires_action') {
      if (run.pending.length) run.status = 'needs-you';
      return;
    }
    // The session has stopped working for now: read what it has cost so far.
    this.refreshCost(run);
    if (why === 'budget_reached') {
      run.status = 'budget';
      this.push(run, { id: ev.id, at, kind: 'status', text: `Paused at the $${run.budgetUsd} budget for this run` });
      return;
    }
    if (why === 'retries_exhausted' || why === 'refusal') {
      run.status = 'failed';
      run.error = why === 'refusal' ? 'Claude declined to continue this run.' : 'Claude kept hitting errors and stopped.';
      run.endedAt = at;
      this.push(run, { id: ev.id, at, kind: 'error', text: run.error });
      return;
    }
    // end_turn: Claude finished (or was interrupted).
    run.status = run.stopRequested ? 'stopped' : 'finished';
    run.endedAt = at;
    run.stopRequested = false;
    this.push(run, { id: ev.id, at, kind: 'status', text: run.status === 'stopped' ? 'Stopped' : 'Claude finished. Send a message to keep going.' });
    if (run.mode === 'upload') this.collectOutputs(run).catch(() => {});
    this.ctx.store.updateApp(run.uid, run.slug, (s) => s.log.push({ at, msg: `Cloud run ${run.status}` }));
  }

  async onCustomTool(run, ev, answered, at) {
    if (answered.has(ev.id)) {
      // Already answered (seen again after a reconnect): show it, don't redo it.
      if (ev.name !== 'ask_user') this.push(run, { id: ev.id, at, kind: 'liftoff', tool: ev.name, text: describeTool(ev.name, ev.input) });
      return;
    }
    if (ev.name === 'ask_user') {
      const question = clip(String(ev.input?.question || ''), 1000);
      const options = Array.isArray(ev.input?.options) ? ev.input.options.slice(0, 4).map((o) => clip(String(o), 120)) : [];
      this.push(run, { id: ev.id, at, kind: 'question', text: question, options });
      if (!run.pending.some((p) => p.id === ev.id)) run.pending.push({ id: ev.id, kind: 'question', text: question, options, at });
      run.status = 'needs-you';
      return;
    }
    if (NEEDS_APPROVAL[ev.name]) {
      const text = NEEDS_APPROVAL[ev.name](this.ctx, run, ev.input || {});
      this.push(run, { id: ev.id, at, kind: 'liftoff', tool: ev.name, text: describeTool(ev.name, ev.input) });
      if (!run.pending.some((p) => p.id === ev.id)) run.pending.push({ id: ev.id, kind: 'secret', tool: ev.name, input: ev.input, text, at });
      run.status = 'needs-you';
      return;
    }
    const key = `${run.id}:${ev.id}`;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    const entry = this.push(run, { id: ev.id, at, kind: 'liftoff', tool: ev.name, text: describeTool(ev.name, ev.input) });
    try {
      const result = await runTool(this.ctx, run, ev.name, ev.input);
      if (entry && result.isError) {
        entry.isError = true;
        entry.out = clip(result.text, 500);
      }
      await this.sendResult(run, ev.id, result.text, result.isError);
      answered.add(ev.id);
    } finally {
      this.inflight.delete(key);
    }
  }

  sendResult(run, id, text, isError = false) {
    return this.client.beta.sessions.events.send(run.sessionId, {
      events: [{ type: 'user.custom_tool_result', custom_tool_use_id: id, content: [{ type: 'text', text: text || '(no output)' }], is_error: isError }],
    });
  }

  async refreshCost(run) {
    try {
      const session = await this.client.beta.sessions.retrieve(run.sessionId);
      const cost = fromCents(session?.usage?.list_cost?.amount);
      if (cost !== null && cost !== run.cost) {
        run.cost = cost;
        this.save(run);
      }
    } catch {}
  }

  async collectOutputs(run) {
    for (let i = 0; i < 3; i++) {
      const files = [];
      for await (const f of this.client.beta.files.list({ scope_id: run.sessionId, betas: ['managed-agents-2026-04-01'] })) {
        files.push({ id: f.id, filename: f.filename, size: f.size_bytes ?? null });
      }
      if (files.length) {
        run.outputs = files;
        this.save(run);
        return;
      }
      await sleep(1500);
    }
  }

  // ---------- the user's side ----------

  takePending(run, id, kinds) {
    const i = run.pending.findIndex((p) => p.id === id && kinds.includes(p.kind));
    if (i === -1) throw new HttpError(409, 'That request was already answered.');
    return run.pending.splice(i, 1)[0];
  }

  afterAnswer(run) {
    run.status = run.pending.length ? 'needs-you' : 'running';
    this.save(run);
    this.ensureFollowing(run);
  }

  async approve(uid, slug, id, { eventId, allow, reason }) {
    const run = this.must(uid, slug, id);
    this.live.set(run.id, run);
    const p = this.takePending(run, String(eventId), ['approval', 'secret']);
    const why = String(reason || '').trim().slice(0, 500);
    this.push(run, { kind: 'you', text: `${allow ? 'Allowed' : 'Declined'}: ${p.text}${why ? ` (${why})` : ''}` });
    try {
      if (p.kind === 'approval') {
        await this.client.beta.sessions.events.send(run.sessionId, {
          events: [{ type: 'user.tool_confirmation', tool_use_id: p.id, result: allow ? 'allow' : 'deny', ...(allow ? {} : { deny_message: why || 'The user declined this. Find another way or ask them.' }) }],
        });
      } else if (allow) {
        const result = await runTool(this.ctx, run, p.tool, p.input);
        await this.sendResult(run, p.id, result.text, result.isError);
        if (result.isError) this.push(run, { kind: 'error', text: clip(result.text, 500) });
      } else {
        await this.sendResult(run, p.id, `The user declined${why ? `: ${why}` : ''}. Add a task for them instead.`, true);
      }
    } catch (e) {
      run.pending.push(p);
      this.save(run);
      throw e;
    }
    this.afterAnswer(run);
    return run;
  }

  async answer(uid, slug, id, { eventId, text }) {
    const run = this.must(uid, slug, id);
    this.live.set(run.id, run);
    const answer = String(text || '').trim().slice(0, 4000);
    if (!answer) throw new HttpError(400, 'Type an answer');
    const p = this.takePending(run, String(eventId), ['question']);
    try {
      await this.sendResult(run, p.id, `The user answered: ${answer}`);
    } catch (e) {
      run.pending.push(p);
      this.save(run);
      throw e;
    }
    this.push(run, { kind: 'you', text: answer });
    this.afterAnswer(run);
    return run;
  }

  async message(uid, slug, id, text) {
    const run = this.must(uid, slug, id);
    const msg = String(text || '').trim().slice(0, 8000);
    if (!msg) throw new HttpError(400, 'Type a message');
    if (!run.sessionId) throw new HttpError(409, 'This run never started.');
    if (run.status === 'needs-you') throw new HttpError(409, 'Answer what Claude asked first.');
    if (run.status === 'budget') throw new HttpError(409, 'This run is paused at its budget. Raise the budget to keep going.');
    if (run.status === 'failed' && !run.sessionId) throw new HttpError(409, 'This run failed before it started.');
    this.live.set(run.id, run);
    // Add the message before sending it: the session can echo it back on the
    // stream before send() returns, and the echo is only skipped if it's here.
    const entry = this.push(run, { kind: 'you', text: msg });
    try {
      await this.client.beta.sessions.events.send(run.sessionId, { events: [{ type: 'user.message', content: [{ type: 'text', text: msg }] }] });
    } catch (e) {
      run.events.splice(run.events.indexOf(entry), 1);
      throw e;
    }
    run.status = 'running';
    run.endedAt = null;
    run.error = null;
    this.save(run);
    this.ensureFollowing(run);
    return run;
  }

  async stop(uid, slug, id) {
    const run = this.must(uid, slug, id);
    if (!OPEN.has(run.status)) return run;
    this.live.set(run.id, run);
    if (!run.sessionId || run.status === 'budget') {
      run.status = 'stopped';
      run.endedAt = new Date().toISOString();
      run.pending = [];
      this.push(run, { kind: 'status', text: 'Stopped' });
      this.save(run);
      this.following.get(run.id)?.stop();
      this.release(run);
      return run;
    }
    // Settle anything waiting on the user, then interrupt.
    const events = run.pending.map((p) =>
      p.kind === 'approval'
        ? { type: 'user.tool_confirmation', tool_use_id: p.id, result: 'deny', deny_message: 'The user stopped the run.' }
        : { type: 'user.custom_tool_result', custom_tool_use_id: p.id, content: [{ type: 'text', text: 'The user stopped the run.' }], is_error: true },
    );
    events.push({ type: 'user.interrupt' });
    run.stopRequested = true;
    run.pending = [];
    await this.client.beta.sessions.events.send(run.sessionId, { events });
    this.push(run, { kind: 'you', text: 'Stop' });
    run.status = 'running';
    this.save(run);
    this.ensureFollowing(run);
    return run;
  }

  async raiseBudget(uid, slug, id, addUsd) {
    const run = this.must(uid, slug, id);
    const add = Number(addUsd);
    if (!Number.isFinite(add) || add < 1 || add > 100) throw new HttpError(400, 'Add between $1 and $100.');
    if (run.status !== 'budget') throw new HttpError(409, 'This run is not paused at its budget.');
    this.live.set(run.id, run);
    const next = Math.round((Math.max(run.cost ?? 0, run.budgetUsd) + add) * 100) / 100;
    await this.client.beta.sessions.update(run.sessionId, { budget: { type: 'limit', max_list_cost: { amount: toCents(next), currency: 'USD' } } });
    run.budgetUsd = next;
    run.status = 'running';
    this.push(run, { kind: 'you', text: `Raised the budget to $${next.toFixed(2)}` });
    this.save(run);
    this.ensureFollowing(run);
    return run;
  }

  async download(uid, slug, id, fileId) {
    const run = this.must(uid, slug, id);
    const file = (run.outputs || []).find((f) => f.id === fileId);
    if (!file) throw new HttpError(404, 'No such file');
    const res = await this.client.beta.files.download(file.id);
    return { file, body: Buffer.from(await res.arrayBuffer()) };
  }

  // After a restart: pick up every run that was still going.
  resumeAll() {
    if (!this.readiness().ok) return 0;
    const runs = this.ctx.store.allRuns((r) => LIVE.has(r.status) && r.sessionId);
    for (const run of runs) this.follow(run);
    // Runs that died while starting (no session yet) can't be resumed.
    for (const run of this.ctx.store.allRuns((r) => r.status === 'starting' && !r.sessionId)) this.fail(run, new Error('The server restarted before the run started. Start it again.'));
    return runs.length;
  }

  async close() {
    const all = [...this.following.values()];
    for (const f of all) f.stop();
    await Promise.allSettled(all.map((f) => f.done));
  }
}
