// Liftoff Cloud screens on top of the shared Flight Board front end
// (board.js): adding apps, connecting accounts, account settings, and runs
// where Claude does the launch steps in the cloud. A run reads like a messages thread: Claude's
// bubbles on the left, yours on the right, tool work folded into one line, and
// Claude's questions and approvals as cards right where it asked.
//
// Board patches the page in place on every refresh, so handlers read values
// from the event (e.currentTarget, form elements) or from C, never from an
// element captured when the view was built.
(() => {
  const Board = window.Board;
  const { h, icon, api, go, render, repaint, refresh, toast, state, ago } = Board;

  Object.assign(Board.ICONS, {
    terminal: '<path d="m5 7 5 5-5 5M12 19h7"/>',
    upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
    github: '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>',
    send: '<path d="m4 12 16-8-6 16-2-7z"/>',
    arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z"/>',
    download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
    pr: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="m10 17 5-5-5-5M15 12H4"/>',
    devices: '<rect x="2" y="5" width="14" height="10" rx="1.5"/><path d="M6 19h6M9 15v4"/><rect x="17" y="9" width="5" height="10" rx="1.2"/>',
  });

  const LIVE = new Set(['starting', 'running', 'needs-you']);
  const OPEN = new Set([...LIVE, 'budget']);
  const RUN_WORD = { starting: 'Starting', running: 'Working', 'needs-you': 'Needs you', finished: 'Finished', stopped: 'Stopped', budget: 'Paused at budget', failed: 'Failed' };
  const RUN_TONE = { starting: 'run', running: 'run', 'needs-you': 'warn', finished: 'good', stopped: '', budget: 'warn', failed: 'bad' };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Cloud-only state.
  const C = { me: null, slug: null, run: null, runs: null, pick: {}, stick: true, busy: false, repos: null, note: '', draft: '', loading: false, model: null, open: {}, sent: null, zipName: '', autoScroll: 0 };
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
  const stepLabel = (app, id) => app?.steps.find((s) => s.id === id)?.label || id;
  const runPill = (status, sm) => h('span', { class: `pill ${RUN_TONE[status] || ''}${sm ? ' sm' : ''}` }, status === 'running' || status === 'starting' ? h('span', { class: 'd' }) : null, RUN_WORD[status] || status);
  const usd = (n) => (n === null || n === undefined ? '–' : `$${Number(n).toFixed(2)}`);
  const clock = (iso) => {
    const d = new Date(iso);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? `Today ${t}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
  };

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

  // Claude's avatar: a plain disc with its initial, ringed while it works.
  const orb = (status, lg) => h('span', {
    class: 'orb' + (lg ? ' lg' : '') + (status === 'running' || status === 'starting' ? ' thinking' : status === 'needs-you' ? ' waiting' : ''),
    'aria-hidden': 'true',
  }, 'C');

  // Claude writes light Markdown: paragraphs, lists, `code`, **bold** and links.
  // Built as DOM nodes, never as HTML.
  function inline(text) {
    const out = [];
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1]) out.push(h('code', {}, m[1].slice(1, -1)));
      else if (m[2]) out.push(h('strong', {}, m[2].slice(2, -2)));
      else out.push(h('a', { href: m[3], target: '_blank', rel: 'noopener noreferrer' }, m[3]));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function rich(text) {
    const out = [];
    for (const block of String(text || '').replace(/\r/g, '').split(/\n{2,}/)) {
      let para = [];
      let list = null;
      const endPara = () => {
        if (para.length) out.push(h('p', {}, para.map((l, i) => [i ? h('br') : null, inline(l)])));
        para = [];
      };
      const endList = () => {
        if (list) out.push(list);
        list = null;
      };
      for (const line of block.split('\n')) {
        const m = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
        if (m) {
          endPara();
          const ordered = /\d/.test(m[1]);
          if (!list || (list.tagName === 'OL') !== ordered) {
            endList();
            list = h(ordered ? 'ol' : 'ul');
          }
          list.append(h('li', {}, inline(m[2])));
        } else {
          endList();
          if (line.trim()) para.push(line.replace(/^#{1,4}\s+/, ''));
        }
      }
      endPara();
      endList();
    }
    return out;
  }

  // ---------- adding an app ----------

  function addForms() {
    const signedIn = !!C.me?.github.token;
    if (signedIn && !C.repos && !C.reposLoading) {
      C.reposLoading = true;
      api('/api/github/repos').then((r) => { C.repos = r || []; repaint(); }).catch(() => {}).finally(() => { C.reposLoading = false; });
    }
    const repoPick = signedIn && C.repos
      ? (C.repos.length
        ? h('label', { class: 'field' }, h('span', {}, 'Your repositories'),
          h('select', { class: 'in', 'aria-label': 'Your repositories', onchange: (e) => { e.currentTarget.form.elements.url.value = e.currentTarget.value; } },
            h('option', { value: '' }, 'Pick one of your repositories…'),
            C.repos.map((r) => h('option', { value: r.url }, `${r.fullName}${r.private ? ' (private)' : ''}`))))
        : h('div', { class: 'small' }, 'No repositories found on your GitHub account.'))
      : null;

    const ghForm = h('form', { onsubmit: (e) => {
      e.preventDefault();
      const f = e.currentTarget.elements;
      busy(e.submitter, async () => {
        toast('Downloading and scanning the code…');
        const app = await post('/api/import/github', { url: f.url.value, ref: f.ref.value.trim() || undefined });
        await refresh(true);
        toast(`Imported ${app.name}`);
        go('app', app.slug);
      });
    } },
    repoPick,
    h('label', { class: 'field' }, h('span', {}, 'Repository link'), h('input', { class: 'in', name: 'url', type: 'url', placeholder: 'https://github.com/you/your-app', 'aria-label': 'GitHub repository link', required: true })),
    h('label', { class: 'field' }, h('span', {}, 'Branch ', h('span', { class: 'hint' }, '(optional, default branch if empty)')), h('input', { class: 'in', name: 'ref', type: 'text', placeholder: 'main', 'aria-label': 'Branch (optional)' })),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, icon('github'), 'Import'),
      C.me && !signedIn ? h('span', { class: 'small' }, 'Public repos work as is. For private ones, sign in with GitHub or connect a GitHub token on Accounts.') : null));

    const upload = (f) => {
      if (!f) return;
      if (!/\.zip$/i.test(f.name)) return toast('Choose a .zip file');
      C.zipName = f.name;
      repaint();
      busy(null, async () => {
        toast('Uploading and scanning…');
        const res = await fetch(`/api/import/zip?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: f });
        const body = await res.json().catch(() => ({}));
        if (res.status === 401) return (location.href = '/login');
        if (!res.ok) throw new Error(body.error || res.statusText);
        C.zipName = '';
        await refresh(true);
        toast(`Imported ${body.name}`);
        go('app', body.slug);
      });
    };
    const drop = h('label', {
      class: 'drop',
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); upload(e.dataTransfer.files[0]); },
    },
    h('span', { class: 'drop-icon' }, icon('upload')),
    h('span', { class: 'drop-title' }, C.zipName || 'Choose a .zip of your app, or drop it here'),
    h('span', { class: 'small' }, `Up to ${C.me?.limits.uploadMb || 50} MB. Leave out node_modules and build output.`),
    h('input', { type: 'file', accept: '.zip,application/zip', 'aria-label': 'Zip of your app', onchange: (e) => upload(e.currentTarget.files[0]) }));

    return h('div', { class: 'cols add-cols' },
      h('section', { class: 'card spot' },
        h('div', { class: 'card-head' }, h('span', { class: 'head-tile' }, icon('github')), h('h2', {}, 'From GitHub')),
        h('div', { class: 'card-pad' }, ghForm)),
      h('section', { class: 'card spot' },
        h('div', { class: 'card-head' }, h('span', { class: 'head-tile' }, icon('upload')), h('h2', {}, 'Upload a zip')),
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
    const dlg = h('dialog', { class: 'modal', 'aria-label': `Connect ${a.label}` });
    const form = h('form', { onsubmit: (e) => {
      e.preventDefault();
      const values = Object.fromEntries(a.fields.map((f) => [f, String(new FormData(e.currentTarget).get(f) || '')]));
      busy(e.submitter, async () => {
        state.accounts = await post(`/api/accounts/${a.id}`, { values });
        dlg.close();
        toast(`${a.label} connected`);
        await refresh(true);
      });
    } },
    h('div', { class: 'modal-head' }, h('span', { class: 'head-tile' }, icon('key')), h('div', {}, h('h2', {}, `Connect ${a.label}`),
      h('p', { class: 'small' }, 'Stored encrypted on the server. Claude never sees the real value: its sandbox gets a placeholder that becomes the key only on the way to ', a.label, '.'))),
    a.fields.map((f) => h('label', { class: 'field' }, h('span', {}, f),
      big(f) ? h('textarea', { name: f, class: 'in', required: true, spellcheck: 'false' })
        : h('input', { name: f, type: /ACCOUNT_ID|KEY_ID|ISSUER_ID/.test(f) ? 'text' : 'password', autocomplete: 'off', spellcheck: 'false', required: true }))),
    a.url ? h('p', { class: 'small' }, h('a', { href: a.url, target: '_blank', rel: 'noopener' }, `Get a key from ${a.label}`, ' ', icon('external'))) : null,
    h('div', { class: 'acts' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
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

  // ---------- account settings ----------

  const THEMES = [
    { id: 'system', label: 'Match device', icon: 'monitor' },
    { id: 'light', label: 'Light', icon: 'sun' },
    { id: 'dark', label: 'Dark', icon: 'moon' },
  ];
  const longDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : '');
  const meAvatar = (u, cls = '') => (u.avatar ? h('img', { class: `pic ${cls}`, src: u.avatar, alt: '' }) : h('span', { class: `pic ph ${cls}`, 'aria-hidden': 'true' }, (u.login || '?')[0].toUpperCase()));
  const hasOpenRun = () => state.apps.some((a) => a.cloud?.run && OPEN.has(a.cloud.run.status));

  async function savePrefs(change, done) {
    try {
      const r = await post('/api/me/prefs', change);
      if (C.me) Object.assign(C.me, { prefs: r.prefs, models: r.models });
      if (done) toast(done);
    } catch (e) {
      toast(e.message);
    }
    repaint();
  }

  // A small drawing of the app in that theme.
  function themePreview(kind) {
    const one = (k) => h('span', { class: `prev ${k}` },
      h('span', { class: 'prev-side' }, h('span', { class: 'prev-mark' }), h('span', { class: 'prev-line' }), h('span', { class: 'prev-line short' }), h('span', { class: 'prev-line' })),
      h('span', { class: 'prev-main' }, h('span', { class: 'prev-title' }), h('span', { class: 'prev-card' }), h('span', { class: 'prev-card' }, h('span', { class: 'prev-btn' }))));
    return kind === 'system' ? h('span', { class: 'prev-split' }, one('light'), one('dark')) : one(kind);
  }

  function appearanceCard() {
    const now = window.LiftoffTheme?.get() || 'system';
    return h('section', { class: 'card narrow' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Appearance'), h('span', { class: 'end sub' }, 'Saved to your account')),
      h('div', { class: 'card-body' },
        h('div', { class: 'theme-opts', role: 'radiogroup', 'aria-label': 'Theme' }, THEMES.map((t) => h('label', { class: 'theme-opt spot' + (now === t.id ? ' on' : ''), key: t.id },
          h('input', { type: 'radio', name: 'theme', value: t.id, checked: now === t.id, onchange: () => Board.setTheme(t.id) }),
          themePreview(t.id),
          h('span', { class: 'cap' }, icon(t.icon), h('span', {}, t.label), h('span', { class: 'tick', 'aria-hidden': 'true' }))))),
        h('p', { class: 'small tip' }, now === 'system'
          ? 'Follows your phone or computer: light by day, dark if your device is set to dark.'
          : 'The sun and moon button at the top of each page switches it too.')));
  }

  function profileCard(me) {
    const u = me.user;
    const github = u.via === 'github';
    return h('section', { class: 'card narrow profile' },
      meAvatar(u, 'lg'),
      h('div', { class: 'grow' },
        h('h2', {}, u.name || u.login),
        h('div', { class: 'meta' },
          h('span', {}, `@${u.login}`),
          h('span', { class: 'pill sm' }, github ? [icon('github'), 'GitHub sign-in'] : [icon('terminal'), 'Signed in on this machine']),
          u.createdAt ? h('span', {}, `Joined ${longDate(u.createdAt)}`) : null,
          h('span', {}, Board.plural(state.apps.length, 'app'))),
        h('p', { class: 'small' }, github ? 'Your name and picture come from GitHub and update each time you sign in.' : 'This is the local developer account, for running Liftoff Cloud on your own machine.')),
      github ? h('a', { class: 'btn quiet', href: `https://github.com/${encodeURIComponent(u.login)}`, target: '_blank', rel: 'noopener' }, 'GitHub profile', icon('external')) : null);
  }

  function runsCard(me) {
    const choice = me.models.default;
    return h('section', { class: 'card narrow' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Claude runs')),
      h('div', { class: 'card-body' },
        models().length ? [
          h('div', { class: 'sec-head' }, h('span', { class: 'sec-title' }, 'Default model')),
          h('div', { class: 'picker models', role: 'radiogroup', 'aria-label': 'Default model' }, models().map((m) => h('label', { class: 'pick spot' + (m.id === choice ? ' on' : ''), key: m.id },
            h('input', { type: 'radio', name: 'default-model', value: m.id, checked: m.id === choice, onchange: () => { C.model = null; savePrefs({ model: m.id }, `New runs start on ${m.label}`); } }),
            h('span', { class: 't' }, h('b', {}, m.label), h('span', { class: 'small' }, m.hint))))),
          h('p', { class: 'small' }, 'New runs start on this model. You can still pick the other one when you start a run.'),
        ] : null,
        h('dl', { class: 'kv' },
          h('div', {}, h('dt', {}, 'Budget per run'), h('dd', {}, usd(me.limits.runBudgetUsd))),
          h('div', {}, h('dt', {}, 'Runs at once'), h('dd', {}, `Up to ${me.limits.maxRuns}`)),
          h('div', {}, h('dt', {}, 'Cloud runs on this server'), h('dd', {}, me.claude.ok ? h('span', { class: 'pill good sm' }, 'Ready') : h('span', { class: 'small', title: me.claude.why }, 'Not set up yet'))))));
  }

  function connectionsCard(me) {
    const connected = state.accounts.filter((a) => a.connected);
    const gh = me.github;
    const canPr = gh.signedIn && /\brepo\b/.test(gh.scope || '');
    return h('section', { class: 'card narrow' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Connections')),
      h('div', { class: 'card-body rows' },
        h('div', { class: 'line' },
          h('span', { class: 'tile' }, icon('github')),
          h('div', { class: 'grow' }, h('div', { class: 'name' }, 'GitHub'),
            h('div', { class: 'small' }, gh.signedIn ? `Signed in as @${me.user.login}. ${canPr ? 'Liftoff can import your repos, private ones too, and open pull requests.' : 'Liftoff can read your public repos.'}`
              : gh.token ? 'Using the GitHub token you added under Accounts.' : 'Not connected. Public repos still import; add a GitHub token under Accounts for private ones.')),
          gh.signedIn ? h('a', { class: 'btn quiet', href: 'https://github.com/settings/applications', target: '_blank', rel: 'noopener', title: 'See or take back the access you gave Liftoff Cloud' }, 'Manage on GitHub', icon('external'))
            : h('span', { class: 'pill sm' + (gh.token ? ' good' : '') }, gh.token ? 'Token' : 'Not connected')),
        h('div', { class: 'line' },
          h('span', { class: 'tile' }, icon('key')),
          h('div', { class: 'grow' }, h('div', { class: 'name' }, 'Service keys'),
            h('div', { class: 'small' }, connected.length ? `${connected.length} of ${state.accounts.length} connected: ${connected.slice(0, 4).map((a) => a.label).join(', ')}${connected.length > 4 ? ` and ${connected.length - 4} more` : ''}.` : `None of ${state.accounts.length} connected yet. Stripe, hosting, analytics and the rest go here.`)),
          h('button', { class: 'btn', type: 'button', onclick: () => go('accounts') }, 'Manage', icon('arrow')))));
  }

  function sessionsCard() {
    return h('section', { class: 'card narrow' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Signing in')),
      h('div', { class: 'card-body rows' },
        h('div', { class: 'line' },
          h('span', { class: 'tile' }, icon('logout')),
          h('div', { class: 'grow' }, h('div', { class: 'name' }, 'This device'), h('div', { class: 'small' }, 'You stay signed in here for 30 days.')),
          h('form', { method: 'post', action: '/auth/logout' }, h('button', { class: 'btn', type: 'submit' }, 'Sign out'))),
        h('div', { class: 'line' },
          h('span', { class: 'tile' }, icon('devices')),
          h('div', { class: 'grow' }, h('div', { class: 'name' }, 'Other devices'), h('div', { class: 'small' }, 'Sign out everywhere else, like a shared or lost computer.')),
          h('button', { class: 'btn', type: 'button', onclick: (e) => busy(e.currentTarget, async () => {
            const r = await post('/api/me/sign-out-others');
            toast(r.ended ? `Signed out of ${Board.plural(r.ended, 'other session')}` : 'You weren’t signed in anywhere else');
          }) }, 'Sign out others'))));
  }

  function deleteDialog() {
    const login = C.me.user.login;
    const n = state.apps.length;
    const dlg = h('dialog', { class: 'modal', 'aria-label': 'Delete your account' });
    const form = h('form', { onsubmit: (e) => {
      e.preventDefault();
      const typed = e.currentTarget.elements.confirm.value;
      busy(e.submitter, async () => {
        const r = await api('/api/me', { method: 'DELETE', body: JSON.stringify({ confirm: typed }) });
        if (!r) return;
        try { sessionStorage.removeItem('lc-run'); } catch {}
        location.href = r.githubRevoked === false ? '/login?deleted=github' : '/login?deleted=1';
      });
    } },
    h('div', { class: 'modal-head' }, h('span', { class: 'head-tile bad' }, icon('trash')), h('div', {}, h('h2', {}, 'Delete your account?'),
      h('p', { class: 'small' }, 'This can’t be undone. Liftoff Cloud deletes:'))),
    h('ul', { class: 'list-tight' },
      h('li', {}, n === 1 ? 'Your app, with its imported code and run history' : n ? `Your ${n} apps, with their imported code and run history` : 'Your apps, imported code and run history'),
      h('li', {}, 'The keys you saved for Stripe, hosting and other services, here and in Claude’s vault'),
      h('li', {}, C.me.github.signedIn ? 'Your GitHub sign-in, and the access you gave Liftoff Cloud' : 'Your settings and sign-ins')),
    h('p', { class: 'small' }, 'Your repositories, pull requests and the services Claude set up stay as they are.'),
    h('label', { class: 'field' }, h('span', {}, 'Type ', h('b', { class: 'mono' }, login), ' to confirm'),
      h('input', { name: 'confirm', type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': `Type ${login} to confirm`,
        oninput: (e) => { e.currentTarget.form.querySelector('.btn.danger-solid').disabled = e.currentTarget.value.trim().toLowerCase() !== login.toLowerCase(); } })),
    h('div', { class: 'acts' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn danger-solid', type: 'submit', disabled: true }, icon('trash'), 'Delete account')));
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  function dangerCard() {
    const open = hasOpenRun();
    return h('section', { class: 'card narrow danger-card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Delete account')),
      h('div', { class: 'card-body' },
        h('div', { class: 'line' },
          h('div', { class: 'grow' }, h('div', { class: 'small' }, open
            ? 'A Claude run is still going. Stop it first, then you can delete your account.'
            : 'Removes your apps, run history, saved keys and GitHub access from Liftoff Cloud. Your code and services stay as they are.')),
          h('button', { class: 'btn danger', type: 'button', disabled: open, onclick: deleteDialog }, icon('trash'), 'Delete account…'))));
  }

  function settingsView() {
    const head = h('div', { class: 'page-head narrow' }, h('div', {},
      h('h1', {}, 'Account settings'),
      h('p', {}, 'Your profile, how Liftoff Cloud looks, and what Claude runs start with.')));
    if (!C.me) return [head, h('div', { class: 'card narrow empty' }, h('p', {}, 'Loading your settings…'))];
    return [head, profileCard(C.me), appearanceCard(), runsCard(C.me), connectionsCard(C.me), sessionsCard(), dangerCard()];
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
    return h('section', { class: 'card next run-card' + (needs ? ' needs' : '') },
      orb(r.status, true),
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
    const save = (k, value) => {
      if ((app.config[k] || '') === value.trim()) return;
      busy(null, async () => {
        await post(`/api/apps/${app.slug}/settings`, { key: k, value });
        toast(`Saved ${k}`);
        await refresh(true);
      });
    };
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Settings'), h('span', { class: 'end sub' }, 'Verify and Pulse read these')),
      h('div', { class: 'card-body' }, Object.entries(keys).map(([k, d]) => h('div', { class: 'set' },
        h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'd' }, d)),
        h('input', {
          class: 'in', type: 'text', value: app.config[k] || '', 'aria-label': k, placeholder: k === 'health.path' ? '/api/health' : '',
          onchange: (e) => save(k, e.currentTarget.value),
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } },
        }))),
      h('div', { class: 'row danger-zone' },
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
        const fresh = r.events.filter((e) => e.n > after);
        // A message still on its way to the server stays until its copy comes back.
        const sending = C.run.events.filter((e) => e.temp && !fresh.some((x) => x.kind === 'you' && x.text === e.text));
        const events = C.run.events.filter((e) => !e.temp).concat(fresh);
        C.run = { ...r, events: events.slice(-600).concat(sending) };
      } else C.run = r;
      remember();
    } catch (e) {
      if (/No such/.test(e.message)) { C.runId = null; C.run = null; }
    }
  }

  function stepPicker(app) {
    const steps = app.steps;
    const left = steps.filter((s) => !['done', 'skipped'].includes(s.status));
    if (!Object.keys(C.pick).length) for (const s of steps) C.pick[s.id] = !['done', 'skipped'].includes(s.status);
    const chosen = steps.filter((s) => C.pick[s.id]);
    const missing = app.accounts.filter((a) => !a.connected);
    const picked = models().some((m) => m.id === C.model) ? C.model : C.me?.models?.default;
    const mode = app.cloud?.source?.type === 'github' && C.me?.github.token ? 'github' : 'upload';
    const start = (e) => busy(e.currentTarget, async () => {
      await startRun(app.slug, { steps: chosen.map((s) => s.id), note: C.note, model: picked });
      C.note = '';
    });
    return h('section', { class: 'card launch' },
      h('div', { class: 'launch-top' },
        orb('idle', true),
        h('div', { class: 'grow' },
          h('h2', {}, 'Start a run'),
          h('p', {}, 'Claude works in a private cloud sandbox with a copy of your code, following the same skills as the Claude Code plugin. It asks you here before anything that spends money, changes DNS or goes live.'),
          h('ul', { class: 'facts-inline' },
            h('li', {}, icon(mode === 'github' ? 'pr' : 'download'), mode === 'github' ? `Changes go on a new branch with a draft pull request on ${app.cloud.source.fullName}.` : 'Changes come back as a patch and an updated zip to download.'),
            h('li', {}, icon('shield'), 'Connected accounts are used through placeholders. Real keys stay on the server.')))),
      h('div', { class: 'launch-body' },
        !C.me?.claude.ok ? h('div', { class: 'note-box bad' }, icon('x'), h('span', {}, C.me?.claude.why || 'Cloud runs are not set up on this server.')) : null,
        missing.length ? h('div', { class: 'note-box warn' }, icon('key'),
          h('span', {}, `Not connected yet: ${missing.map((a) => a.label).join(', ')}. Steps that need them are marked blocked with a task for you. `,
            h('a', { href: '#accounts', onclick: (e) => { e.preventDefault(); go('accounts'); } }, 'Connect accounts'))) : null,
        h('div', { class: 'sec-head' }, h('span', { class: 'sec-title' }, 'Steps'), h('span', { class: 'count' }, `${chosen.length}/${steps.length}`),
          h('button', { class: 'btn quiet sm', type: 'button', onclick: () => { for (const s of steps) C.pick[s.id] = false; render(); } }, 'Clear')),
        h('div', { class: 'picker' }, steps.map((s) => {
          const done = ['done', 'skipped'].includes(s.status);
          return h('label', { class: 'pick spot' + (C.pick[s.id] ? ' on' : '') + (done && !C.pick[s.id] ? ' off' : ''), key: s.id },
            h('input', { type: 'checkbox', checked: !!C.pick[s.id], onchange: (e) => { C.pick[s.id] = e.currentTarget.checked; render(); } }),
            h('span', { class: 't' }, h('b', {}, s.label), h('span', { class: 'small' }, done ? Board.STEP_WORD[s.status] : s.waitingOn?.length ? `Waits on ${s.waitingOn.map((id) => stepLabel(app, id)).join(', ')}` : s.note || 'Not started')));
        })),
        models().length > 1 ? [
          h('div', { class: 'sec-head' }, h('span', { class: 'sec-title' }, 'Model')),
          h('div', { class: 'picker models', role: 'radiogroup', 'aria-label': 'Model' }, models().map((m) => h('label', { class: 'pick spot' + (m.id === picked ? ' on' : ''), key: m.id },
            h('input', { type: 'radio', name: 'run-model', value: m.id, checked: m.id === picked, onchange: () => { C.model = m.id; render(); } }),
            h('span', { class: 't' }, h('b', {}, m.label, m.id === C.me.models.default ? h('span', { class: 'hint' }, ' (default)') : null), h('span', { class: 'small' }, m.hint))))),
        ] : null,
        h('label', { class: 'field' }, h('span', {}, 'Note for Claude ', h('span', { class: 'hint' }, '(optional)')),
          h('textarea', { class: 'in', oninput: (e) => { C.note = e.currentTarget.value; }, placeholder: 'Anything Claude should know? e.g. "Use Cloudflare, not Vercel" or "Price Pro at $8/month"', 'aria-label': 'Note for Claude', maxlength: '1000' }, C.note || '')),
        h('div', { class: 'launch-go' },
          h('button', { class: 'btn primary big', type: 'button', disabled: !C.me?.claude.ok || !chosen.length, onclick: start }, icon('play'), chosen.length === left.length ? 'Start the launch' : `Run ${chosen.length} step${chosen.length === 1 ? '' : 's'}`),
          h('span', { class: 'small' }, `Budget ${usd(C.me?.limits.runBudgetUsd)} per run`))));
  }

  async function startRun(slug, body) {
    const run = await post(`/api/apps/${slug}/runs`, body);
    C.runId = run.id;
    C.run = run;
    C.runs = null;
    C.stick = true;
    remember();
    await refresh(true);
  }

  // ----- the thread -----

  const TOOL_ICON = { bash: 'terminal', read: 'file', write: 'pencil', edit: 'pencil', glob: 'search', grep: 'search', web_fetch: 'globe', web_search: 'globe', open_pull_request: 'pr', github_set_secret: 'key' };
  const toolIcon = (e) => TOOL_ICON[e.tool] || (e.kind === 'liftoff' ? 'rocket' : 'terminal');

  // A Liftoff step that finished, got blocked or was skipped shows as a milestone.
  function milestone(app, e) {
    if (e.kind !== 'liftoff' || e.tool !== 'liftoff_step') return null;
    const m = String(e.text).match(/^(\S+) → (done|blocked|skipped)(?:: (.*))?$/s);
    return m ? { label: stepLabel(app, m[1]), status: m[2], note: m[3] || '' } : null;
  }

  function summarize(items) {
    const n = { cmd: 0, read: 0, edit: 0, lift: 0, other: 0 };
    for (const e of items) {
      if (e.tool === 'bash') n.cmd++;
      else if (['read', 'glob', 'grep'].includes(e.tool)) n.read++;
      else if (['write', 'edit'].includes(e.tool)) n.edit++;
      else if (e.kind === 'liftoff') n.lift++;
      else n.other++;
    }
    const parts = [];
    if (n.cmd) parts.push(`ran ${n.cmd} command${n.cmd === 1 ? '' : 's'}`);
    if (n.edit) parts.push(`edited ${n.edit} file${n.edit === 1 ? '' : 's'}`);
    if (n.read) parts.push(`read ${n.read} file${n.read === 1 ? '' : 's'}`);
    if (n.lift) parts.push(`${n.lift} Liftoff update${n.lift === 1 ? '' : 's'}`);
    if (n.other) parts.push(`${n.other} other action${n.other === 1 ? '' : 's'}`);
    const s = parts.slice(0, 3).join(', ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function actText(e) {
    if (e.tool === 'bash') return h('code', { class: 'cmd-inline' }, e.text);
    if (['read', 'write', 'edit', 'glob', 'grep'].includes(e.tool)) {
      const [verb, ...rest] = String(e.text).split(' ');
      return [h('span', {}, { read: 'Read', write: 'Wrote', edit: 'Edited', glob: 'Searched', grep: 'Searched for' }[verb] || verb, ' '), h('code', { class: 'cmd-inline' }, rest.join(' '))];
    }
    return e.text || e.tool;
  }

  function actRow(run, e, working) {
    const key = `o-${run.id}-${e.n}`;
    const body = e.out
      ? h('details', { class: 'act-body', open: !!C.open[key], ontoggle: (ev) => { C.open[key] = ev.currentTarget.open; } },
        h('summary', {}, actText(e), e.isError ? h('span', { class: 'err-tag' }, 'failed') : null), h('pre', { class: 'out' }, e.out))
      : h('div', { class: 'act-body' }, actText(e));
    return h('li', { class: 'act' + (e.isError ? ' err' : '') + (working ? ' working' : ''), key: `a-${e.n}`, title: clock(e.at) },
      h('span', { class: 'act-i' }, working ? icon('spinner') : icon(toolIcon(e))), body);
  }

  function toolGroup(run, g, working) {
    const key = `g-${run.id}-${g.key}`;
    const failed = g.items.some((e) => e.isError);
    const last = g.items[g.items.length - 1];
    return h('details', { class: 'acts-group' + (working ? ' working' : '') + (failed ? ' has-err' : ''), key, open: !!C.open[key], ontoggle: (e) => { C.open[key] = e.currentTarget.open; } },
      h('summary', {},
        h('span', { class: 'acts-i' }, working ? icon('spinner') : icon(failed ? 'x' : 'checkCircle')),
        h('span', { class: 'acts-title' },
          h('span', { class: 'acts-sum' }, summarize(g.items)),
          h('span', { class: 'acts-last' }, last.text || last.tool)),
        h('span', { class: 'count' }, g.items.length),
        icon('chevronDown', 'chev')),
      h('ol', { class: 'acts-list' }, g.items.map((e, i) => actRow(run, e, working && i === g.items.length - 1 && !e.out))));
  }

  function answer(run, p, text, btn) {
    busy(btn, async () => {
      C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/answer`, { eventId: p.id, text });
      C.stick = true;
      render();
    });
  }

  function decide(run, p, allow, e) {
    const reason = e.currentTarget.closest('.ask-card')?.querySelector('[name=reason]')?.value || '';
    busy(e.currentTarget, async () => {
      C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/approve`, { eventId: p.id, allow, reason: allow ? '' : reason });
      C.stick = true;
      render();
    });
  }

  function askCard(run, p) {
    const key = `p-${run.id}-${p.id}`;
    if (p.kind === 'question') {
      return h('div', { class: 'ask-card', key },
        h('div', { class: 'ask-top' }, h('span', { class: 'ask-badge' }, icon('flag'), 'Claude asks'), h('time', {}, ago(p.at))),
        h('div', { class: 'ask-q rich' }, rich(p.text)),
        p.options?.length ? h('div', { class: 'chips' }, p.options.map((o) => h('button', { class: 'chip', type: 'button', onclick: (e) => answer(run, p, o, e.currentTarget) }, o))) : null,
        h('form', { class: 'ask-form', onsubmit: (e) => {
          e.preventDefault();
          const v = e.currentTarget.elements.answer.value;
          if (v.trim()) answer(run, p, v, e.submitter);
        } },
        h('input', { class: 'in', name: 'answer', type: 'text', placeholder: p.options?.length ? 'Or type your own answer…' : 'Type your answer…', 'aria-label': 'Your answer', autocomplete: 'off' }),
        h('button', { class: 'send', type: 'submit', 'aria-label': 'Send answer' }, icon('arrowUp'))));
    }
    return h('div', { class: 'ask-card approve', key },
      h('div', { class: 'ask-top' },
        h('span', { class: 'ask-badge' }, icon(p.kind === 'secret' ? 'key' : 'shield'), p.kind === 'secret' ? 'Copy a key to GitHub' : `Claude asks before using ${p.tool}`),
        h('time', {}, ago(p.at))),
      h('div', { class: 'ask-q' }, p.text),
      p.detail && p.kind === 'approval' ? h('pre', { class: 'cmd' }, p.detail) : null,
      h('div', { class: 'ask-actions' },
        h('button', { class: 'btn good', type: 'button', onclick: (e) => decide(run, p, true, e) }, icon('check'), 'Allow'),
        h('button', { class: 'btn', type: 'button', onclick: (e) => decide(run, p, false, e) }, 'Decline'),
        h('input', { class: 'in grow', name: 'reason', type: 'text', placeholder: 'Why not? (optional, shown to Claude)', 'aria-label': 'Reason' })));
  }

  // Turn the run's events into thread rows: { side, key, node }.
  function threadRows(app, run) {
    const pending = new Map(run.pending.map((p) => [p.id, p]));
    const working = run.status === 'running' || run.status === 'starting';
    const rows = [];
    let group = null;
    let lastAt = 0;
    const lastYou = [...run.events].reverse().find((e) => e.kind === 'you');
    const flush = () => {
      if (group) rows.push({ side: 'claude', key: `g-${group.key}`, group });
      group = null;
    };
    const stamp = (at) => {
      const t = new Date(at).getTime();
      if (t - lastAt > 10 * 60 * 1000) rows.push({ side: 'stamp', key: `t-${at}`, node: h('div', { class: 'stamp' }, clock(at)) });
      lastAt = t;
    };
    for (const e of run.events) {
      const p = e.id ? pending.get(e.id) : null;
      if (!p && (e.kind === 'tool' || (e.kind === 'liftoff' && !milestone(app, e)))) {
        if (!group) {
          stamp(e.at);
          group = { key: e.n, items: [] };
        }
        group.items.push(e);
        continue;
      }
      flush();
      stamp(e.at);
      const key = `${e.n}`;
      if (p) {
        pending.delete(e.id);
        rows.push({ side: 'claude', key: `p-${p.id}`, node: askCard(run, p), card: true });
        continue;
      }
      const ms = milestone(app, e);
      if (ms) {
        rows.push({ side: 'sys', key, node: h('div', { class: `sys milestone ${ms.status}` }, icon(ms.status === 'blocked' ? 'x' : ms.status === 'skipped' ? 'minus' : 'checkCircle'),
          h('span', {}, h('b', {}, ms.label), ms.status === 'done' ? ' is done' : ms.status === 'skipped' ? ' was skipped' : ' is blocked', ms.note ? ` · ${ms.note}` : '')) });
        continue;
      }
      switch (e.kind) {
        case 'message':
          rows.push({ side: 'claude', key, node: h('div', { class: 'bubble rich', title: clock(e.at) }, rich(e.text)) });
          break;
        case 'question':
          rows.push({ side: 'claude', key, node: h('div', { class: 'bubble rich asked', title: clock(e.at) }, h('span', { class: 'asked-tag' }, icon('flag'), 'Asked you'), rich(e.text)) });
          break;
        case 'error':
          rows.push({ side: 'claude', key, node: h('div', { class: 'bubble err', title: clock(e.at) }, icon('x'), h('span', {}, e.text)) });
          break;
        case 'you': {
          const decision = String(e.text).match(/^(Allowed|Declined): ([\s\S]*)$/);
          const k = C.sent && e === lastYou && e.text === C.sent.text ? C.sent.key : key;
          rows.push({ side: 'you', key: k, node: h('div', { class: 'bubble' + (decision ? ` decision ${decision[1].toLowerCase()}` : '') + (e.temp ? ' sending' : ''), title: e.at ? clock(e.at) : '' },
            decision ? [icon(decision[1] === 'Allowed' ? 'check' : 'x'), h('span', {}, h('b', {}, decision[1]), ' ', decision[2])] : e.text) });
          break;
        }
        case 'kickoff': {
          const k = `o-${run.id}-${e.n}`;
          rows.push({ side: 'sys', key, node: h('details', { class: 'sys brief', open: !!C.open[k], ontoggle: (ev) => { C.open[k] = ev.currentTarget.open; } },
            h('summary', {}, icon('rocket'), h('span', {}, e.text), icon('chevronDown', 'chev')), h('pre', { class: 'out' }, e.detail || '')) });
          break;
        }
        default: // status, note
          rows.push({ side: 'sys', key, node: h('div', { class: 'sys' + (/finished/i.test(e.text) ? ' good' : '') }, icon(/finished/i.test(e.text) ? 'checkCircle' : e.kind === 'note' ? 'clock' : 'activity'), h('span', {}, e.text)) });
      }
    }
    flush();
    for (const p of pending.values()) rows.push({ side: 'claude', key: `p-${p.id}`, node: askCard(run, p), card: true });
    if (run.status === 'budget') {
      rows.push({ side: 'claude', key: 'budget', card: true, node: h('div', { class: 'ask-card' },
        h('div', { class: 'ask-top' }, h('span', { class: 'ask-badge' }, icon('flag'), 'Paused at budget')),
        h('div', { class: 'ask-q' }, `This run reached its ${usd(run.budgetUsd)} budget and paused.`),
        h('div', { class: 'ask-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/budget`, { addUsd: 10 }); render(); }) }, 'Add $10 and continue'))) });
    }
    // Tool work still going on: the newest group shows a spinner.
    const tail = rows[rows.length - 1];
    if (tail?.group) tail.working = working;
    if (working) {
      rows.push({ side: 'claude', key: 'typing', node: h('div', { class: 'bubble typing', role: 'status' },
        h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
        h('span', { class: 'shimmer' }, run.status === 'starting' ? 'Setting up the sandbox' : 'Claude is working')) });
    }
    return rows;
  }

  // When each row first showed up, so only rows that arrive while you watch animate in.
  const born = new Map();
  let bornRun = null;

  function threadNodes(app, run) {
    const rows = threadRows(app, run);
    const now = Date.now();
    const settled = bornRun === run.id;
    if (!settled) {
      born.clear();
      bornRun = run.id;
    }
    const out = [];
    rows.forEach((r, i) => {
      if (r.group) r.node = toolGroup(run, r.group, !!r.working);
      if (!born.has(r.key)) born.set(r.key, settled ? now : 0);
      const isNew = now - born.get(r.key) < 1500 ? ' new' : '';
      if (r.side === 'stamp' || r.side === 'sys') {
        out.push(h('div', { class: `cmsg center${isNew}`, key: `${run.id}-${r.key}` }, r.node));
        return;
      }
      const first = rows[i - 1]?.side !== r.side;
      const last = rows[i + 1]?.side !== r.side;
      out.push(h('div', { class: `cmsg ${r.side}${first ? ' first' : ''}${last ? ' last' : ''}${r.card || r.group ? ' wide' : ''}${isNew}`, key: `${run.id}-${r.key}` },
        r.side === 'claude' ? h('div', { class: 'gutter' }, last ? orb(r.key === 'typing' ? 'running' : run.status === 'needs-you' && r.card ? 'needs-you' : 'idle') : null) : null,
        h('div', { class: 'col' }, first && r.side === 'claude' && r.key !== 'typing' ? h('div', { class: 'who-line' }, 'Claude') : null, r.node)));
    });
    return out;
  }

  function scrollToEnd(smooth) {
    const t = document.querySelector('.thread');
    if (!t) return;
    C.stick = true;
    C.autoScroll = Date.now();
    t.closest('.chat')?.classList.remove('scrolled');
    t.scrollTo({ top: t.scrollHeight, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
  }

  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }

  function sendMessage(run, e) {
    e.preventDefault();
    const text = C.draft.trim();
    if (!text) return;
    // Show the bubble right away; the server's copy takes its place.
    const key = `sent-${Date.now()}`;
    C.sent = { text, key };
    C.run.events = [...C.run.events, { n: key, kind: 'you', text, at: new Date().toISOString(), temp: true }];
    C.draft = '';
    C.stick = true;
    render();
    busy(e.currentTarget.querySelector('.send'), async () => {
      try {
        C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/message`, { text });
      } catch (err) {
        C.run.events = C.run.events.filter((x) => x.n !== key);
        C.draft = text;
        C.sent = null;
        render();
        throw err;
      }
      render();
    });
  }

  function chatPanel(app, run) {
    const live = LIVE.has(run.status);
    const disabled = run.status === 'needs-you' || run.status === 'budget' || run.status === 'starting';
    const placeholder = run.status === 'needs-you' ? 'Answer Claude above first'
      : run.status === 'budget' ? 'Raise the budget to keep going'
        : run.status === 'starting' ? 'Claude is setting up…'
          : live ? 'Message Claude…' : 'Message Claude to keep going…';
    const status = run.status === 'starting' ? 'Setting up a private sandbox'
      : run.status === 'running' ? 'Working on your app'
        : run.status === 'needs-you' ? `Waiting on you (${run.pending.length})`
          : run.status === 'budget' ? 'Paused at its budget'
            : run.status === 'finished' ? 'Finished. Send a message to keep going.'
              : RUN_WORD[run.status] || run.status;
    const thread = h('div', {
      class: 'thread', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation with Claude', tabindex: '0',
      onscroll: (e) => {
        const t = e.currentTarget;
        if (Date.now() - C.autoScroll < 700) return;
        C.stick = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
        t.closest('.chat')?.classList.toggle('scrolled', !C.stick);
      },
    }, h('div', { class: 'thread-in' }, threadNodes(app, run)));
    return h('section', { class: 'card chat' + (live ? ' live' : '') + (C.stick ? '' : ' scrolled'), key: `chat-${run.id}` },
      h('header', { class: 'chat-head' },
        orb(run.status),
        h('div', { class: 'grow' }, h('div', { class: 'chat-name' }, 'Claude', run.model ? h('span', { class: 'pill sm' }, modelLabel(run.model)) : null), h('div', { class: 'small' }, status)),
        runPill(run.status, true)),
      h('div', { class: 'thread-wrap' }, thread,
        h('button', { class: 'jump', type: 'button', onclick: () => scrollToEnd(true), tabindex: C.stick ? '-1' : '0' }, icon('arrowDown'), 'Latest')),
      h('form', { class: 'composer', onsubmit: (e) => sendMessage(run, e) },
        h('div', { class: 'composer-box' + (disabled ? ' off' : '') },
          h('textarea', {
            class: 'in', rows: '1', placeholder, 'aria-label': 'Message Claude', disabled,
            oninput: (e) => {
              C.draft = e.currentTarget.value;
              grow(e.currentTarget);
              e.currentTarget.form.querySelector('.send').disabled = !C.draft.trim();
            },
            onkeydown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                e.currentTarget.form.requestSubmit();
              }
            },
          }, C.draft || ''),
          h('button', { class: 'send', type: 'submit', 'aria-label': 'Send', disabled: disabled || !(C.draft || '').trim() }, icon('arrowUp'))),
        h('div', { class: 'composer-hint' }, disabled ? '' : 'Enter to send, Shift+Enter for a new line')));
  }

  function runInfo(app, run) {
    const spent = run.budgetUsd ? Math.min(100, ((run.cost || 0) / run.budgetUsd) * 100) : 0;
    const ids = run.steps.length ? run.steps : null;
    const STEP_I = { done: 'checkCircle', skipped: 'minus', running: 'spinner', blocked: 'x' };
    return h('section', { class: 'card run-info' },
      h('div', { class: 'card-head' }, h('h2', {}, 'This run'), h('span', { class: 'end' }, h('span', { class: 'sub' }, `Started ${ago(run.createdAt)}`))),
      h('div', { class: 'card-body' },
        h('div', { class: 'spend' },
          h('div', { class: 'spend-top' }, h('span', { class: 'spend-n' }, run.cost === null ? usd(0) : usd(run.cost)), h('span', { class: 'small' }, `of ${usd(run.budgetUsd)} budget`)),
          h('div', { class: 'meter' }, h('span', { class: 'ok', style: { width: `${Math.max(spent, run.cost ? 2 : 0)}%` } }))),
        h('dl', { class: 'kv' },
          h('div', {}, h('dt', {}, 'Model'), h('dd', {}, run.model ? modelLabel(run.model) : '–')),
          h('div', {}, h('dt', {}, 'Changes'), h('dd', {}, run.pr ? h('a', { href: run.pr.url, target: '_blank', rel: 'noopener' }, icon('pr'), `Pull request #${run.pr.number}`) : run.mode === 'github' ? 'Draft pull request' : 'Patch and zip'))),
        h('div', { class: 'sec-head' }, h('span', { class: 'sec-title' }, 'Steps')),
        ids ? h('ul', { class: 'run-steps' }, ids.map((id) => {
          const s = app.steps.find((x) => x.id === id);
          const st = s?.status || 'todo';
          return h('li', { class: st, key: id }, icon(STEP_I[st] || 'circle'), h('span', {}, stepLabel(app, id)));
        })) : h('div', { class: 'small' }, 'All remaining steps')));
  }

  function runView() {
    const app = appOf(C.slug);
    if (!app) return h('div', { class: 'card empty' }, h('div', { class: 'tile' }, icon('play')), h('h2', {}, 'Pick an app'), h('p', {}, 'Open an app and choose Run with Claude.'));
    const run = C.run;
    const head = h('div', { class: 'page-head run-head' },
      Board.avatar(app, true),
      h('div', { class: 'grow' }, h('h1', {}, app.name), h('p', {}, run ? (run.steps.length ? run.steps.map((id) => stepLabel(app, id)).join(', ') : 'All remaining steps') : 'Claude run')),
      h('div', { class: 'actions' },
        run && LIVE.has(run.status) ? h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/stop`); render(); }) }, icon('stop'), 'Stop') : null,
        run && !OPEN.has(run.status) && run.model !== STRONGEST && models().some((m) => m.id === STRONGEST) && C.me?.claude.ok
          ? h('button', { class: 'btn', title: 'Start a new run for the same steps on Claude Opus 5.5', onclick: (e) => busy(e.currentTarget, () => startRun(C.slug, { steps: run.steps, note: run.note || '', model: STRONGEST })) }, icon('refresh'), 'Try again with Opus') : null,
        run && !OPEN.has(run.status) ? h('button', { class: 'btn', onclick: () => { C.runId = null; C.run = null; C.pick = {}; remember(); render(); } }, icon('plus'), 'New run') : null,
        h('button', { class: 'btn quiet', onclick: () => go('app', app.slug) }, `Back to ${app.name}`, icon('arrow'))));

    if (C.loading) return [head, h('div', { class: 'card empty' }, orb('running', true), h('p', {}, 'Loading the run…'))];
    if (!run) return [head, stepPicker(app), historyCard(app)];

    return [
      head,
      run.error ? h('div', { class: 'note-box bad' }, icon('x'), h('span', {}, run.error)) : null,
      h('div', { class: 'run-grid' },
        chatPanel(app, run),
        h('div', { class: 'stack run-side' },
          runInfo(app, run),
          run.outputs?.length ? h('section', { class: 'card' }, h('div', { class: 'card-head' }, icon('download'), h('h2', {}, 'Your updated code')),
            h('div', { class: 'card-body rows' }, run.outputs.map((f) => h('div', { class: 'line', key: f.id },
              h('span', { class: 'tile' }, icon('file')), h('div', { class: 'grow' }, h('div', { class: 'name' }, f.filename), h('div', { class: 'small' }, f.size ? `${Math.round(f.size / 1024)} KB` : '')),
              h('a', { class: 'btn', href: `/api/apps/${C.slug}/runs/${run.id}/outputs/${encodeURIComponent(f.id)}` }, icon('download'), 'Download'))))) : null,
          historyCard(app))),
    ];
  }

  function historyCard(app) {
    const past = (C.runs || []).filter((r) => r.id !== C.run?.id);
    if (!past.length) return null;
    return h('section', { class: 'card history' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Earlier runs'), h('span', { class: 'count' }, past.length)),
      h('div', { class: 'card-body rows' }, past.slice(0, 10).map((r) => h('div', { class: 'line', key: r.id, role: 'button', tabindex: '0', onclick: () => openRun(app.slug, r.id), onkeydown: (e) => { if (e.key === 'Enter') openRun(app.slug, r.id); } },
        h('div', { class: 'grow' }, h('div', { class: 'name' }, r.steps.length ? r.steps.map((id) => stepLabel(app, id)).join(', ') : 'All remaining steps'),
          h('div', { class: 'small' }, `${ago(r.createdAt)} · ${usd(r.cost)}`)),
        r.pr ? h('span', { class: 'pill sm' }, `PR #${r.pr.number}`) : null,
        runPill(r.status, true)))));
  }

  // ---------- hooks ----------

  Board.configure({
    brand: 'Liftoff Cloud',
    unauthorized: () => { location.href = '/login'; },
    pollMs: () => (state.view === 'run' && C.run && LIVE.has(C.run.status) ? 2000 : 4000),
    load: async () => {
      const me = api('/api/me').then((m) => {
        if (!m) return;
        C.me = m;
        // Your saved theme follows you to a new browser, once per page load.
        if (!C.themeSynced) {
          C.themeSynced = true;
          if (m.prefs?.theme && window.LiftoffTheme && m.prefs.theme !== window.LiftoffTheme.get()) window.LiftoffTheme.set(m.prefs.theme, { animate: false });
        }
      });
      const run = state.view === 'run' ? loadRun(false) : null;
      await Promise.all([me, run]);
      return true;
    },
    views: {
      add: { title: 'Add an app', render: addView },
      settings: { title: 'Account settings', render: settingsView },
      run: { get title() { const a = appOf(C.slug); return a ? `${a.name} · Claude run` : 'Claude run'; }, render: runView, key: () => `${C.slug}:${C.loading ? 'loading' : C.run?.id || 'new'}` },
    },
    navExtra: () => h('button', { class: 'nav' + (state.view === 'add' ? ' on' : ''), onclick: () => go('add') }, icon('plus'), h('span', {}, 'Add an app')),
    sideFoot: () => C.me ? h('button', { class: 'nav who' + (state.view === 'settings' ? ' on' : ''), type: 'button', title: 'Account settings', onclick: () => go('settings') },
      meAvatar(C.me.user),
      h('span', { class: 'nm' }, C.me.user.login),
      h('span', { class: 'end' }, icon('settings'))) : null,
    themeChanged: (pref) => {
      C.themeSynced = true;
      if (C.me?.prefs?.theme !== pref) savePrefs({ theme: pref });
    },
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
    overviewIntro: (apps) => `${Board.plural(apps.length, 'app')} in Liftoff Cloud. Here is what needs you first.`,
    overviewActions: () => h('button', { class: 'btn primary', onclick: () => go('add') }, icon('plus'), 'Add an app'),
    accountAction,
    accountsIntro: () => 'Add a key once and all your apps can use it. Keys are encrypted on the server, and Claude’s sandbox only sees placeholders that turn into the real key on the way to that service.',
    heroMeta: sourceLine,
    heroActions: (app) => [
      h('button', { class: 'btn', title: 'Fetch the code again and rescan it', onclick: (e) => busy(e.currentTarget, async () => { toast('Rescanning…'); await post(`/api/apps/${app.slug}/rescan`); await refresh(true); toast('Rescanned'); }) }, icon('refresh'), 'Rescan'),
      h('button', { class: 'btn primary', onclick: () => openRun(app.slug, app.cloud?.run && OPEN.has(app.cloud.run.status) ? app.cloud.run.id : null) }, icon('play'), app.cloud?.run && OPEN.has(app.cloud.run.status) ? 'Open run' : 'Run with Claude'),
    ],
    afterHero: (app) => [runCard(app), scanCard(app)],
    nextActionButton: (app, a) => (a.skill || a.command ? h('button', { class: 'btn', onclick: () => {
      const ids = app.steps.filter((s) => s.skill === a.skill && !['done', 'skipped'].includes(s.status)).map((s) => s.id);
      openRun(app.slug).then(() => { if (ids.length && !C.run) { C.pick = Object.fromEntries(app.steps.map((s) => [s.id, ids.includes(s.id)])); render(); } });
    } }, icon('play'), 'Do it with Claude') : null),
    stepsHeadEnd: (app) => h('button', { class: 'btn', onclick: () => openRun(app.slug) }, icon('play'), 'Run with Claude'),
    mainBottom: settingsCard,
    afterRender: () => {
      const ta = document.querySelector('.composer textarea');
      if (ta) grow(ta);
      const t = document.querySelector('.thread');
      if (!t) return;
      // Stay pinned to the newest message unless you scrolled up to read.
      const fresh = !t.__seen;
      t.__seen = true;
      if (fresh || C.stick) {
        const grew = t.scrollHeight - t.scrollTop - t.clientHeight > 2;
        if (fresh) t.scrollTop = t.scrollHeight;
        else if (grew) scrollToEnd(true);
      }
    },
  });

  Board.start();
})();
