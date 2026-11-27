// A stand-in for the Anthropic SDK client's Managed Agents surface, enough to
// drive RunManager end to end without the network. A scenario is an async
// function (session, tools) that emits agent events and waits for the
// events the server sends back, like the real session would.
let n = 0;
const id = (p) => `${p}_${(++n).toString(36).padStart(6, '0')}`;

class Queue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(x) {
    const w = this.waiters.shift();
    if (w) w({ value: x, done: false });
    else this.items.push(x);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((r) => this.waiters.push(r));
  }
}

// Money is an integer string of cents, like the real API ("1500" is $15.00).
function checkMoney(m) {
  if (!m || !/^(0|[1-9]\d*)$/.test(String(m.amount)) || m.currency !== 'USD') {
    throw Object.assign(new Error(`invalid amount ${JSON.stringify(m)}: use cents as an integer string`), { status: 400, headers: {} });
  }
  return m;
}

export function fakeAnthropic(scenario = async () => {}) {
  const sessions = new Map();
  const calls = [];
  const files = new Map();
  const vaults = new Map();

  function emit(s, ev) {
    const full = { id: id('sevt'), processed_at: new Date().toISOString(), ...ev };
    s.events.push(full);
    for (const q of s.streams) q.push(full);
    for (const w of s.waiters.splice(0)) w.check();
    return full;
  }

  function waitFor(s, pred, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('fake session: timed out waiting')), timeout);
      const w = {
        check: () => {
          const hit = s.events.find((e) => !s.consumed.has(e.id) && pred(e));
          if (!hit) return s.waiters.push(w);
          s.consumed.add(hit.id);
          clearTimeout(t);
          resolve(hit);
        },
      };
      w.check();
    });
  }

  const client = {
    calls,
    sessions,
    beta: {
      sessions: {
        async create(params) {
          calls.push(['sessions.create', params]);
          if (params.budget) checkMoney(params.budget.max_list_cost);
          const s = { id: id('sesn'), params, events: [], streams: new Set(), waiters: [], consumed: new Set(), budget: params.budget };
          sessions.set(s.id, s);
          for (const ev of params.initial_events || []) emit(s, ev);
          const tools = {
            emit: (ev) => emit(s, ev),
            // Agent calls a custom tool and waits for the server's result.
            async custom(name, input) {
              const use = emit(s, { type: 'agent.custom_tool_use', name, input });
              emit(s, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [use.id] } });
              const res = await waitFor(s, (e) => e.type === 'user.custom_tool_result' && e.custom_tool_use_id === use.id);
              emit(s, { type: 'session.status_running' });
              return { text: res.content?.[0]?.text, isError: !!res.is_error };
            },
            // Agent uses a built-in tool that needs the user's approval.
            async ask(name, input) {
              const use = emit(s, { type: 'agent.tool_use', name, input, evaluated_permission: 'ask' });
              emit(s, { type: 'session.status_idle', stop_reason: { type: 'requires_action', event_ids: [use.id] } });
              const res = await waitFor(s, (e) => e.type === 'user.tool_confirmation' && e.tool_use_id === use.id);
              emit(s, { type: 'session.status_running' });
              if (res.result === 'allow') emit(s, { type: 'agent.tool_result', tool_use_id: use.id, content: [{ type: 'text', text: 'ok' }] });
              return res.result;
            },
            waitFor: (pred, timeout) => waitFor(s, pred, timeout),
            // Finish the turn. The cost (in cents) is on the session, not in an event.
            end: (cents = '125') => {
              s.cost = cents;
              emit(s, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } });
            },
          };
          // Spend reaches the budget: pause until the server raises it.
          tools.budget = async (cents) => {
            s.cost = cents;
            emit(s, { type: 'session.usage', usage: { list_cost: { amount: cents, currency: 'USD' } }, budget: s.budget });
            emit(s, { type: 'session.status_idle', stop_reason: { type: 'budget_reached' } });
            await waitFor(s, (e) => e.type === 'session.updated');
            emit(s, { type: 'session.status_running' });
          };
          s.done = Promise.resolve()
            .then(() => emit(s, { type: 'session.status_running' }))
            .then(() => scenario(s, tools))
            .catch((e) => {
              s.error = e;
            });
          return { id: s.id, status: 'running' };
        },
        async retrieve(sid) {
          const s = sessions.get(sid);
          if (!s) throw Object.assign(new Error('not found'), { status: 404, headers: {} });
          return { id: sid, status: 'idle', budget: s.budget, usage: s.cost == null ? {} : { list_cost: { amount: s.cost, currency: 'USD' } } };
        },
        async update(sid, params) {
          calls.push(['sessions.update', sid, params]);
          if (params.budget) checkMoney(params.budget.max_list_cost);
          const s = sessions.get(sid);
          s.budget = params.budget;
          emit(s, { type: 'session.updated', budget: params.budget });
          return { id: sid };
        },
        events: {
          list(sid, params = {}) {
            const s = sessions.get(sid);
            const since = params?.['created_at[gte]'];
            const copy = s ? s.events.filter((e) => !since || (e.processed_at && e.processed_at >= since)) : [];
            return (async function* gen() {
              for (const e of copy) yield e;
            })();
          },
          async stream(sid) {
            const s = sessions.get(sid);
            const q = new Queue();
            s.streams.add(q);
            const controller = { abort: () => { s.streams.delete(q); q.close(); } };
            return { controller, [Symbol.asyncIterator]: () => ({ next: () => q.next(), return: async () => { controller.abort(); return { done: true }; } }) };
          },
          async send(sid, { events }) {
            calls.push(['events.send', sid, events]);
            const s = sessions.get(sid);
            for (const ev of events) {
              if (ev.type === 'user.message' && s.events.at(-1)?.stop_reason?.type === 'requires_action') {
                throw Object.assign(new Error('waiting on a tool result'), { status: 400, headers: {} });
              }
              emit(s, ev);
              if (ev.type === 'user.interrupt') emit(s, { type: 'session.status_idle', stop_reason: { type: 'end_turn' } });
            }
            return { data: events };
          },
        },
      },
      files: {
        async upload({ file }) {
          const f = { id: id('file'), filename: file?.name || 'upload', size_bytes: file?.size ?? 0 };
          files.set(f.id, f);
          calls.push(['files.upload', f]);
          return f;
        },
        async delete(fid) {
          files.delete(fid);
          return {};
        },
        list({ scope_id }) {
          const s = sessions.get(scope_id);
          const out = s?.outputs || [];
          return (async function* gen() {
            for (const f of out) yield f;
          })();
        },
        async download(fid) {
          for (const s of sessions.values()) for (const f of s.outputs || []) if (f.id === fid) return new Response(f.body);
          throw Object.assign(new Error('not found'), { status: 404, headers: {} });
        },
      },
      vaults: {
        async create(params) {
          const v = { id: id('vlt'), params, creds: new Map() };
          vaults.set(v.id, v);
          calls.push(['vaults.create', params]);
          return { id: v.id };
        },
        credentials: {
          async create(vaultId, params) {
            const c = { id: id('vcrd'), params };
            vaults.get(vaultId).creds.set(c.id, c);
            calls.push(['vaults.credentials.create', vaultId, params]);
            return { id: c.id };
          },
          async archive(credId, { vault_id }) {
            vaults.get(vault_id).creds.delete(credId);
            calls.push(['vaults.credentials.archive', credId]);
            return {};
          },
        },
      },
    },
    vaults,
  };
  return client;
}
