// Liftoff Cloud screens on top of the shared Mission Control front end
// (mission-control.js): adding apps, connecting accounts, and runs where
// Claude does the launch steps in the cloud.
(() => {
  const MC = window.MC;
  const { h, icon, api, go, render, refresh, toast, state, ago } = MC;

  Object.assign(MC.ICONS, {
    terminal: '<path d="m5 7 5 5-5 5M12 19h7"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    github: '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>',
    send: '<path d="m4 12 16-8-6 16-2-7z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
    pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2"/>',
  });

  const LIVE = new Set(['starting', 'running', 'needs-you']);
  const OPEN = new Set([...LIVE, 'budget']);
  const RUN_WORD = { starting: 'Starting', running: 'Working', 'needs-you': 'Needs you', finished: 'Finished', stopped: 'Stopped', budget: 'Paused at budget', failed: 'Failed' };
  const RUN_TONE = { starting: 'run', running: 'run', 'needs-you': 'warn', finished: 'good', stopped: '', budget: 'warn', failed: 'bad' };

  // Cloud-only state.
  const C = { me: null, slug: null, run: null, runs: null, pick: {}, feedTop: null, stick: true, busy: false, repos: null, note: '', draft: '', loading: false, model: null };
  const models = () => C.me?.models?.choices || [];
  const modelLabel = (id) => models().find((m) => m.id === id)?.label || id;
  const STRONGEST = 'claude-opus-5-5';
  try {
    const saved = JSON.parse(sessionStorage.getItem('lc-run') || 'null');
    if (saved) Object.assign(C, { slug: saved.slug, runId: saved.runId });
  } catch {}
  const remember = () => {
    try { sessionStorage.setItem('lc-run', JSON.stringify({ slug: C.slug, runId: C.run?.id || null })); } catch {}
  };

  const appOf = (slug) => state.apps.find((a) => a.slug === slug);
  const runPill = (status, sm) => h('span', { class: `pill ${RUN_TONE[status] || ''}${sm ? ' sm' : ''}` }, status === 'running' || status === 'starting' ? h('span', { class: 'd' }) : null, RUN_WORD[status] || status);
  const usd = (n) => (n === null || n === undefined ? '–' : `$${Number(n).toFixed(2)}`);

  async function post(path, body) {
    return api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  async function busy(btn, fn) {
    if (C.busy) return;
    C.busy = true;
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } catch (e) {
      toast(e.message);
    } finally {
      C.busy = false;
      if (btn) btn.disabled = false;
    }
  }

  // ---------- adding an app ----------

  function addForms() {
    const url = h('input', { class: 'in', type: 'url', placeholder: 'https://github.com/you/your-app', 'aria-label': 'GitHub repository link', required: true });
    const ref = h('input', { class: 'in', type: 'text', placeholder: 'main', 'aria-label': 'Branch (optional)' });
    const ghBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('github'), 'Import');
    const repoPick = h('div');
    const showRepos = () => {
      if (!C.repos) return;
      if (!C.repos.length) return repoPick.replaceChildren(h('div', { class: 'small' }, 'No repositories found on your GitHub account.'));
      const sel = h('select', { class: 'in', 'aria-label': 'Your repositories', onchange: (e) => { url.value = e.target.value; } },
        h('option', { value: '' }, 'Pick one of your repositories…'),
        C.repos.map((r) => h('option', { value: r.url }, `${r.fullName}${r.private ? ' (private)' : ''}`)));
      repoPick.replaceChildren(h('label', { class: 'field' }, h('span', {}, 'Your repositories'), sel));
    };
    if (C.me?.github.token) {
      if (C.repos) showRepos();
      else api('/api/github/repos').then((r) => { C.repos = r; showRepos(); }).catch(() => {});
    }

    const ghForm = h('form', { onsubmit: (e) => {
      e.preventDefault();
      busy(ghBtn, async () => {
        toast('Downloading and scanning the code…');
        const app = await post('/api/import/github', { url: url.value, ref: ref.value.trim() || undefined });
        await refresh(true);
        toast(`Imported ${app.name}`);
        go('app', app.slug);
      });
    } },
    repoPick,
    h('label', { class: 'field' }, h('span', {}, 'Repository link'), url),
    h('label', { class: 'field' }, h('span', {}, 'Branch ', h('span', { class: 'hint' }, '(optional, default branch if empty)')), ref),
    h('div', { class: 'row' }, ghBtn,
      C.me && !C.me.github.token ? h('span', { class: 'small' }, 'Public repos work as is. For private ones, sign in with GitHub or connect a GitHub token on Accounts.') : null));

    const file = h('input', { type: 'file', accept: '.zip,application/zip', 'aria-label': 'Zip of your app' });
    const label = h('span', {}, 'Choose a .zip of your app, or drop it here');
    const drop = h('label', { class: 'drop' }, icon('upload'), label, h('span', { class: 'small' }, `Up to ${C.me?.limits.uploadMb || 50} MB. Leave out node_modules and build output.`), file);
    const upload = (f) => {
      if (!f) return;
      if (!/\.zip$/i.test(f.name)) return toast('Choose a .zip file');
      label.textContent = f.name;
      busy(null, async () => {
        toast('Uploading and scanning…');
        const res = await fetch(`/api/import/zip?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: f });
        const body = await res.json().catch(() => ({}));
        if (res.status === 401) return (location.href = '/login');
        if (!res.ok) throw new Error(body.error || res.statusText);
        await refresh(true);
        toast(`Imported ${body.name}`);
        go('app', body.slug);
      });
    };
    file.onchange = () => upload(file.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files[0]); };

    return h('div', { class: 'cols' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, icon('github'), h('h2', {}, 'From GitHub')),
        h('div', { class: 'card-pad' }, ghForm)),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, icon('upload'), h('h2', {}, 'Upload a zip')),
        h('div', { class: 'card-pad' }, drop,
          h('p', { class: 'small' }, 'Claude hands back your changes as a patch and an updated zip.'))));
  }

  function addView() {
    return [
      h('div', { class: 'page-head' }, h('div', {},
        h('h1', {}, 'Add an app'),
        h('p', {}, 'Liftoff reads the code, works out the stack and platforms, and runs the App Store pre-scan and a leaked-key scan. Nothing runs until you start a run.'))),
      addForms(),
    ];
  }

  // ---------- accounts ----------

  function keyDialog(a) {
    const big = (f) => f === 'APP_STORE_CONNECT_KEY' || f.endsWith('_JSON');
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
    const dlg = h('dialog', { class: 'modal', 'aria-label': `Connect ${a.label}` });
    const form = h('form', { onsubmit: (e) => {
      e.preventDefault();
      const values = Object.fromEntries(a.fields.map((f) => [f, String(new FormData(form).get(f) || '')]));
      busy(save, async () => {
        state.accounts = await post(`/api/accounts/${a.id}`, { values });
        dlg.close();
        toast(`${a.label} connected`);
        await refresh(true);
      });
    } },
    h('h2', {}, `Connect ${a.label}`),
    h('p', { class: 'small' }, 'Stored encrypted on the server. Claude never sees the real value: its sandbox gets a placeholder that becomes the key only on the way to ', a.label, '.'),
    a.fields.map((f) => h('label', { class: 'field' }, h('span', {}, f),
      big(f) ? h('textarea', { name: f, class: 'in', required: true, spellcheck: 'false' })
        : h('input', { name: f, type: /ACCOUNT_ID|KEY_ID|ISSUER_ID/.test(f) ? 'text' : 'password', autocomplete: 'off', spellcheck: 'false', required: true }))),
    a.url ? h('p', { class: 'small' }, h('a', { href: a.url, target: '_blank', rel: 'noopener' }, `Get a key from ${a.label}`, ' ', icon('external'))) : null,
    h('div', { class: 'acts' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => dlg.close() }, 'Cancel'), save));
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  function accountAction(a) {
    if (a.connected) {
      return h('span', { class: 'row' },
        h('span', { class: 'pill good' }, icon('check'), 'Connected'),
        h('button', { class: 'btn quiet', title: `Disconnect ${a.label}`, onclick: (e) => busy(e.currentTarget, async () => {
          if (!confirm(`Disconnect ${a.label}? Its key is deleted from Liftoff Cloud.`)) return;
          await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
          await refresh(true);
        }) }, 'Disconnect'));
    }
    return h('button', { class: 'btn', onclick: () => keyDialog(a) }, icon('key'), 'Connect');
  }

  // ---------- one app ----------

  function sourceLine(app) {
    const s = app.cloud?.source || {};
    if (s.type === 'github') {
      return h('span', {}, icon('github'), h('a', { href: s.url, target: '_blank', rel: 'noopener', class: 'path' }, `${s.fullName}`), h('span', { class: 'small' }, `@${s.ref}`));
    }
    return h('span', {}, icon('folder'), h('span', { class: 'path' }, s.filename || 'uploaded code'));
  }

  function runCard(app) {
    const r = app.cloud?.run;
    if (!r || !OPEN.has(r.status)) return null;
    const needs = r.status === 'needs-you' || r.status === 'budget';
    return h('section', { class: 'card next' + (needs ? ' needs' : '') },
      h('span', { class: 'tile' }, icon(needs ? 'flag' : 'sparkle')),
      h('div', { class: 'grow' },
        h('div', { class: 'small' }, 'Claude run'),
        h('h2', {}, r.status === 'needs-you' ? `Claude needs you (${r.pending})` : r.status === 'budget' ? 'Paused at its budget' : 'Claude is working on this app'),
        h('p', {}, `Started ${ago(r.createdAt)}${r.cost === null ? '' : ` · ${usd(r.cost)} so far`}`)),
      h('div', { class: 'acts' }, h('button', { class: 'btn primary', onclick: () => openRun(app.slug, r.id) }, 'Open run', icon('arrow'))));
  }

  function scanCard(app) {
    const scan = app.cloud?.scan;
    if (!scan || !scan.failing.length) return null;
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Found in your code'), h('span', { class: 'count' }, scan.failing.length), h('span', { class: 'end sub' }, `Scanned ${ago(scan.at)}`)),
      h('div', { class: 'card-body' }, h('ul', { class: 'list-tight findings' }, scan.failing.map((f) => {
        const item = app.checklist.find((c) => c.id === f.id);
        return h('li', {}, h('b', {}, item ? item.title : f.id), h('div', { class: 'small' }, f.detail));
      }))));
  }

  function settingsCard(app) {
    const keys = C.me?.settings || {};
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Settings'), h('span', { class: 'end sub' }, 'Verify and Pulse read these')),
      h('div', { class: 'card-body' }, Object.entries(keys).map(([k, d]) => {
        const input = h('input', { class: 'in', type: 'text', value: app.config[k] || '', 'aria-label': k, placeholder: k === 'health.path' ? '/api/health' : '' });
        const save = () => {
          if ((app.config[k] || '') === input.value.trim()) return;
          busy(null, async () => {
            await post(`/api/apps/${app.slug}/settings`, { key: k, value: input.value });
            toast(`Saved ${k}`);
            await refresh(true);
          });
        };
        input.onchange = save;
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };
        return h('div', { class: 'set' }, h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'd' }, d)), input);
      }),
      h('div', { class: 'row', style: { paddingTop: '12px', borderTop: '1px solid var(--line-2)' } },
        h('span', { class: 'small grow' }, 'Removing deletes the imported code, records and run history from Liftoff Cloud. Nothing changes in your repo or services.'),
        h('button', { class: 'btn danger', onclick: (e) => busy(e.currentTarget, async () => {
          if (!confirm(`Remove ${app.name} from Liftoff Cloud?`)) return;
          await api(`/api/apps/${app.slug}`, { method: 'DELETE' });
          await refresh(true);
          go('overview');
        }) }, icon('trash'), 'Remove app'))));
  }

  // ---------- runs ----------

  async function openRun(slug, runId = null) {
    C.slug = slug;
    C.run = null;
    C.runs = null;
    C.pick = {};
    C.stick = true;
    C.feedTop = null;
    C.runId = runId;
    C.loading = true;
    go('run');
    await loadRun(true);
    C.loading = false;
    render();
  }

  async function loadRun(full) {
    if (!C.slug) return;
    try {
      if (full || !C.runs) {
        C.runs = await api(`/api/apps/${C.slug}/runs`);
        if (!C.runId) {
          const open = C.runs.find((r) => OPEN.has(r.status));
          C.runId = open?.id || null;
        }
      }
      if (!C.runId) {
        C.run = null;
        return;
      }
      const after = !full && C.run?.id === C.runId ? C.run.seq : 0;
      const r = await api(`/api/apps/${C.slug}/runs/${C.runId}?after=${after}`);
      if (after && C.run) {
        const events = C.run.events.concat(r.events.filter((e) => e.n > after));
        C.run = { ...r, events: events.slice(-600) };
      } else C.run = r;
      remember();
    } catch (e) {
      if (/No such/.test(e.message)) { C.runId = null; C.run = null; }
    }
  }

  function stepPicker(app) {
    const steps = app.steps;
    if (!Object.keys(C.pick).length) for (const s of steps) C.pick[s.id] = !['done', 'skipped'].includes(s.status);
    const chosen = steps.filter((s) => C.pick[s.id]);
    const missing = app.accounts.filter((a) => !a.connected);
    const note = h('textarea', { class: 'in', oninput: (e) => { C.note = e.target.value; }, placeholder: 'Anything Claude should know? e.g. "Use Cloudflare, not Vercel" or "Price Pro at $8/month"', 'aria-label': 'Note for Claude', maxlength: '1000' });
    const start = h('button', { class: 'btn primary big', type: 'button', disabled: !C.me?.claude.ok || !chosen.length }, icon('sparkle'), chosen.length === steps.filter((s) => !['done', 'skipped'].includes(s.status)).length ? 'Start the launch' : `Run ${chosen.length} step${chosen.length === 1 ? '' : 's'}`);
    start.onclick = () => busy(start, async () => {
      await startRun(app.slug, { steps: chosen.map((s) => s.id), note: note.value, model: picked });
      C.note = '';
    });
    note.value = C.note || '';
    const picked = models().some((m) => m.id === C.model) ? C.model : C.me?.models?.default;
    const modelField = models().length > 1 ? h('div', { class: 'field' }, h('span', {}, 'Model'),
      h('div', { class: 'picker', role: 'radiogroup', 'aria-label': 'Model' }, models().map((m) => h('label', { class: 'pick' },
        h('input', { type: 'radio', name: 'run-model', value: m.id, checked: m.id === picked, onchange: () => { C.model = m.id; render(); } }),
        h('span', { class: 't' }, h('b', {}, m.label, m.id === C.me.models.default ? h('span', { class: 'hint' }, ' (default)') : null), h('span', { class: 'small' }, m.hint)))))) : null;
    const mode = app.cloud?.source?.type === 'github' && C.me?.github.token ? 'github' : 'upload';
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Start a run'), h('span', { class: 'end sub' }, `Budget ${usd(C.me?.limits.runBudgetUsd)} per run`)),
      h('div', { class: 'card-pad' },
        !C.me?.claude.ok ? h('div', { class: 'note-box bad' }, icon('x'), h('span', {}, C.me?.claude.why || 'Cloud runs are not set up on this server.')) : null,
        h('p', { style: { margin: '0 0 4px' } }, 'Claude works in a private cloud sandbox with a copy of your code, following the same skills as the Claude Code plugin. It asks you here before anything that spends money, changes DNS or goes live.'),
        h('ul', { class: 'list-tight small' },
          h('li', {}, mode === 'github' ? `Changes go on a new branch with a draft pull request on ${app.cloud.source.fullName}.` : 'Changes come back as a patch and an updated zip to download.'),
          h('li', {}, 'Connected accounts are used through placeholders. Real keys stay on the server.')),
        missing.length ? h('div', { class: 'note-box warn', style: { marginTop: '10px' } }, icon('key'),
          h('span', {}, `Not connected yet: ${missing.map((a) => a.label).join(', ')}. Steps that need them are marked blocked with a task for you. `,
            h('a', { href: '#accounts', onclick: (e) => { e.preventDefault(); go('accounts'); } }, 'Connect accounts'))) : null,
        h('div', { class: 'picker' }, steps.map((s) => {
          const done = ['done', 'skipped'].includes(s.status);
          return h('label', { class: 'pick' + (done && !C.pick[s.id] ? ' off' : '') },
            h('input', { type: 'checkbox', checked: !!C.pick[s.id], onchange: (e) => { C.pick[s.id] = e.target.checked; render(); } }),
            h('span', { class: 't' }, h('b', {}, s.label), h('span', { class: 'small' }, done ? MC.STEP_WORD[s.status] : s.waitingOn?.length ? `Waits on ${s.waitingOn.map((id) => steps.find((x) => x.id === id)?.label || id).join(', ')}` : s.note || 'Not started')));
        })),
        modelField,
        h('label', { class: 'field' }, h('span', {}, 'Note for Claude ', h('span', { class: 'hint' }, '(optional)')), note),
        h('div', { class: 'row' }, start, h('button', { class: 'btn quiet', type: 'button', onclick: () => { for (const s of steps) C.pick[s.id] = false; render(); } }, 'Clear'))));
  }

  async function startRun(slug, body) {
    const run = await post(`/api/apps/${slug}/runs`, body);
    C.runId = run.id;
    C.run = run;
    C.runs = null;
    remember();
    await refresh(true);
  }

  function pendingCard(run) {
    if (!run.pending.length) return null;
    return h('section', { class: 'card needs' },
      h('div', { class: 'card-head' }, icon('flag'), h('h2', {}, 'Claude needs you'), h('span', { class: 'count' }, run.pending.length)),
      run.pending.map((p) => {
        if (p.kind === 'question') {
          const input = h('input', { class: 'in grow', type: 'text', placeholder: 'Type an answer…', 'aria-label': 'Your answer' });
          const send = (text, btn) => busy(btn, async () => {
            C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/answer`, { eventId: p.id, text });
            render();
          });
          const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('send'), 'Send');
          return h('div', { class: 'ask' },
            h('div', { class: 'q' }, p.text),
            p.options?.length ? h('div', { class: 'row' }, p.options.map((o) => h('button', { class: 'btn', type: 'button', onclick: (e) => send(o, e.currentTarget) }, o))) : null,
            h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) send(input.value, sendBtn); } }, input, sendBtn));
        }
        const reason = h('input', { class: 'in grow', type: 'text', placeholder: 'Why not? (optional, shown to Claude)', 'aria-label': 'Reason' });
        const decide = (allow, btn) => busy(btn, async () => {
          C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/approve`, { eventId: p.id, allow, reason: allow ? '' : reason.value });
          render();
        });
        return h('div', { class: 'ask' },
          h('div', { class: 'small' }, p.kind === 'secret' ? 'Copy a key to GitHub' : `Claude asks before using ${p.tool}`),
          h('div', { class: 'q' }, p.text),
          p.detail && p.kind === 'approval' ? h('pre', { class: 'out' }, p.detail) : null,
          h('div', { class: 'row' },
            h('button', { class: 'btn good', onclick: (e) => decide(true, e.currentTarget) }, icon('check'), 'Allow'),
            reason,
            h('button', { class: 'btn', onclick: (e) => decide(false, e.currentTarget) }, 'Decline')));
      }));
  }

  function feedItem(e) {
    const time = h('time', { datetime: e.at, title: new Date(e.at).toLocaleString() }, ago(e.at));
    switch (e.kind) {
      case 'message': return h('div', { class: 'fe msg' }, icon('sparkle'), h('div', { class: 'body' }, e.text));
      case 'you': return h('div', { class: 'fe you' }, h('div', { class: 'body' }, e.text));
      case 'question': return h('div', { class: 'fe question' }, icon('flag'), h('div', { class: 'body' }, h('div', { class: 'small' }, 'Claude asked'), e.text), time);
      case 'status': return h('div', { class: 'fe status' }, h('div', { class: 'body' }, e.text, ' · ', time));
      case 'note': return h('div', { class: 'fe status' }, h('div', { class: 'body' }, e.text));
      case 'error': return h('div', { class: 'fe err' }, icon('x'), h('div', { class: 'body' }, e.text), time);
      case 'kickoff': return h('div', { class: 'fe kick' }, icon('rocket'), h('details', { class: 'body' }, h('summary', {}, e.text), h('pre', { class: 'out' }, e.detail || '')), time);
      case 'liftoff': return h('div', { class: 'fe liftoff' + (e.isError ? ' err' : '') }, icon('rocket'), h('div', { class: 'body' }, e.text, e.isError && e.out ? h('div', { class: 'small err' }, e.out) : null), time);
      default: {
        const body = e.out
          ? h('details', {}, h('summary', {}, e.text || e.tool, e.isError ? h('span', { class: 'err' }, ' · failed') : null), h('pre', { class: 'out' }, e.out))
          : h('div', {}, e.text || e.tool);
        return h('div', { class: 'fe tool' }, icon('terminal'), h('div', { class: 'body' }, body), time);
      }
    }
  }

  function runView() {
    const app = appOf(C.slug);
    if (!app) return h('div', { class: 'card empty' }, h('h2', {}, 'Pick an app'), h('p', {}, 'Open an app and choose Run with Claude.'));
    const run = C.run;
    const head = h('div', { class: 'page-head' }, h('div', { style: { minWidth: 0, flex: 1 } },
      h('div', { class: 'run-head' }, MC.avatar(app, true), h('h1', {}, app.name), run ? runPill(run.status) : null,
        h('span', { class: 'end' },
          run && LIVE.has(run.status) ? h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/stop`); render(); }) }, icon('stop'), 'Stop') : null,
          run && !OPEN.has(run.status) && run.model !== STRONGEST && models().some((m) => m.id === STRONGEST) && C.me?.claude.ok
            ? h('button', { class: 'btn', title: 'Start a new run for the same steps on Claude Opus 5.5', onclick: (e) => busy(e.currentTarget, () => startRun(C.slug, { steps: run.steps, note: run.note || '', model: STRONGEST })) }, icon('sparkle'), 'Try again with Opus') : null,
          run && !OPEN.has(run.status) ? h('button', { class: 'btn', onclick: () => { C.runId = null; C.run = null; C.pick = {}; remember(); render(); } }, icon('plus'), 'New run') : null,
          h('button', { class: 'btn quiet', onclick: () => go('app', app.slug) }, 'Mission Control', icon('arrow')))),
      run ? h('div', { class: 'run-meta', style: { marginTop: '8px' } },
        h('span', {}, `Started ${ago(run.createdAt)}`),
        run.model ? h('span', {}, modelLabel(run.model)) : null,
        h('span', {}, run.cost === null ? `Budget ${usd(run.budgetUsd)}` : `${usd(run.cost)} of ${usd(run.budgetUsd)} budget`),
        run.steps.length ? h('span', {}, run.steps.map((id) => app.steps.find((s) => s.id === id)?.label || id).join(', ')) : h('span', {}, 'All remaining steps'),
        run.pr ? h('a', { href: run.pr.url, target: '_blank', rel: 'noopener' }, icon('pr'), `Pull request #${run.pr.number}`) : null) : null));

    if (C.loading) return [head, h('div', { class: 'card empty' }, 'Loading…')];
    if (!run) return [head, stepPicker(app), historyCard(app)];

    const feed = h('div', { class: 'feed', role: 'log', 'aria-live': 'polite', 'aria-label': 'What Claude is doing' },
      run.events.map(feedItem),
      LIVE.has(run.status) && run.status !== 'needs-you' ? h('div', { class: 'typing' }, h('i'), h('i'), h('i'), h('span', {}, run.status === 'starting' ? 'Setting up the sandbox' : 'Claude is working')) : null);
    feed.addEventListener('scroll', () => {
      C.feedTop = feed.scrollTop;
      C.stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    });

    const text = h('textarea', { class: 'in', oninput: (e) => { C.draft = e.target.value; }, placeholder: run.status === 'needs-you' ? 'Answer Claude above first' : 'Message Claude…', 'aria-label': 'Message Claude', disabled: run.status === 'needs-you' || run.status === 'budget' || run.status === 'starting' });
    text.value = C.draft || '';
    const sendBtn = h('button', { class: 'btn primary', type: 'submit', disabled: text.disabled }, icon('send'), 'Send');
    const composer = h('form', { class: 'composer', onsubmit: (e) => {
      e.preventDefault();
      if (!text.value.trim()) return;
      busy(sendBtn, async () => {
        C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/message`, { text: text.value });
        C.draft = '';
        C.stick = true;
        render();
      });
    } }, text, sendBtn);
    text.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) composer.requestSubmit(); };

    return [
      head,
      run.error ? h('div', { class: 'note-box bad' }, icon('x'), h('span', {}, run.error)) : null,
      run.status === 'budget' ? h('div', { class: 'note-box warn' }, icon('flag'), h('span', { style: { flex: 1 } }, `This run reached its ${usd(run.budgetUsd)} budget and paused.`),
        h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/budget`, { addUsd: 10 }); render(); }) }, 'Add $10 and continue')) : null,
      pendingCard(run),
      run.outputs?.length ? h('section', { class: 'card' }, h('div', { class: 'card-head' }, icon('download'), h('h2', {}, 'Your updated code')),
        h('div', { class: 'card-body rows' }, run.outputs.map((f) => h('div', { class: 'line' },
          h('span', { class: 'tile' }, icon('download')), h('div', { class: 'grow' }, h('div', { class: 'name' }, f.filename), h('div', { class: 'small' }, f.size ? `${Math.round(f.size / 1024)} KB` : '')),
          h('a', { class: 'btn', href: `/api/apps/${C.slug}/runs/${run.id}/outputs/${encodeURIComponent(f.id)}` }, 'Download'))))) : null,
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Activity'), h('span', { class: 'end sub' }, 'Live')), feed, composer),
      historyCard(app),
    ];
  }

  function historyCard(app) {
    const past = (C.runs || []).filter((r) => r.id !== C.run?.id);
    if (!past.length) return null;
    return h('section', { class: 'card history' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Earlier runs'), h('span', { class: 'count' }, past.length)),
      h('div', { class: 'card-body rows' }, past.slice(0, 10).map((r) => h('div', { class: 'line', role: 'button', tabindex: '0', onclick: () => openRun(app.slug, r.id), onkeydown: (e) => { if (e.key === 'Enter') openRun(app.slug, r.id); } },
        h('div', { class: 'grow' }, h('div', { class: 'name' }, r.steps.length ? r.steps.map((id) => app.steps.find((s) => s.id === id)?.label || id).join(', ') : 'All remaining steps'),
          h('div', { class: 'small' }, `${ago(r.createdAt)} · ${usd(r.cost)}`)),
        r.pr ? h('span', { class: 'pill sm' }, `PR #${r.pr.number}`) : null,
        runPill(r.status, true)))));
  }

  // ---------- hooks ----------

  MC.configure({
    brand: 'Liftoff Cloud',
    unauthorized: () => { location.href = '/login'; },
    pollMs: () => (state.view === 'run' && C.run && LIVE.has(C.run.status) ? 2000 : 4000),
    load: async () => {
      const me = api('/api/me').then((m) => { if (m) C.me = m; });
      const run = state.view === 'run' ? loadRun(false) : null;
      await Promise.all([me, run]);
      return true;
    },
    views: {
      add: { title: 'Add an app', render: addView },
      run: { get title() { const a = appOf(C.slug); return a ? `${a.name} · Claude run` : 'Claude run'; }, render: runView },
    },
    navExtra: () => h('button', { class: 'nav' + (state.view === 'add' ? ' on' : ''), onclick: () => go('add') }, icon('plus'), 'Add an app'),
    sideFoot: () => C.me ? h('div', { class: 'who' },
      C.me.user.avatar ? h('img', { src: C.me.user.avatar, alt: '' }) : h('span', { class: 'ph' }),
      h('span', { class: 'nm' }, C.me.user.login),
      h('form', { method: 'post', action: '/auth/logout' }, h('button', { class: 'btn quiet', type: 'submit', title: 'Sign out' }, 'Sign out'))) : null,
    appBadge: (a) => {
      const r = a.cloud?.run;
      if (!r) return null;
      if (r.status === 'needs-you') return h('span', { class: 'pill warn sm', title: 'Claude needs you' }, '!');
      if (r.status === 'running' || r.status === 'starting') return h('span', { class: 'status-dot run', title: 'Claude is working' });
      return null;
    },
    emptyOverview: () => [
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Welcome to Liftoff Cloud'),
        h('p', {}, 'Add your app to see what stands between it and real users. Then let Claude set it up, step by step, in the cloud.'))),
      addForms(),
    ],
    overviewIntro: (apps) => `${MC.plural(apps.length, 'app')} in Liftoff Cloud. Here is what needs you first.`,
    overviewActions: () => h('button', { class: 'btn primary', onclick: () => go('add') }, icon('plus'), 'Add an app'),
    accountAction,
    accountsIntro: () => 'Connected once and reused by every app. Keys are encrypted on the server, and Claude’s sandbox only sees placeholders that turn into the real key on the way to that service.',
    heroMeta: sourceLine,
    heroActions: (app) => [
      h('button', { class: 'btn', title: 'Fetch the code again and rescan it', onclick: (e) => busy(e.currentTarget, async () => { toast('Rescanning…'); await post(`/api/apps/${app.slug}/rescan`); await refresh(true); toast('Rescanned'); }) }, icon('refresh'), 'Rescan'),
      h('button', { class: 'btn primary', onclick: () => openRun(app.slug, app.cloud?.run && OPEN.has(app.cloud.run.status) ? app.cloud.run.id : null) }, icon('sparkle'), app.cloud?.run && OPEN.has(app.cloud.run.status) ? 'Open run' : 'Run with Claude'),
    ],
    afterHero: (app) => [runCard(app), scanCard(app)],
    nextActionButton: (app, a) => (a.skill || a.command ? h('button', { class: 'btn', onclick: () => {
      const ids = app.steps.filter((s) => s.skill === a.skill && !['done', 'skipped'].includes(s.status)).map((s) => s.id);
      openRun(app.slug).then(() => { if (ids.length && !C.run) { C.pick = Object.fromEntries(app.steps.map((s) => [s.id, ids.includes(s.id)])); render(); } });
    } }, icon('sparkle'), 'Do it with Claude') : null),
    stepsHeadEnd: (app) => h('button', { class: 'btn', onclick: () => openRun(app.slug) }, icon('sparkle'), 'Run with Claude'),
    mainBottom: settingsCard,
    afterRender: () => {
      const feed = document.querySelector('.feed');
      if (!feed) return;
      if (C.stick || C.feedTop === null) feed.scrollTop = feed.scrollHeight;
      else feed.scrollTop = C.feedTop;
    },
  });

  MC.start();
})();
