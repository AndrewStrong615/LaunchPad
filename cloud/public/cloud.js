// Liftoff Cloud screens on top of the shared Flight Board front end
// (board.js): adding apps, connecting accounts, account settings, and runs
// where the assistant does the launch steps in the cloud. A run reads like a
// messages thread: the assistant's bubbles on the left, yours on the right,
// tool work folded into one line, and its questions and approvals as cards
// right where it asked.
//
// The assistant goes by its Liftoff name (Pilot unless the server sets
// another), runs come in modes (Cruise, Boost) rather than models, and what
// runs use is shown in tokens. The server sends all three (lib/brand.mjs);
// only the admin run records page shows dollars.
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
    lock: '<rect x="5" y="11" width="14" height="9.5" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  });

  const LIVE = new Set(['starting', 'running', 'needs-you']);
  const OPEN = new Set([...LIVE, 'budget']);
  const RUN_WORD = { starting: 'Starting', running: 'Working', 'needs-you': 'Needs you', finished: 'Finished', stopped: 'Stopped', budget: 'Paused at budget', failed: 'Failed' };
  const RUN_TONE = { starting: 'run', running: 'run', 'needs-you': 'warn', finished: 'good', stopped: '', budget: 'warn', failed: 'bad' };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Cloud-only state.
  const C = { me: null, slug: null, run: null, runs: null, pick: {}, stick: true, busy: false, repos: null, note: '', draft: '', loading: false, tier: null, open: {}, sent: null, zipName: '', autoScroll: 0 };
  const ai = () => C.me?.assistant?.name || 'Pilot';
  const tiers = () => C.me?.tiers?.choices || [];
  const tierLabel = (id) => tiers().find((t) => t.id === id)?.label || id;
  const strongest = () => C.me?.tiers?.strongest || null;
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
  // Dollars only on the admin run records page; everyone else sees tokens.
  const usd = (n) => (n === null || n === undefined ? '–' : `$${Number(n).toFixed(2)}`);
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const tok = (n) => (n === null || n === undefined ? '–' : `${num(n)} ${Number(n) === 1 ? 'token' : 'tokens'}`);
  // What "Add … and continue" adds to a run paused at its budget.
  const topUp = () => C.me?.limits?.topUpTokens || 1000;
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

  // The assistant's avatar: a plain disc with its initial, ringed while it works.
  const orb = (status, lg) => h('span', {
    class: 'orb' + (lg ? ' lg' : '') + (status === 'running' || status === 'starting' ? ' thinking' : status === 'needs-you' ? ' waiting' : ''),
    'aria-hidden': 'true',
  }, ai().charAt(0).toUpperCase());

  // The assistant writes light Markdown: paragraphs, lists, `code`, **bold** and links.
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

  // Both resolve to the imported app ({ slug, name, … }) once its scan is done.
  const importRepo = (url, ref) => post('/api/import/github', { url, ref: ref || undefined });
  async function importZip(f) {
    const res = await fetch(`/api/import/zip?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: f });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      location.href = '/login';
      return null;
    }
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }

  // Your GitHub repositories, fetched once per page load.
  const canListRepos = () => !!C.me?.github.token;
  function loadRepos() {
    if (!canListRepos() || C.repos || C.reposLoading || C.reposFailed) return;
    C.reposLoading = true;
    api('/api/github/repos').then((r) => { C.repos = r || []; repaint(); }).catch(() => { C.reposFailed = true; repaint(); }).finally(() => { C.reposLoading = false; });
  }

  function addForms() {
    const signedIn = canListRepos();
    loadRepos();
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
        const app = await importRepo(f.url.value, f.ref.value.trim());
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
        const body = await importZip(f);
        if (!body) return;
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
          h('p', { class: 'small' }, `${ai()} hands back your changes as a patch and an updated zip.`))));
  }

  function addView() {
    return [
      h('div', { class: 'page-head' }, h('div', {},
        h('h1', {}, 'Add an app'),
        h('p', {}, 'Liftoff reads the code, works out the stack and platforms, and runs the App Store pre-scan and a leaked-key scan. Nothing runs until you start a run.'))),
      addForms(),
    ];
  }

  // ---------- first run: the welcome tour ----------
  // Four short steps for a new account: what Liftoff does, add an app (and see
  // what the free scan found), connect the services it uses, and what's free
  // versus the Launch Pass. It opens by itself once, for an account with no
  // apps; finishing or skipping it is saved to the account (prefs.onboarded),
  // and Account settings can start it again. It covers the whole window, so
  // the sidebar and top bar step aside while it's open (body.ob-on).

  const OB_STEPS = ['Welcome', 'Add your app', 'Connect services', 'Free and Launch Pass'];
  const obFresh = () => ({ step: 0, slug: null, src: 'github', q: '', importing: null });
  C.ob = obFresh();
  try {
    const saved = JSON.parse(sessionStorage.getItem('lc-welcome') || 'null');
    if (saved) Object.assign(C.ob, { step: Math.min(Math.max(saved.step | 0, 0), OB_STEPS.length - 1), slug: saved.slug || null });
  } catch {}
  const obSave = () => {
    try { sessionStorage.setItem('lc-welcome', JSON.stringify({ step: C.ob.step, slug: C.ob.slug })); } catch {}
  };
  // Each step is its own history entry, so the browser's Back goes to the
  // step before (popstate below), not out of the tour.
  function obGo(step) {
    if (step !== C.ob.step) history.pushState({ ob: step }, '', '#!welcome');
    C.ob.step = step;
    obSave();
    render();
    window.scrollTo(0, 0);
  }
  function obPopped(saved) {
    if (state.view !== 'welcome') return;
    C.ob.step = Math.min(Math.max(saved?.ob | 0, 0), OB_STEPS.length - 1);
    obSave();
  }
  function obStart() {
    C.ob = obFresh();
    obSave();
    go('welcome');
  }
  // Finished or skipped: don't open it by itself again.
  function obDone(slug) {
    try { sessionStorage.removeItem('lc-welcome'); } catch {}
    C.ob = obFresh();
    if (C.me && !C.me.prefs?.onboarded) {
      C.me.prefs = { ...C.me.prefs, onboarded: true };
      savePrefs({ onboarded: true });
    }
    if (slug && appOf(slug)) go('app', slug);
    else go('overview');
  }

  const firstName = () => {
    const u = C.me?.user;
    if (!u || u.via === 'local') return null;
    return (u.name || u.login || '').trim().split(/\s+/)[0] || null;
  };
  const pctOf = (a) => {
    const total = a.stepsTotal + a.checksTotal;
    return total ? Math.round(((a.stepsDone + a.checksDone) / total) * 100) : 0;
  };

  function obTop() {
    const at = C.ob.step;
    return h('header', { class: 'ob-top' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }, icon('rocket')), h('span', {}, 'Liftoff Cloud')),
      h('ol', { class: 'ob-steps', 'aria-label': `Setup, step ${at + 1} of ${OB_STEPS.length}` }, OB_STEPS.map((label, i) => h('li', {
        key: label, class: i < at ? 'done' : i === at ? 'on' : '', 'aria-current': i === at ? 'step' : false,
      }, h('span', { class: 'n' }, i < at ? icon('check') : String(i + 1)), h('span', { class: 't' }, label)))),
      h('div', { class: 'ob-end' },
        Board.themeButton(),
        h('button', { class: 'btn quiet', type: 'button', title: 'Close the tour. You can start it again from Account settings.', onclick: () => obDone(C.ob.slug) }, 'Finish later')));
  }

  const obHead = (title, text) => h('div', { class: 'ob-head' }, h('h1', {}, title), text ? h('p', {}, text) : null);
  const obActs = (...kids) => h('div', { class: 'ob-acts' }, kids);
  const obNext = (label, onclick) => h('button', { class: 'btn primary big', type: 'button', onclick }, label, icon('arrow'));
  const obBack = (step) => h('button', { class: 'btn quiet big', type: 'button', onclick: () => obGo(step) }, 'Back');

  // 1. What Liftoff does.
  function obHello() {
    const name = firstName();
    const how = (ic, kicker, title, text, tag) => h('li', { class: 'card spot ob-how-card', key: kicker },
      h('div', { class: 'ob-how-top' }, h('span', { class: 'head-tile' }, icon(ic)), h('span', { class: 'kicker' }, kicker), tag ? h('span', { class: 'pill sm' }, tag) : null),
      h('h3', {}, title),
      h('p', {}, text));
    return [
      h('div', { class: 'ob-hero' },
        h('span', { class: 'ob-mark', 'aria-hidden': 'true' }, h('span', { class: 'mark' }, icon('rocket'))),
        h('h1', {}, name ? `Welcome, ${name}` : 'Welcome to Liftoff Cloud'),
        h('p', {}, 'Liftoff takes the app you built to one real people can sign up for and pay for. Here’s how it works. Setting up takes about two minutes.')),
      h('ol', { class: 'ob-how' },
        how('search', 'Scan', 'See what’s left', 'Liftoff reads your code and lists what stands between it and launch: payments, hosting, sign-in, store rules and leaked keys.', 'Free'),
        how('rocket', 'Set up', 'Get it done with you', `${ai()}, Liftoff’s launch assistant, does the steps in a private cloud sandbox, asks before anything that costs money or goes live, and hands back a pull request.`),
        how('shield', 'Prove', 'Know it works', 'Real checks against your live services, a test purchase in Liftoff’s own browser, and a launch report you can share.')),
      obActs(
        obNext(state.apps.length ? 'Pick an app' : 'Add your first app', () => obGo(1)),
        h('button', { class: 'btn quiet big', type: 'button', onclick: () => obDone() }, 'Look around first')),
    ];
  }

  // 2. Add an app, then see what the free scan found.
  function obImport(name, run) {
    if (C.busy) return;
    C.ob.importing = name || 'your app';
    render();
    busy(null, async () => {
      try {
        const app = await run();
        if (!app) return;
        await refresh(true);
        C.ob.slug = app.slug;
        obSave();
      } finally {
        C.ob.importing = null;
        render();
      }
    });
  }

  function obLinkForm(title) {
    return h('form', { class: 'ob-link', onsubmit: (e) => {
      e.preventDefault();
      const f = e.currentTarget.elements;
      const url = f.url.value.trim();
      const name = url.replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop();
      obImport(name, () => importRepo(url, f.ref.value.trim()));
    } },
    title ? h('div', { class: 'ob-or small' }, title) : null,
    h('div', { class: 'ob-link-row' },
      h('input', { class: 'in', name: 'url', type: 'url', placeholder: 'https://github.com/you/your-app', 'aria-label': 'GitHub repository link', required: true }),
      h('input', { class: 'in ref', name: 'ref', type: 'text', placeholder: 'Branch (optional)', 'aria-label': 'Branch (optional)' }),
      h('button', { class: 'btn primary', type: 'submit' }, 'Import')));
  }

  function obRepos() {
    loadRepos();
    const ob = C.ob;
    if (!canListRepos() || C.reposFailed) {
      return h('section', { class: 'card ob-panel', key: 'link' }, h('div', { class: 'card-pad' },
        obLinkForm(),
        h('p', { class: 'small' }, C.reposFailed ? 'Couldn’t list your repositories just now. Paste a link instead.' : 'Public repositories import as they are. For a private one, sign in with GitHub or add a GitHub token under Accounts first.')));
    }
    if (!C.repos) {
      return h('section', { class: 'card ob-panel', key: 'loading', 'aria-busy': 'true' },
        h('div', { class: 'repo-list' }, [0, 1, 2, 3].map((i) => h('div', { class: 'repo-row sk', key: `sk${i}` }, h('span', { class: 'sk-tile' }), h('span', { class: 'sk-line' }), h('span', { class: 'sk-btn' })))));
    }
    const q = ob.q.trim().toLowerCase();
    const hits = C.repos.filter((r) => !q || r.fullName.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
    const shown = hits.slice(0, 6);
    return h('section', { class: 'card ob-panel', key: 'repos' },
      h('label', { class: 'repo-search' }, icon('search'),
        h('input', { type: 'search', value: ob.q, placeholder: `Search ${Board.plural(C.repos.length, 'repository', 'repositories')}`, 'aria-label': 'Search your repositories', oninput: (e) => { ob.q = e.currentTarget.value; repaint(); } })),
      h('div', { class: 'repo-list rows' }, shown.length
        ? shown.map((r) => h('div', { class: 'repo-row', key: r.fullName },
          h('span', { class: 'tile' }, icon(r.private ? 'lock' : 'github')),
          h('div', { class: 'grow' },
            h('div', { class: 'name' }, h('span', { class: 'own' }, `${r.owner}/`), h('b', {}, r.repo), r.private ? h('span', { class: 'pill sm' }, 'Private') : null),
            h('div', { class: 'small' }, [r.pushedAt ? `Updated ${ago(r.pushedAt)}` : null, r.description].filter(Boolean).join(' · '))),
          h('button', { class: 'btn', type: 'button', onclick: () => obImport(r.repo, () => importRepo(r.url)) }, 'Import')))
        : h('div', { class: 'empty-row' }, q ? `No repository matches “${ob.q.trim()}”.` : 'No repositories on your GitHub account yet.')),
      hits.length > shown.length ? h('div', { class: 'repo-more small' }, `Showing ${shown.length} of ${hits.length}. Search to find the rest.`) : null,
      h('div', { class: 'ob-link-wrap' }, obLinkForm('Or paste a link to any public repository')));
  }

  function obZip() {
    const pick = (f) => {
      if (!f) return;
      if (!/\.zip$/i.test(f.name)) return toast('Choose a .zip file');
      obImport(f.name.replace(/\.zip$/i, ''), () => importZip(f));
    };
    return h('section', { class: 'card ob-panel', key: 'zip' }, h('div', { class: 'card-pad' },
      h('label', {
        class: 'drop',
        ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
        ondragleave: (e) => e.currentTarget.classList.remove('over'),
        ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); pick(e.dataTransfer.files[0]); },
      },
      h('span', { class: 'drop-icon' }, icon('upload')),
      h('span', { class: 'drop-title' }, 'Choose a .zip of your app, or drop it here'),
      h('span', { class: 'small' }, `Up to ${C.me?.limits.uploadMb || 50} MB. Leave out node_modules and build output.`),
      h('input', { type: 'file', accept: '.zip,application/zip', 'aria-label': 'Zip of your app', onchange: (e) => pick(e.currentTarget.files[0]) })),
      h('p', { class: 'small' }, 'Changes come back as a patch and an updated zip, since there’s no repository to open a pull request on.')));
  }

  function obScanning(name) {
    return [
      obHead(`Reading ${name}…`, 'Usually under a minute. Liftoff copies the code into a private folder and scans it there.'),
      h('section', { class: 'card ob-panel ob-scan', role: 'status' },
        h('ul', { class: 'scan-lines' }, ['Copying the code', 'Working out the stack and platforms', 'Running the App Store pre-scan', 'Looking for leaked keys'].map((t) => h('li', { key: t }, h('span', { class: 'st', 'aria-hidden': 'true' }), t)))),
    ];
  }

  function obScanned(app) {
    const failing = app.cloud?.scan?.failing || [];
    const p = pctOf(app);
    const num = (n, label, alert) => h('div', { class: 'ob-num' + (alert ? ' alert' : '') }, h('b', {}, String(n)), h('span', {}, label));
    return [
      obHead(`${app.name} is in`, 'Here’s what the free scan found. All of it is on the app’s page too.'),
      h('section', { class: 'card ob-panel ob-result' },
        h('div', { class: 'ob-result-top' },
          Board.avatar(app, true),
          h('div', { class: 'grow' },
            h('div', { class: 'nm' }, app.name),
            h('div', { class: 'small' }, [`${app.platforms.map((x) => Board.PLATFORM[x] || x).join(', ')} app`, app.framework].filter(Boolean).join(' · '))),
          h('div', { class: 'ring', style: { '--p': p }, title: 'Release readiness' }, h('b', {}, `${p}%`))),
        h('div', { class: 'ob-nums' },
          num(app.stepsTotal - app.stepsDone, 'launch steps to go'),
          num(app.blockingTasks, 'blocking release', app.blockingTasks > 0),
          num(failing.length, 'found in your code', failing.length > 0)),
        failing.length
          ? h('ul', { class: 'ob-found' }, failing.slice(0, 3).map((f) => {
            const item = app.checklist.find((c) => c.id === f.id);
            return h('li', { key: f.id }, icon('x'), h('div', {}, h('b', {}, item ? item.title : f.id), f.detail ? h('div', { class: 'small' }, f.detail) : null));
          }), failing.length > 3 ? h('li', { class: 'more small', key: 'more' }, `and ${failing.length - 3} more`) : null)
          : h('div', { class: 'empty-row' }, icon('checkCircle'), 'Nothing in the code needs fixing first.'),
        // What the app does: the steps, to-dos and checks above follow it.
        app.profile ? h('div', { class: 'ob-does' },
          h('div', { class: 'ob-does-head' }, h('b', {}, `What ${app.name} does`), h('span', { class: 'pill sm' }, app.profile.sizeLabel)),
          h('p', { class: 'small' }, 'Liftoff read this from the code. Anything not built yet stays in the launch in case the app needs it. Turn off what it won’t.'),
          Board.featureSwitches(app)) : null),
      obActs(
        obNext('Continue', () => {
          // Going on from here means what the app does looks right.
          if (app.profile && !app.profile.confirmedAt) post(`/api/apps/${encodeURIComponent(app.slug)}/profile`, { confirm: true }).catch(() => {});
          obGo(2);
        }),
        h('button', { class: 'btn quiet big', type: 'button', onclick: () => { C.ob.slug = null; obSave(); render(); } }, 'Use a different app')),
    ];
  }

  function obAdd(app) {
    const ob = C.ob;
    if (ob.importing) return obScanning(ob.importing);
    if (app) return obScanned(app);
    const tab = (id, ic, label) => h('button', { class: 'seg-btn' + (ob.src === id ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(ob.src === id), onclick: () => { ob.src = id; render(); } }, icon(ic), label);
    return [
      obHead('Add your app', 'Pick a repository or upload a zip. Liftoff reads the code, works out the stack, and checks it for store problems and leaked keys. Nothing in your code changes until you start a run.'),
      h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Where your code is' }, tab('github', 'github', 'GitHub'), tab('zip', 'upload', 'Upload a zip')),
      ob.src === 'zip' ? obZip() : obRepos(),
      state.apps.length ? h('div', { class: 'ob-have' }, h('span', { class: 'small' }, 'Or carry on with one you already added'),
        h('div', { class: 'row' }, state.apps.slice(0, 4).map((a) => h('button', { class: 'chip', key: a.slug, type: 'button', onclick: () => { ob.slug = a.slug; obGo(2); } }, Board.avatar(a), h('span', {}, a.name))))) : null,
      obActs(obBack(0)),
    ];
  }

  // 3. The services this app's steps use.
  function obKeys(app) {
    const list = app.accounts || [];
    const done = list.filter((a) => a.connected).length;
    return [
      obHead(`Connect what ${app.name} uses`, 'Add a key once and every app you add can use it. Keys are encrypted on the server, and the cloud sandbox only ever sees a placeholder that turns into the real key on its way to that service.'),
      h('section', { class: 'card ob-panel' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Services for this app'), h('span', { class: 'count' }, `${done}/${list.length}`), h('span', { class: 'end sub' }, 'All optional for now')),
        h('div', { class: 'card-body rows' }, list.length ? list.map((a) => h('div', { class: 'line', key: a.id },
          Board.serviceTile(a),
          h('div', { class: 'grow' }, h('div', { class: 'name' }, a.label), h('div', { class: 'small' }, a.connected ? `Connected ${a.connectedAt ? ago(a.connectedAt) : ''}`.trim() : a.note)),
          accountAction(a))) : h('div', { class: 'empty-row' }, icon('checkCircle'), 'This app doesn’t need any service keys.'))),
      h('p', { class: 'ob-note small' }, icon('clock'), `No keys handy? Skip this. ${ai()} asks for one when a step needs it, and they all live under Accounts.`),
      obActs(obNext('Continue', () => obGo(3)), obBack(1)),
    ];
  }

  // 4. Free versus the Launch Pass.
  function obPlans(app) {
    const p = app.cloud?.pass;
    // The price shows wherever someone would pay it: not on a free account or an app that has its pass.
    const priced = !!p?.enabled && !p.free && !p.pass && !!p.price?.usd;
    const list = (items) => h('ul', { class: 'pass-list' }, items.map((x) => h('li', { key: x }, icon('check'), h('span', {}, x))));
    const status = !p || !p.enabled ? h('span', { class: 'pill good' }, icon('check'), 'Included on this server')
      : p.free ? h('span', { class: 'pill good' }, icon('check'), 'Included with your account')
        : p.pass ? h('span', { class: 'pill good' }, icon('check'), `Active for ${app.name}`)
          : h('span', { class: 'small' }, `Get it on ${app.name}’s page when you’re ready to launch.`);
    return [
      obHead('What’s free, and what the Launch Pass adds', `Everything that shows where your app stands is free, for every app. The Launch Pass is for getting it done: ${priced ? `${usd0(p.price.usd)}, paid once per app` : 'one payment per app'}, no subscription.`),
      h('div', { class: 'ob-plans' },
        h('section', { class: 'card ob-plan' },
          h('div', { class: 'plan-top' }, h('h2', {}, 'Free'), h('span', { class: 'pill sm' }, 'Every app')),
          h('p', { class: 'small' }, 'See exactly what’s left, and keep an eye on it after launch.'),
          list(['The scan: stack, platforms, store rules and leaked keys', 'A launch score and the list of what’s left', 'Verify: real checks against your live services', 'Pulse: sign-ups, revenue and crashes in one place']),
          h('div', { class: 'plan-foot' }, h('span', { class: 'pill good' }, icon('check'), 'On now'))),
        h('section', { class: 'card ob-plan pass' },
          h('div', { class: 'plan-top' }, h('h2', {}, 'Launch Pass'), priced ? h('span', { class: 'plan-price' }, h('b', {}, usd0(p.price.usd)), h('span', {}, ' once, for this app')) : h('span', { class: 'pill sm' }, 'Per app')),
          h('p', { class: 'small' }, `${ai()} does the launch with you, then Liftoff proves it works.`),
          list([`${ai()} does the launch steps in a private cloud sandbox`, 'Changes come back as a pull request, or a patch for zips',
            ...(p?.includes ? p.includes.slice(1) : ['A real test purchase in Liftoff’s own browser, with screenshots', 'A launch report and the “Launch certified” badge']),
            p?.enabled && p.price?.tokens ? passTokens(p.price) : null].filter(Boolean)),
          p?.later ? h('p', { class: 'small pass-later' }, p.later) : null,
          h('div', { class: 'plan-foot' }, status))),
      obActs(obNext(`Open ${app.name}`, () => obDone(app.slug)), obBack(2)),
    ];
  }

  function welcomeView() {
    const ob = C.ob;
    const app = ob.slug ? appOf(ob.slug) : null;
    if (state.lastSync) {
      // The app was deleted since: pick again.
      if (ob.slug && !app) { ob.slug = null; obSave(); }
      if (ob.step > 1 && !ob.slug) ob.step = 1;
    }
    const body = ob.step === 0 ? obHello()
      : ob.step === 1 ? obAdd(app)
        : !app ? h('div', { class: 'ob-head' }, h('p', {}, 'Loading…'))
          : ob.step === 2 ? obKeys(app) : obPlans(app);
    return [obTop(), h('div', { class: 'ob-step', key: `step-${ob.step}-${ob.importing ? 'scan' : app ? 'app' : 'pick'}` }, body)];
  }

  function tourCard() {
    return h('section', { class: 'card narrow' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Getting started')),
      h('div', { class: 'card-body rows' },
        h('div', { class: 'line' },
          h('span', { class: 'tile' }, icon('rocket')),
          h('div', { class: 'grow' }, h('div', { class: 'name' }, 'Welcome tour'), h('div', { class: 'small' }, 'Add an app, connect the services it uses, and see what’s free, in four short steps.')),
          h('button', { class: 'btn', type: 'button', onclick: obStart }, 'Start tour'))));
  }

  // ---------- accounts ----------

  function keyDialog(a) {
    const mark = Board.logo(a.id);
    const big = (f) => f === 'APP_STORE_CONNECT_KEY' || f.endsWith('_JSON');
    const dlg = h('dialog', { class: 'modal', 'aria-label': `Connect ${a.label}` });
    // A key that can't be right is said here: a toast would sit behind the dialog.
    const err = h('div', { class: 'note-box bad', role: 'alert', hidden: true });
    const form = h('form', { onsubmit: (e) => {
      e.preventDefault();
      const values = Object.fromEntries(a.fields.map((f) => [f, String(new FormData(e.currentTarget).get(f) || '')]));
      err.hidden = true;
      busy(e.submitter, async () => {
        try {
          state.accounts = await post(`/api/accounts/${a.id}`, { values });
        } catch (x) {
          err.textContent = x.message;
          err.hidden = false;
          return;
        }
        dlg.close();
        toast(`${a.label} connected`);
        await refresh(true);
      });
    } },
    h('div', { class: 'modal-head' }, mark ? h('span', { class: 'head-tile brand' }, mark) : h('span', { class: 'head-tile' }, icon('key')), h('div', {}, h('h2', {}, `Connect ${a.label}`),
      h('p', { class: 'small' }, `Stored encrypted on the server. ${ai()} never sees the real value: its sandbox gets a placeholder that becomes the key only on the way to `, a.label, '.'))),
    a.fields.map((f) => h('label', { class: 'field' }, h('span', {}, f),
      big(f) ? h('textarea', { name: f, class: 'in', required: true, spellcheck: 'false', placeholder: a.hints?.[f] || '' })
        : h('input', { name: f, type: /ACCOUNT_ID|KEY_ID|ISSUER_ID/.test(f) ? 'text' : 'password', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: a.hints?.[f] || '' }))),
    err,
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
      if (C.me) Object.assign(C.me, { prefs: r.prefs, tiers: r.tiers });
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
    const choice = me.tiers.default;
    return h('section', { class: 'card narrow' },
      h('div', { class: 'card-head' }, h('h2', {}, `Runs with ${ai()}`)),
      h('div', { class: 'card-body' },
        tiers().length ? [
          h('div', { class: 'sec-head' }, h('span', { class: 'sec-title' }, 'Default mode')),
          h('div', { class: 'picker models', role: 'radiogroup', 'aria-label': 'Default mode' }, tiers().map((t) => h('label', { class: 'pick spot' + (t.id === choice ? ' on' : ''), key: t.id },
            h('input', { type: 'radio', name: 'default-tier', value: t.id, checked: t.id === choice, onchange: () => { C.tier = null; savePrefs({ tier: t.id }, `New runs start in ${t.label}`); } }),
            h('span', { class: 't' }, h('b', {}, t.label), h('span', { class: 'small' }, t.hint))))),
          h('p', { class: 'small' }, 'New runs start in this mode. You can still pick the other one when you start a run.'),
        ] : null,
        h('dl', { class: 'kv' },
          h('div', {}, h('dt', {}, 'Budget per run'), h('dd', {}, tok(me.limits.runBudgetTokens))),
          h('div', {}, h('dt', {}, 'Runs at once'), h('dd', {}, `Up to ${me.limits.maxRuns}`)),
          h('div', {}, h('dt', {}, 'Cloud runs on this server'), h('dd', {}, me.claude.ok ? h('span', { class: 'pill good sm' }, 'Ready') : h('span', { class: 'small', title: me.claude.why }, 'Not set up yet')))),
        h('p', { class: 'small powered' }, `${ai()} is Liftoff’s launch assistant. It runs on Claude, an AI model made by Anthropic.`)));
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
      h('li', {}, 'The keys you saved for Stripe, hosting and other services, here and in the vault your runs use'),
      h('li', {}, C.me.github.signedIn ? 'Your GitHub sign-in, and the access you gave Liftoff Cloud' : 'Your settings and sign-ins')),
    h('p', { class: 'small' }, `Your repositories, pull requests and the services ${ai()} set up stay as they are. So do the anonymous run records Liftoff learns from, which hold your app’s stack and how each step went, but no names, code or keys.`),
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
            ? `A run with ${ai()} is still going. Stop it first, then you can delete your account.`
            : 'Removes your apps, run history, saved keys and GitHub access from Liftoff Cloud. Your code and services stay as they are.')),
          h('button', { class: 'btn danger', type: 'button', disabled: open, onclick: deleteDialog }, icon('trash'), 'Delete account…'))));
  }

  function settingsView() {
    const head = h('div', { class: 'page-head narrow' }, h('div', {},
      h('h1', {}, 'Account settings'),
      h('p', {}, 'Your profile, how Liftoff Cloud looks, and how your runs start.')));
    if (!C.me) return [head, h('div', { class: 'card narrow empty' }, h('p', {}, 'Loading your settings…'))];
    return [head, profileCard(C.me), appearanceCard(), runsCard(C.me), C.me.admin ? recordsCard() : null, connectionsCard(C.me), tourCard(), sessionsCard(), dangerCard()];
  }

  // ---------- run records (admins only) ----------

  async function loadRecords(force = false) {
    if (!C.me?.admin) return;
    if (!force && C.recordsAt && Date.now() - C.recordsAt < 30000) return;
    C.recordsAt = Date.now();
    try {
      C.records = await api('/api/records');
      C.recordsError = null;
    } catch (e) {
      C.recordsError = e.message;
    }
  }

  const openRecords = () => {
    go('records');
    loadRecords(true).then(repaint);
  };

  function recordsCard() {
    return h('section', { class: 'card narrow' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Run records'), h('span', { class: 'end pill sm' }, 'Admin')),
      h('div', { class: 'card-body' },
        h('div', { class: 'line' },
          h('div', { class: 'grow' }, h('div', { class: 'small' }, 'How every run on this server went: success rates by stack and step, and what a step really costs in dollars. No names, code or keys.')),
          h('button', { class: 'btn', type: 'button', onclick: openRecords }, 'Open', icon('arrow')))));
  }

  const OUTCOME_WORD = { ...RUN_WORD, running: 'Still going' };
  const rate = (n, of) => (of ? `${Math.round((n / of) * 100)}%` : '–');

  function statTile(label, value, hint) {
    return h('div', { class: 'stat spot' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'hint' }, hint));
  }

  // cols: [{ label, cell(row), num }]
  function recTable(label, cols, rows) {
    return h('div', { class: 'table-scroll', role: 'region', 'aria-label': label, tabindex: '0' },
      h('table', { class: 'rec-table' },
        h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : '' }, c.label)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.num ? 'num' : '' }, c.cell(r))))))));
  }

  function recCard(title, count, body, sub) {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, title), count != null ? h('span', { class: 'count' }, count) : null, sub ? h('span', { class: 'end sub' }, sub) : null),
      h('div', { class: 'card-body' }, body));
  }

  function recordsView() {
    const r = C.records;
    const head = h('div', { class: 'page-head' },
      h('div', {},
        h('h1', {}, 'Run records'),
        h('p', {}, 'Every run on this server: the stack, how each step ended, the checklist before and after, and the real cost in dollars (people see tokens). No names, code or keys are kept. Only admins see this page.')),
      r?.total ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/api/records/export', download: '' }, icon('download'), 'Download all')) : null);
    if (!C.me) return [head, h('div', { class: 'card empty' }, h('p', {}, 'Loading…'))];
    if (!C.me.admin) return [head, h('div', { class: 'card empty' }, h('p', {}, 'Run records are only for the admins of this server.'))];
    if (C.recordsError && !r) return [head, h('div', { class: 'note-box bad' }, icon('x'), h('span', {}, C.recordsError))];
    if (!r) return [head, h('div', { class: 'card empty' }, h('p', {}, 'Loading the records…'))];
    if (!r.total) return [head, h('div', { class: 'card empty' }, h('p', {}, 'No runs recorded yet. Each run adds one when it starts, and fills it in when it stops.'))];

    const stats = h('section', { class: 'stats', 'aria-label': 'Totals' },
      statTile('Runs', String(r.total), `${Board.plural(r.apps, 'app')} since ${new Date(r.since).toLocaleDateString([], { month: 'short', day: 'numeric' })}`),
      statTile('Finished', rate(r.finished, r.ended), `${r.finished} of ${Board.plural(r.ended, 'run')} that stopped`),
      statTile('Cost per run', usd(r.avgCost), `${usd(r.cost)} in all`),
      statTile('Cost per step done', usd(r.costPerStep), Board.plural(r.stepsDone, 'step') + ' done'));

    const byStack = recCard('By stack', r.byStack.length, recTable('Runs by stack', [
      { label: 'Stack', cell: (x) => h('b', {}, x.label) },
      { label: 'Apps', num: true, cell: (x) => x.apps },
      { label: 'Runs', num: true, cell: (x) => x.runs },
      { label: 'Finished', num: true, cell: (x) => rate(x.finished, x.ended) },
      { label: 'Failed', num: true, cell: (x) => x.failed || '–' },
      { label: 'Per run', num: true, cell: (x) => usd(x.avgCost) },
      { label: 'Per step', num: true, cell: (x) => usd(x.costPerStep) },
      { label: 'Fails most', cell: (x) => (x.topFailure ? h('span', { class: 'small' }, `${x.topFailure.title} (${x.topFailure.n})`) : '–') },
    ], r.byStack));

    const bySteps = recCard('By step', r.bySteps.length, recTable('Runs by step', [
      { label: 'Step', cell: (x) => h('b', {}, x.label) },
      { label: 'Tried', num: true, cell: (x) => x.tried },
      { label: 'Done', num: true, cell: (x) => x.done },
      { label: 'Blocked', num: true, cell: (x) => x.blocked || '–' },
      { label: 'Success', num: true, cell: (x) => (x.rate == null ? '–' : h('span', { class: 'pill sm ' + (x.rate >= 80 ? 'good' : x.rate >= 50 ? 'warn' : 'bad') }, `${x.rate}%`)) },
      { label: 'Usually with', cell: (x) => (x.providers.length ? x.providers.map((p) => p.provider).join(', ') : '–') },
      { label: 'Why it got stuck', cell: (x) => (x.why.length ? h('span', { class: 'small' }, x.why[0].text) : '–') },
    ], r.bySteps), 'A step is tried when a run works on it and it wasn’t done yet');

    const byModel = recCard('By mode and model', null, recTable('Runs by mode and model', [
      { label: 'Mode · model', cell: (x) => h('b', {}, x.label) },
      { label: 'Runs', num: true, cell: (x) => x.runs },
      { label: 'Finished', num: true, cell: (x) => rate(x.finished, x.ended) },
      { label: 'Per run', num: true, cell: (x) => usd(x.avgCost) },
      { label: 'Per step', num: true, cell: (x) => usd(x.costPerStep) },
    ], r.byModel));

    const failures = recCard('Checks still failing after a run', r.failures.length, r.failures.length
      ? h('div', { class: 'rows' }, r.failures.map((f) => h('div', { class: 'line' },
        h('div', { class: 'grow' }, h('div', { class: 'name' }, f.title), f.example ? h('div', { class: 'small' }, f.example) : null),
        h('span', { class: 'count' }, f.n))))
      : h('p', { class: 'small' }, 'None so far.'));

    const errors = recCard('Errors runs hit most', r.errors.length, r.errors.length
      ? h('div', { class: 'rows' }, r.errors.map((e) => h('div', { class: 'line' }, h('div', { class: 'grow small mono' }, e.text), h('span', { class: 'count' }, e.n))))
      : h('p', { class: 'small' }, 'None so far.'));

    const recent = recCard('Latest runs', null, h('div', { class: 'rows' }, r.recent.map((x) => h('div', { class: 'line' },
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, x.steps.length ? x.steps.map((st) => st.label).join(', ') : 'No step changed'),
        h('div', { class: 'small' }, [x.stack, x.model, ago(x.at), usd(x.cost), x.minutes != null ? (x.minutes < 1 ? 'under a minute' : `${Math.round(x.minutes)} min`) : null, x.errors ? Board.plural(x.errors, 'error') : null].filter(Boolean).join(' · '))),
      h('span', { class: 'pill sm ' + (RUN_TONE[x.outcome] || '') }, OUTCOME_WORD[x.outcome] || x.outcome)))));

    return [head, stats, byStack, bySteps, h('div', { class: 'rec-grid' }, failures, errors), byModel, recent];
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
        h('div', { class: 'small' }, 'Launch run'),
        h('h2', {}, r.status === 'needs-you' ? `${ai()} needs you (${r.pending})` : r.status === 'budget' ? 'Paused at its budget' : `${ai()} is working on this app`),
        h('p', {}, `Started ${ago(r.createdAt)}${r.tokens === null ? '' : ` · ${tok(r.tokens)} so far`}`)),
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

  // The Launch Pass (lib/billing.mjs): one payment per app opens cloud runs,
  // the purchase test and launch reports. The scan, verify and the readiness
  // score stay free, and this card shows them as the reason to buy.
  const usd0 = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  // How far the pass's tokens go: a run checks with you before it passes
  // its own budget, so the pass covers at least this many runs.
  const passTokens = (price) => {
    const runs = price.runTokens ? Math.floor(price.tokens / price.runTokens) : 0;
    return runs >= 2 ? `${tok(price.tokens)} for runs included, at least ${runs} runs (each one asks before going past ${num(price.runTokens)})` : `${tok(price.tokens)} for runs included`;
  };
  const locked = (app) => !!app.cloud?.pass && !app.cloud.pass.unlocked;
  // Tokens left on the app's pass (Infinity when payments are off or free).
  const tokensLeft = (app) => app.cloud?.pass?.pass?.tokens?.left ?? Infinity;
  const usedUp = (app) => !!app.cloud?.pass?.pass?.tokens?.usedUp;
  const buyPass = (slug) => (e) => busy(e.currentTarget, async () => {
    const { url } = await post(`/api/apps/${slug}/pass`);
    location.href = url;
  });
  const passHint = () => h('span', { class: 'small pass-hint' }, icon('rocket'), 'Part of the Launch Pass');

  function passCard(app) {
    const p = app.cloud?.pass;
    if (!p?.enabled || p.free) return null;
    if (p.pass) {
      const t = p.pass.tokens;
      // The bar counts what open runs may still spend too, like what's left does.
      const share = t.included ? Math.min(100, Math.round((100 * (t.included - t.left)) / t.included)) : 100;
      return h('section', { class: 'card pass on' },
        h('div', { class: 'card-head' }, icon('rocket'), h('h2', {}, 'Launch Pass'), h('span', { class: 'pill sm good' }, 'Active'), h('span', { class: 'end sub' }, `Bought ${ago(p.pass.at)}`)),
        h('div', { class: 'card-body' },
          h('div', { class: 'pass-meter' },
            h('div', { class: 'small' }, [`${num(t.used)} of ${tok(t.included)} used`, t.held ? `${num(t.held)} held for the run going now` : null, `${num(t.left)} left`].filter(Boolean).join(' · ')),
            h('div', { class: `bar${share >= 90 ? ' low' : ''}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(t.included), 'aria-valuenow': String(t.included - t.left), 'aria-label': 'Tokens used or held for runs' }, h('span', { class: `fill w${Math.round(share / 5) * 5}` }))),
          t.usedUp ? h('div', { class: 'row' },
            h('span', { class: 'small grow' }, `The tokens on this pass are used up. Another pass adds ${tok(p.price.tokens)}.`),
            h('button', { class: 'btn', onclick: buyPass(app.slug) }, icon('rocket'), `Add a pass · ${usd0(p.price.usd)}`)) : null));
    }
    const now = app.cloud?.report?.now;
    const scanIds = new Set((app.cloud?.scan?.failing || []).map((f) => f.id));
    const problems = app.checklist.filter((c) => c.verify?.ok === false || scanIds.has(c.id)).slice(0, 3);
    return h('section', { class: 'card pass' },
      h('div', { class: 'card-head' }, icon('rocket'), h('h2', {}, 'Launch Pass'), h('span', { class: 'end sub' }, `${usd0(p.price.usd)} once, for this app`)),
      h('div', { class: 'card-body pass-body' },
        h('div', { class: 'pass-free' },
          now ? h('div', { class: 'report-score' }, h('div', { class: 'num' }, String(now.score), h('span', {}, '/100')), h('div', { class: 'small' }, 'Launch score: what Liftoff has proven so far, free from the scan and verify')) : null,
          problems.length ? [
            h('div', { class: 'k' }, 'Top problems found'),
            h('ul', { class: 'report-missing' }, problems.map((c) => h('li', { key: c.id }, icon('x'), h('span', {}, c.title)))),
          ] : null),
        h('div', { class: 'pass-buy' },
          h('div', { class: 'k' }, 'The pass adds'),
          h('ul', { class: 'pass-list' },
            p.includes.map((x) => h('li', { key: x }, icon('check'), h('span', {}, x))),
            h('li', { key: 'tokens' }, icon('check'), h('span', {}, passTokens(p.price)))),
          p.later ? h('p', { class: 'small pass-later' }, p.later) : null,
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', onclick: buyPass(app.slug) }, icon('rocket'), `Get the Launch Pass · ${usd0(p.price.usd)}`)),
          p.testMode ? h('p', { class: 'small pass-test' }, 'Stripe test mode: pay with 4242 4242 4242 4242, any future date and any CVC.') : null)));
  }

  // Liftoff's own purchase test: its browser buys Pro on the app's test-mode
  // deploy, and Stripe's records decide. Screenshots open full size.
  const PROOF_WORD = { queued: 'Waiting its turn', running: 'Testing', passed: 'Passed', failed: 'Failed', error: "Didn't finish" };
  const PROOF_TONE = { queued: 'run', running: 'run', passed: 'good', failed: 'bad', error: 'warn' };
  const PROOF_NEXT = ['Opening the app', 'Signing up', 'Paying with the test card', 'Waiting for Pro to unlock', 'Cancelling in Stripe', 'Waiting for Pro to lock', "Checking Stripe's records"];
  const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };

  function proofCard(app) {
    const p = app.cloud?.proof;
    if (!p || !p.applies) return null;
    const last = p.latest;
    const live = !!last && (last.status === 'queued' || last.status === 'running');
    const steps = last?.steps || [];
    const start = (e) => busy(e.currentTarget, async () => {
      await post(`/api/apps/${app.slug}/proof`);
      toast('Purchase test started. It takes a few minutes.');
      await refresh(true);
    });
    const when = !last ? 'Not run yet' : live ? `Started ${ago(last.startedAt || last.createdAt)}` : ago(last.endedAt || last.createdAt);
    return h('section', { class: 'card proof' },
      h('div', { class: 'card-head' }, icon('shield'), h('h2', {}, 'Purchase test'),
        last ? h('span', { class: `pill sm ${PROOF_TONE[last.status] || ''}` }, live ? h('span', { class: 'd' }) : null, PROOF_WORD[last.status] || last.status) : null,
        h('span', { class: 'end sub' }, when)),
      h('div', { class: 'card-body' },
        h('p', { class: 'small proof-what' }, `Liftoff opens ${hostOf(p.url) || 'your test-mode deploy'} in its own browser, signs up as a new user, buys Pro with Stripe’s test card, cancels, and checks Pro locks again. Stripe’s records decide the result.`),
        p.blocker ? h('p', { class: 'proof-block' }, p.blocker) : null,
        steps.length || live ? h('ol', { class: 'proof-steps' },
          steps.map((s, i) => h('li', { key: `${last.id}:${i}`, class: s.ok ? 'ok' : 'no' },
            icon(s.ok ? 'checkCircle' : 'x'),
            h('div', { class: 'grow' }, h('div', { class: 'name' }, s.label || s.name), h('div', { class: 'small' }, s.detail)),
            s.shot ? h('a', { class: 'shot', href: s.shot, target: '_blank', rel: 'noopener', title: `Open the screenshot: ${s.label}` }, h('img', { src: s.shot, alt: `Screenshot: ${s.label}`, loading: 'lazy' })) : null)),
          live ? h('li', { key: `${last.id}:next`, class: 'now' }, icon('spinner'), h('div', { class: 'grow' }, h('div', { class: 'name' }, last.status === 'queued' ? 'Waiting for the test browser' : `${PROOF_NEXT[steps.length] || 'Finishing'}…`))) : null) : null,
        last && !live && last.status === 'error' ? h('p', { class: 'small proof-block' }, last.detail) : null,
        h('div', { class: 'row' }, h('button', { class: `btn${last?.status === 'passed' ? '' : ' primary'}`, disabled: !!p.blocker || live || locked(app), onclick: start }, icon('play'), live ? 'Testing…' : last ? 'Run it again' : 'Run the purchase test'),
          locked(app) ? passHint() : null)));
  }

  // The launch report: a dated public page of what Liftoff proved, and the
  // badge for the app's site that links to the newest one.
  const longDay = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const badgeCode = (b) => `<a href="${b.url}"><img src="${b.image}" alt="Liftoff launch report" height="20"></a>`;
  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      toast('Select the code in the box and copy it.');
    }
  }

  function reportCard(app) {
    const r = app.cloud?.report;
    if (!r) return null;
    const { now, latest, badge } = r;
    const c = now.counts;
    const create = (e) => busy(e.currentTarget, async () => {
      toast('Running every check again for the report…');
      await post(`/api/apps/${app.slug}/report`);
      await refresh(true);
      const made = appOf(app.slug)?.cloud?.report?.latest;
      toast(made?.certified ? 'Launch certified. The report and your badge are updated.' : 'Report made. It lists what’s left to prove.');
    });
    const takeDown = (id) => (e) => busy(e.currentTarget, async () => {
      if (!confirm('Take this report down? Its link stops working.')) return;
      await api(`/api/apps/${app.slug}/report/${id}`, { method: 'DELETE' });
      toast('Report taken down');
      await refresh(true);
    });
    const missing = now.missing.slice(0, 6);
    return h('section', { class: 'card report' },
      h('div', { class: 'card-head' }, icon('flag'), h('h2', {}, 'Launch report'),
        h('span', { class: `pill sm${now.certified ? ' good' : ''}` }, !now.certified ? 'Not certified yet' : latest?.certified ? 'Certified' : 'Ready to certify'),
        h('span', { class: 'end sub' }, latest ? `Last report ${ago(latest.at)}` : 'No report yet')),
      h('div', { class: 'card-body' },
        h('p', { class: 'small report-what' }, 'A dated page anyone with the link can open: every check, the evidence and a score. It says “Launch certified” only when every required check ran on Liftoff’s server and passed.'),
        h('div', { class: 'report-score' },
          h('div', { class: 'num' }, String(now.score), h('span', {}, '/100')),
          h('div', { class: 'small' }, [`${c.proven} proven by Liftoff`, c.reported ? `${c.reported} marked done by hand` : null, c.failed ? `${c.failed} failing` : null, `${c.unproven + c.open} to go`].filter(Boolean).join(' · '))),
        !now.certified && missing.length ? h('ul', { class: 'report-missing' },
          missing.map((m) => h('li', { key: m }, icon('circle'), h('span', {}, m))),
          now.missing.length > missing.length ? h('li', { key: 'more', class: 'more' }, h('span', {}, `and ${now.missing.length - missing.length} more`)) : null) : null,
        now.unnamed ? h('p', { class: 'small report-what' }, `The public page counts ${now.unnamed === 1 ? 'the security check' : `the ${now.unnamed} security checks`} that haven’t passed without naming ${now.unnamed === 1 ? 'it' : 'them'}, so it doesn’t point anyone at a weakness.`) : null,
        h('div', { class: 'row' },
          h('button', { class: `btn${now.certified || !latest ? ' primary' : ''}`, disabled: locked(app), onclick: create }, icon('flag'), latest ? 'Make a new report' : 'Make the report'),
          locked(app) ? passHint() : null,
          latest ? h('a', { class: 'btn', href: latest.url, target: '_blank', rel: 'noopener' }, 'Open the report', icon('external')) : null),
        badge ? h('div', { class: 'report-badge' },
          h('div', { class: 'k' }, 'Badge for your site'),
          h('div', { class: 'small' }, latest?.certified ? `Shows “launch certified” with the date of the newest report, and links to it.` : 'Shows “launch report” until a report is certified, then the date. It links to the newest report.'),
          h('div', { class: 'row' },
            h('img', { class: 'badge-img', src: `${new URL(badge.image).pathname}?v=${latest?.id || 'none'}`, alt: 'Your Liftoff badge', height: '20' }),
            h('span', { class: 'small grow' }, `${badge.clicks} ${badge.clicks === 1 ? 'visit' : 'visits'} from the badge`)),
          h('div', { class: 'row' },
            h('input', { class: 'in mono grow', type: 'text', readonly: true, value: badgeCode(badge), 'aria-label': 'Badge code', onfocus: (e) => e.currentTarget.select() }),
            h('button', { class: 'btn', onclick: () => copyText(badgeCode(badge), 'Copied the badge code. Paste it into your site’s footer.') }, icon('copy'), 'Copy'))) : null,
        r.history.length > 1 ? h('details', { class: 'report-history' },
          h('summary', {}, `Earlier reports (${r.history.length - 1})`),
          h('ul', {}, r.history.slice(1).map((x) => h('li', { key: x.id },
            h('span', { class: `pill sm${x.certified ? ' good' : ''}` }, x.certified ? 'Certified' : 'Not certified'),
            h('a', { class: 'grow', href: x.url, target: '_blank', rel: 'noopener' }, `${longDay(x.at)} · score ${x.score}`),
            h('button', { class: 'btn sm ghost', title: 'Take this report down', 'aria-label': 'Take this report down', onclick: takeDown(x.id) }, icon('trash')))))) : null,
        latest ? h('p', { class: 'small report-down' }, h('button', { class: 'link', onclick: takeDown(latest.id) }, 'Take the newest report down')) : null));
  }

  // An app that's already live: its address, so the free Verify can check
  // hosting, HTTPS and the legal pages without a run. Saving it empty removes it.
  function liveForm(app) {
    const id = `live-${app.slug}`;
    const save = (e) => {
      e.preventDefault();
      const url = e.currentTarget.elements.url.value.trim();
      if (url === (app.liveUrl || '')) return;
      busy(e.submitter, async () => {
        await post(`/api/apps/${app.slug}/live`, { url });
        toast(url ? 'Saved. Press Verify to check the live site.' : 'Live address removed');
        await refresh(true);
      });
    };
    return h('form', { class: 'live-form', onsubmit: save },
      h('label', { class: 'k', for: id }, app.liveUrl ? 'Live address' : 'Already live?'),
      app.liveUrl ? null : h('div', { class: 'small' }, 'Add its address so Verify can check hosting, HTTPS and the privacy and terms pages.'),
      h('div', { class: 'row' },
        h('input', { id, name: 'url', class: 'in grow', type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://myapp.com', value: app.liveUrl || '' }),
        h('button', { class: 'btn', type: 'submit', 'aria-label': 'Save the live address' }, 'Save')));
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
          class: 'in', type: 'text', value: app.config[k] || '', 'aria-label': k, placeholder: { 'health.path': '/api/health', 'signup.path': '/signup', 'preview.url': 'https://my-app-git-main.vercel.app' }[k] || '',
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
    const picked = tiers().some((t) => t.id === C.tier) ? C.tier : C.me?.tiers?.default;
    const mode = app.cloud?.source?.type === 'github' && C.me?.github.token ? 'github' : 'upload';
    const start = (e) => busy(e.currentTarget, async () => {
      await startRun(app.slug, { steps: chosen.map((s) => s.id), note: C.note, tier: picked });
      C.note = '';
    });
    return h('section', { class: 'card launch' },
      h('div', { class: 'launch-top' },
        orb('idle', true),
        h('div', { class: 'grow' },
          h('h2', {}, 'Start a run'),
          h('p', {}, `${ai()} works in a private cloud sandbox with a copy of your code, following the same skills as the Liftoff plugin. It asks you here before anything that spends money, changes DNS or goes live.`),
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
        tiers().length > 1 ? [
          h('div', { class: 'sec-head' }, h('span', { class: 'sec-title' }, 'Mode')),
          h('div', { class: 'picker models', role: 'radiogroup', 'aria-label': 'Mode' }, tiers().map((t) => h('label', { class: 'pick spot' + (t.id === picked ? ' on' : ''), key: t.id },
            h('input', { type: 'radio', name: 'run-tier', value: t.id, checked: t.id === picked, onchange: () => { C.tier = t.id; render(); } }),
            h('span', { class: 't' }, h('b', {}, t.label, t.id === C.me.tiers.default ? h('span', { class: 'hint' }, ' (default)') : null), h('span', { class: 'small' }, t.hint))))),
        ] : null,
        h('label', { class: 'field' }, h('span', {}, `Note for ${ai()} `, h('span', { class: 'hint' }, '(optional)')),
          h('textarea', { class: 'in', oninput: (e) => { C.note = e.currentTarget.value; }, placeholder: `Anything ${ai()} should know? e.g. "Use Cloudflare, not Vercel" or "Price Pro at $8/month"`, 'aria-label': `Note for ${ai()}`, maxlength: '1000' }, C.note || '')),
        locked(app) ? h('div', { class: 'launch-go' },
          h('button', { class: 'btn primary big', type: 'button', onclick: buyPass(app.slug) }, icon('rocket'), `Get the Launch Pass · ${usd0(app.cloud.pass.price.usd)}`),
          h('span', { class: 'small' }, `Cloud runs are part of the Launch Pass, with ${tok(app.cloud.pass.price.tokens)} included.`))
        : h('div', { class: 'launch-go' },
          h('button', { class: 'btn primary big', type: 'button', disabled: !C.me?.claude.ok || !chosen.length || usedUp(app), onclick: start }, icon('play'), chosen.length === left.length ? 'Start the launch' : `Run ${chosen.length} step${chosen.length === 1 ? '' : 's'}`),
          h('span', { class: 'small' }, tokensLeft(app) === Infinity ? `Budget ${tok(C.me?.limits.runBudgetTokens)} per run` : usedUp(app) ? 'This app’s tokens are used up.' : `Up to ${tok(Math.min(C.me?.limits.runBudgetTokens ?? Infinity, tokensLeft(app)))} for this run · ${tok(tokensLeft(app))} left on the pass`))));
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
        h('div', { class: 'ask-top' }, h('span', { class: 'ask-badge' }, icon('flag'), `${ai()} asks`), h('time', {}, ago(p.at))),
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
        h('span', { class: 'ask-badge' }, icon(p.kind === 'secret' ? 'key' : 'shield'), p.kind === 'secret' ? 'Copy a key to GitHub' : `${ai()} asks before using ${p.tool}`),
        h('time', {}, ago(p.at))),
      h('div', { class: 'ask-q' }, p.text),
      p.detail && p.kind === 'approval' ? h('pre', { class: 'cmd' }, p.detail) : null,
      h('div', { class: 'ask-actions' },
        h('button', { class: 'btn good', type: 'button', onclick: (e) => decide(run, p, true, e) }, icon('check'), 'Allow'),
        h('button', { class: 'btn', type: 'button', onclick: (e) => decide(run, p, false, e) }, 'Decline'),
        h('input', { class: 'in grow', name: 'reason', type: 'text', placeholder: `Why not? (optional, shown to ${ai()})`, 'aria-label': 'Reason' })));
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
        h('div', { class: 'ask-q' }, `This run used its budget of ${tok(run.budgetTokens)} and paused.`),
        h('div', { class: 'ask-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: (e) => busy(e.currentTarget, async () => { C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/budget`, { addTokens: topUp() }); render(); }) }, `Add ${tok(topUp())} and continue`))) });
    }
    // Tool work still going on: the newest group shows a spinner.
    const tail = rows[rows.length - 1];
    if (tail?.group) tail.working = working;
    if (working) {
      rows.push({ side: 'claude', key: 'typing', node: h('div', { class: 'bubble typing', role: 'status' },
        h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
        h('span', { class: 'shimmer' }, run.status === 'starting' ? 'Setting up the sandbox' : `${ai()} is working`)) });
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
        h('div', { class: 'col' }, first && r.side === 'claude' && r.key !== 'typing' ? h('div', { class: 'who-line' }, ai()) : null, r.node)));
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
    const placeholder = run.status === 'needs-you' ? `Answer ${ai()} above first`
      : run.status === 'budget' ? 'Raise the budget to keep going'
        : run.status === 'starting' ? `${ai()} is setting up…`
          : live ? `Message ${ai()}…` : `Message ${ai()} to keep going…`;
    const status = run.status === 'starting' ? 'Setting up a private sandbox'
      : run.status === 'running' ? 'Working on your app'
        : run.status === 'needs-you' ? `Waiting on you (${run.pending.length})`
          : run.status === 'budget' ? 'Paused at its budget'
            : run.status === 'finished' ? 'Finished. Send a message to keep going.'
              : RUN_WORD[run.status] || run.status;
    const thread = h('div', {
      class: 'thread', role: 'log', 'aria-live': 'polite', 'aria-label': `Conversation with ${ai()}`, tabindex: '0',
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
        h('div', { class: 'grow' }, h('div', { class: 'chat-name' }, ai(), run.tier ? h('span', { class: 'pill sm' }, tierLabel(run.tier)) : null), h('div', { class: 'small' }, status)),
        runPill(run.status, true)),
      h('div', { class: 'thread-wrap' }, thread,
        h('button', { class: 'jump', type: 'button', onclick: () => scrollToEnd(true), tabindex: C.stick ? '-1' : '0' }, icon('arrowDown'), 'Latest')),
      h('form', { class: 'composer', onsubmit: (e) => sendMessage(run, e) },
        h('div', { class: 'composer-box' + (disabled ? ' off' : '') },
          h('textarea', {
            class: 'in', rows: '1', placeholder, 'aria-label': `Message ${ai()}`, disabled,
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
    const spent = run.budgetTokens ? Math.min(100, ((run.tokens || 0) / run.budgetTokens) * 100) : 0;
    const ids = run.steps.length ? run.steps : null;
    const STEP_I = { done: 'checkCircle', skipped: 'minus', running: 'spinner', blocked: 'x' };
    return h('section', { class: 'card run-info' },
      h('div', { class: 'card-head' }, h('h2', {}, 'This run'), h('span', { class: 'end' }, h('span', { class: 'sub' }, `Started ${ago(run.createdAt)}`))),
      h('div', { class: 'card-body' },
        h('div', { class: 'spend' },
          h('div', { class: 'spend-top' }, h('span', { class: 'spend-n' }, num(run.tokens)), h('span', { class: 'small' }, `tokens of a ${num(run.budgetTokens)}-token budget`)),
          h('div', { class: 'meter', role: 'meter', 'aria-label': 'Tokens used', 'aria-valuemin': '0', 'aria-valuemax': String(run.budgetTokens || 0), 'aria-valuenow': String(run.tokens || 0) }, h('span', { class: 'ok', style: { width: `${Math.max(spent, run.tokens ? 2 : 0)}%` } }))),
        h('dl', { class: 'kv' },
          h('div', {}, h('dt', {}, 'Mode'), h('dd', {}, run.tier ? tierLabel(run.tier) : '–')),
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
    if (!app) return h('div', { class: 'card empty' }, h('div', { class: 'tile' }, icon('play')), h('h2', {}, 'Pick an app'), h('p', {}, `Open an app and choose Run with ${ai()}.`));
    const run = C.run;
    const head = h('div', { class: 'page-head run-head' },
      Board.avatar(app, true),
      h('div', { class: 'grow' }, h('h1', {}, app.name), h('p', {}, run ? (run.steps.length ? run.steps.map((id) => stepLabel(app, id)).join(', ') : 'All remaining steps') : 'Launch run')),
      h('div', { class: 'actions' },
        run && LIVE.has(run.status) ? h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { C.run = await post(`/api/apps/${C.slug}/runs/${run.id}/stop`); render(); }) }, icon('stop'), 'Stop') : null,
        run && !OPEN.has(run.status) && strongest() && run.tier !== strongest() && tiers().some((t) => t.id === strongest()) && C.me?.claude.ok
          ? h('button', { class: 'btn', title: `Start a new run for the same steps in ${tierLabel(strongest())} mode`, onclick: (e) => busy(e.currentTarget, () => startRun(C.slug, { steps: run.steps, note: run.note || '', tier: strongest() })) }, icon('refresh'), `Try again with ${tierLabel(strongest())}`) : null,
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
          h('div', { class: 'small' }, `${ago(r.createdAt)} · ${tok(r.tokens)}`)),
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
      const records = state.view === 'records' ? me.then(() => loadRecords()) : null;
      await Promise.all([me, run, records]);
      return true;
    },
    views: {
      add: { title: 'Add an app', render: addView },
      welcome: { title: 'Welcome', render: welcomeView },
      settings: { title: 'Account settings', render: settingsView },
      records: { title: 'Run records', render: recordsView },
      run: { get title() { const a = appOf(C.slug); return a ? `${a.name} · Launch run` : 'Launch run'; }, render: runView, key: () => `${C.slug}:${C.loading ? 'loading' : C.run?.id || 'new'}` },
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
      if (r.status === 'needs-you') return h('span', { class: 'pill warn sm', title: `${ai()} needs you` }, '!');
      if (r.status === 'running' || r.status === 'starting') return h('span', { class: 'status-dot run', title: `${ai()} is working` });
      return null;
    },
    emptyOverview: () => [
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Welcome to Liftoff Cloud'),
        h('p', {}, `Add your app to see what stands between it and real users. Then let ${ai()} set it up, step by step, in the cloud.`))),
      addForms(),
      h('div', { class: 'row tour-nudge' }, h('span', { class: 'small' }, 'New here?'), h('button', { class: 'btn quiet sm', type: 'button', onclick: obStart }, icon('play'), 'Take the two-minute tour')),
    ],
    overviewIntro: (apps) => `${Board.plural(apps.length, 'app')} in Liftoff Cloud. Here is what needs you first.`,
    overviewActions: () => h('button', { class: 'btn primary', onclick: () => go('add') }, icon('plus'), 'Add an app'),
    accountAction,
    accountsIntro: () => `Add a key once and all your apps can use it. Keys are encrypted on the server, and ${ai()}’s sandbox only sees placeholders that turn into the real key on the way to that service.`,
    // Checklist items the assistant ticked say so by its name.
    whoTicked: (by) => (by === 'claude' ? ai() : null),
    heroMeta: sourceLine,
    heroActions: (app) => [
      h('button', { class: 'btn', title: 'Fetch the code again and rescan it', onclick: (e) => busy(e.currentTarget, async () => { toast('Rescanning…'); await post(`/api/apps/${app.slug}/rescan`); await refresh(true); toast('Rescanned'); }) }, icon('refresh'), 'Rescan'),
      h('button', { class: 'btn primary', onclick: () => openRun(app.slug, app.cloud?.run && OPEN.has(app.cloud.run.status) ? app.cloud.run.id : null) }, icon('play'), app.cloud?.run && OPEN.has(app.cloud.run.status) ? 'Open run' : `Run with ${ai()}`),
    ],
    afterHero: (app) => [runCard(app), passCard(app), scanCard(app), proofCard(app), reportCard(app)],
    nextActionButton: (app, a) => (a.skill || a.command ? h('button', { class: 'btn', onclick: () => {
      const ids = app.steps.filter((s) => s.skill === a.skill && !['done', 'skipped'].includes(s.status)).map((s) => s.id);
      openRun(app.slug).then(() => { if (ids.length && !C.run) { C.pick = Object.fromEntries(app.steps.map((s) => [s.id, ids.includes(s.id)])); render(); } });
    } }, icon('play'), `Do it with ${ai()}`) : null),
    stepsHeadEnd: (app) => h('button', { class: 'btn', onclick: () => openRun(app.slug) }, icon('play'), `Run with ${ai()}`),
    mainBottom: settingsCard,
    deploysFoot: liveForm,
    popstate: obPopped,
    afterRender: () => {
      document.body.classList.toggle('ob-on', state.view === 'welcome');
      // A new account with no apps starts on the welcome tour, once.
      if (!C.obChecked && C.me && state.lastSync) {
        C.obChecked = true;
        if (!C.me.prefs?.onboarded && !state.apps.length && state.view === 'overview') queueMicrotask(obStart);
      }
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

  // Back from Stripe Checkout.
  const back = new URLSearchParams(location.search).get('pass');
  if (back) {
    history.replaceState(null, '', location.pathname + location.hash);
    const said = { ok: 'Launch Pass active. Runs, the purchase test and reports are open for this app.', pending: 'Stripe is still confirming the payment. The pass turns on as soon as it does.', error: 'Couldn’t confirm that checkout. If you paid, the pass turns on once Stripe tells Liftoff.' }[back];
    if (said) setTimeout(() => toast(said), 600);
  }

  Board.start();
})();
