// Flight Board front end, shared by the local dashboard (lib/server.mjs)
// and Liftoff Cloud (cloud/). A host page adds views and controls with
// Board.configure({ ...hooks }) and then calls Board.start(); the local page has no
// hooks and starts on its own.
//
// Rendering builds fresh nodes with h() and then patches the live DOM to match
// (see patch() below) instead of replacing it, so the few-second refresh keeps
// hover, focus, scroll and running transitions, and only new things animate in.
const state = { apps: [], accounts: [], view: 'overview', selected: null, open: {}, lastSync: null };
const HOOKS = {};
const hook = (name, ...args) => (typeof HOOKS[name] === 'function' ? HOOKS[name](...args) : undefined);
const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) p.startsWith('--') ? el.style.setProperty(p, x) : (el.style[p] = x);
    else if (k === 'key') el.setAttribute('data-key', v);
    else if (k.startsWith('on')) {
      (el.__on ||= {})[k.slice(2)] = v;
      el.addEventListener(k.slice(2), dispatch);
    }
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
// Handlers live on the element so a patch can swap them without re-binding.
function dispatch(e) {
  const f = this.__on && this.__on[e.type];
  return f ? f.call(this, e) : undefined;
}

// ---------- patching ----------
// polling: a background refresh is rendering, so leave typed-in fields alone.
let polling = false;
const HANDLER_PROPS = ['onclick', 'onchange', 'oninput', 'onkeydown', 'onsubmit', 'ondragover', 'ondragleave', 'ondrop', 'onscroll', 'ontoggle', 'onfocus', 'onblur'];
const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute('data-key') : null);
const asNodes = (kids) => kids.flat(Infinity).filter((k) => k != null && k !== false).map((k) => (k instanceof Node ? k : document.createTextNode(String(k))));

// Make parent's children match kids, reusing live nodes where they line up
// (by data-key when given, else by position and tag).
function morph(parent, kids) {
  const want = asNodes([kids]);
  const old = [...parent.childNodes];
  const byKey = new Map();
  for (const n of old) if (keyOf(n) !== null) byKey.set(keyOf(n), n);
  const used = new Set();
  let i = 0;
  const next = want.map((n) => {
    const k = keyOf(n);
    let match = null;
    if (k !== null) {
      const o = byKey.get(k);
      if (o && o.nodeName === n.nodeName && !used.has(o)) match = o;
    } else {
      while (i < old.length && (used.has(old[i]) || keyOf(old[i]) !== null)) i++;
      if (i < old.length && old[i].nodeName === n.nodeName) match = old[i++];
    }
    if (!match) return n;
    used.add(match);
    patch(match, n);
    return match;
  });
  for (const n of old) if (!used.has(n)) n.remove();
  next.forEach((n, idx) => {
    const at = parent.childNodes[idx];
    if (at !== n) parent.insertBefore(n, at || null);
  });
}

function patch(a, b) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  for (const { name } of [...a.attributes]) if (name !== 'style' && !b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (name !== 'style' && a.getAttribute(name) !== value) a.setAttribute(name, value);
  // Styles go through the CSSOM, since the cloud's CSP blocks style attributes
  // set as text. The cursor-spotlight position (--mx/--my) stays on the live node.
  for (const prop of [...a.style]) if (prop !== '--mx' && prop !== '--my' && !b.style.getPropertyValue(prop)) a.style.removeProperty(prop);
  for (const prop of b.style) {
    const v = b.style.getPropertyValue(prop);
    if (a.style.getPropertyValue(prop) !== v) a.style.setProperty(prop, v, b.style.getPropertyPriority(prop));
  }
  a.__on = b.__on;
  for (const t of Object.keys(b.__on || {})) a.addEventListener(t, dispatch);
  for (const p of HANDLER_PROPS) if (a[p] !== b[p]) a[p] = b[p];
  const tag = a.nodeName;
  if (tag !== 'TEXTAREA') morph(a, [...b.childNodes]);
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (a.type === 'checkbox' || a.type === 'radio') { if (a.checked !== b.checked) a.checked = b.checked; }
    else if (a.type !== 'file' && !polling && a.value !== b.value) a.value = b.value;
  }
}

// Small inline icon set (stroke icons, 24px grid).
const ICONS = {
  rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3s-2.2-.8-3 0z"/><path d="M9 12a22 22 0 0 1 11-9c0 3-1 7.5-9 11z"/><path d="M9 12H4s.5-3 2-4c1.6-1 5 0 5 0"/><path d="M12 15v5s3-.5 4-2c1-1.6 0-5 0-5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
  minus: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
};
function icon(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

// A service's own logo (dashboard/logos.js), or null when there isn't one.
// Each use gets its own gradient ids, since an id that's on the page twice
// can paint from a copy that's hidden.
let logoUses = 0;
function logo(id) {
  const l = window.LiftoffLogos?.[id];
  if (!l) return null;
  const [vb, body] = l;
  const [, , w, h] = vb.split(' ').map(Number);
  const n = ++logoUses;
  const span = document.createElement('span');
  span.innerHTML = `<svg class="logo logo-${id}${w / h > 1.5 ? ' wide' : ''}" viewBox="${vb}" aria-hidden="true">${body.replace(/(id="|url\(#)([\w-]+)/g, `$1$2-${n}`)}</svg>`;
  return span.firstChild;
}
const initials = (label) => label.split(/\s|\(/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
// The square in front of a service's name: its logo, else its initials.
function serviceTile(a) {
  const mark = logo(a.id);
  return mark ? h('span', { class: 'tile brand' }, mark) : h('span', { class: 'tile' }, initials(a.label));
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401 && HOOKS.unauthorized) return hook('unauthorized');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

// ---------- helpers ----------
const PALETTE = ['#57534e', '#10b981', '#f97316', '#db2777', '#3b82f6', '#ca8a04', '#0d9488', '#e11d48'];
function colorFor(slug) { let n = 0; for (const c of slug) n = (n * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[n % PALETTE.length]; }
function avatar(app, lg) { return h('span', { class: 'avatar' + (lg ? ' lg' : ''), style: { '--c': colorFor(app.slug) }, 'aria-hidden': 'true' }, app.name[0].toUpperCase()); }
function host(url) { try { return new URL(url).host; } catch { return url; } }
function doneCount(a) { return a.stepsDone + a.checksDone; }
function totalCount(a) { return a.stepsTotal + a.checksTotal; }
function pct(a) { return totalCount(a) ? Math.round((doneCount(a) / totalCount(a)) * 100) : 0; }
function toDo(a) { return totalCount(a) - doneCount(a) + a.openTasks; }
function plural(n, one, many = one + 's') { return `${n} ${n === 1 ? one : many}`; }
function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const PLATFORM = { web: 'Web', ios: 'iOS', android: 'Android' };

function appStatus(a) {
  if (a.readyForRelease) return h('span', { class: 'pill good' }, icon('check'), 'Ready for users');
  if (a.liveUrl) return h('span', { class: 'pill good' }, h('span', { class: 'd' }), 'Live');
  if (a.steps.some((s) => s.status === 'running')) return h('span', { class: 'pill run' }, h('span', { class: 'd' }), 'In progress');
  return h('span', { class: 'pill' }, h('span', { class: 'd' }), 'Not live');
}

function meter(a) {
  const p = pct(a);
  return h('div', { class: 'meter', role: 'progressbar', 'aria-valuenow': p, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${p}% ready` },
    h('span', { class: 'ok', style: { width: `${p}%` } }));
}

function stepSegments(a) {
  return h('div', { class: 'segs', 'aria-hidden': 'true' }, a.steps.map((s) => h('span', { class: s.status || 'todo', title: `${s.label}: ${s.status || 'todo'}` })));
}

// ---------- sidebar + topbar ----------
function renderNav() {
  morph($('brand-mark'), [icon('rocket')]);
  const ov = $('nav-overview');
  ov.className = 'nav' + (state.view === 'overview' ? ' on' : '');
  morph(ov, [icon('grid'), h('span', {}, 'Overview')]);
  const connected = state.accounts.filter((a) => a.connected).length;
  const ac = $('nav-accounts');
  ac.className = 'nav' + (state.view === 'accounts' ? ' on' : '');
  morph(ac, [icon('key'), h('span', {}, 'Accounts'), h('span', { class: 'end' }, h('span', { class: 'count' }, `${connected}/${state.accounts.length}`))]);
  morph($('nav-extra'), [hook('navExtra')]);
  const foot = hook('sideFoot');
  if (foot) morph(document.querySelector('.side .foot'), [foot]);
  $('app-count').textContent = state.apps.length || '';
  morph($('applist'), state.apps.map((a) =>
    h('button', { class: 'nav' + (state.view === 'app' && state.selected === a.slug ? ' on' : ''), key: a.slug, onclick: () => go('app', a.slug), title: a.name },
      avatar(a), h('span', {}, a.name),
      h('span', { class: 'end' },
        hook('appBadge', a),
        a.blockingTasks ? h('span', { class: 'pill bad sm', title: `${a.blockingTasks} blocking release` }, a.blockingTasks) : null,
        h('span', { class: 'status-dot' + (a.liveUrl ? ' live' : ''), title: a.liveUrl ? 'Live' : 'Not live' })))));
}

// The selected-item pill glides to whichever nav item is on.
function placeNavPill() {
  const side = document.querySelector('.side');
  if (!side) return;
  let pill = side.querySelector(':scope > .nav-ind');
  if (!pill) {
    pill = h('span', { class: 'nav-ind', 'aria-hidden': 'true' });
    side.prepend(pill);
  }
  const on = side.querySelector('.nav.on');
  if (!on || !on.offsetWidth) return pill.classList.remove('on');
  const jump = !pill.classList.contains('on');
  if (jump) pill.style.transition = 'none';
  pill.style.width = `${on.offsetWidth}px`;
  pill.style.height = `${on.offsetHeight}px`;
  pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
  if (jump) {
    void pill.offsetWidth;
    pill.style.transition = '';
  }
  pill.classList.add('on');
}

// The quick light/dark switch in the top bar. theme.js keeps the choice; a host
// page can also save it (the themeChanged hook).
const Theme = () => window.LiftoffTheme || null;
function setTheme(pref) {
  const T = Theme();
  if (!T) return;
  T.set(pref);
  hook('themeChanged', T.get());
}
function themeButton() {
  const T = Theme();
  if (!T) return null;
  const dark = T.resolved() === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return h('button', { class: 'btn quiet icon-only theme-btn', type: 'button', title: label, 'aria-label': label, onclick: () => setTheme(Theme().resolved() === 'dark' ? 'light' : 'dark') }, icon(dark ? 'sun' : 'moon'));
}

function renderTopbar(app) {
  const crumbs = [h('button', { class: 'crumb', onclick: () => go('overview') }, HOOKS.brand || 'Flight Board')];
  const extra = HOOKS.views?.[state.view];
  const sep = () => h('span', { class: 'sep' }, '/');
  if (state.view === 'app' && app) crumbs.push(sep(), h('b', {}, app.name));
  else if (extra) crumbs.push(sep(), h('b', {}, extra.title));
  else if (state.view === 'accounts') crumbs.push(sep(), h('b', {}, 'Accounts'));
  else crumbs.push(sep(), h('b', {}, 'Overview'));
  morph($('topbar'), [...crumbs,
    h('span', { class: 'sync', title: 'Refreshes every few seconds' }, h('span', { class: 'status-dot live' }), state.lastSync ? 'Synced' : 'Connecting…'),
    themeButton(),
    hook('topbarEnd')]);
}

// ---------- overview ----------
function renderOverview() {
  if (!state.apps.length) {
    const custom = hook('emptyOverview');
    if (custom) return custom;
    return h('div', { class: 'card empty' },
      h('div', { class: 'tile' }, icon('rocket')),
      h('h2', {}, 'No apps yet'),
      h('p', {}, 'Open an app in Claude Code and run ', h('code', {}, '/liftoff:launch'), '. It shows up here right away.'));
  }
  const apps = state.apps;
  const live = apps.filter((a) => a.liveUrl).length;
  const blocking = apps.reduce((n, a) => n + a.blockingTasks, 0);
  const open = apps.reduce((n, a) => n + a.openTasks, 0);
  const connected = state.accounts.filter((a) => a.connected).length;
  const allTasks = apps.flatMap((a) => a.tasks.filter((t) => !t.done).map((t) => ({ ...t, app: a })))
    .sort((x, y) => y.blocksRelease - x.blocksRelease);

  return [
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Overview'), h('p', {}, hook('overviewIntro', apps) || `${plural(apps.length, 'app')} on this machine. Here is what needs you first.`)),
      h('div', { class: 'actions' }, hook('overviewActions'))),
    h('section', { class: 'stats', 'aria-label': 'Summary' },
      stat('Live', live, `/ ${apps.length}`, live === apps.length ? 'Every app is live' : `${apps.length - live} not live yet`),
      stat('Blocking release', blocking, '', blocking ? 'Clear these before you ship' : 'Nothing blocking', blocking > 0),
      stat('Your open tasks', open, '', `across ${plural(apps.filter((a) => a.openTasks).length, 'app')}`),
      stat('Accounts connected', connected, `/ ${state.accounts.length}`, 'Shared by all your apps')),
    h('div', { class: 'cols' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Needs you'), h('span', { class: 'count' }, allTasks.length),
          h('span', { class: 'end sub' }, 'Blockers on top')),
        h('div', { class: 'card-body rows' },
          allTasks.length ? allTasks.map((t) => taskRow(t.app, t, true)) : h('div', { class: 'empty-row' }, icon('checkCircle'), 'Nothing waiting on you.'))),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Recent activity')),
        h('div', { class: 'card-body' }, activity(apps.flatMap((a) => a.log.map((l) => ({ ...l, app: a }))), 8, true)))),
    h('div', { class: 'page-head', style: { marginTop: '4px' } }, h('div', {}, h('h1', { style: { fontSize: '16px' } }, 'Apps'))),
    h('div', { class: 'apps' }, apps.map(appCard)),
  ];
}

function stat(label, value, of, hint, alert) {
  return h('div', { class: 'stat spot' + (alert ? ' alert' : '') },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value, of ? h('small', {}, ' ' + of) : null),
    h('div', { class: 'hint' }, hint));
}

function appCard(a) {
  return h('button', { class: 'card app-card spot', key: a.slug, onclick: () => go('app', a.slug), 'aria-label': `Open ${a.name}` },
    h('div', { class: 'top' }, avatar(a),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'nm' }, a.name), h('div', { class: 'sub' }, a.liveUrl ? host(a.liveUrl) : a.platforms.map((p) => PLATFORM[p] || p).join(' · '))),
      appStatus(a)),
    h('div', { class: 'mid' },
      h('div', { class: 'small', style: { display: 'flex', justifyContent: 'space-between' } },
        h('span', {}, 'Launch steps'), h('span', {}, `${a.stepsDone}/${a.stepsTotal}`)),
      stepSegments(a),
      h('div', { class: 'small', style: { display: 'flex', justifyContent: 'space-between', marginTop: '10px' } },
        h('span', {}, 'Release readiness'), h('span', {}, `${pct(a)}%`)),
      h('div', { style: { marginTop: '6px' } }, meter(a))),
    h('div', { class: 'bottom' },
      a.blockingTasks ? h('span', { class: 'flag' }, icon('flag'), `${a.blockingTasks} blocking`) : h('span', {}, a.readyForRelease ? 'Nothing blocking' : 'No blockers'),
      h('span', {}, `${toDo(a)} left`),
      h('span', { class: 'go' }, 'Open', icon('arrow'))));
}

function activity(entries, limit, showApp) {
  const list = entries.slice().sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, limit);
  if (!list.length) return h('div', { class: 'empty-row' }, 'Nothing yet.');
  return h('div', { class: 'timeline' }, list.map((l) => {
    const [what, rest] = String(l.msg).split(' → ');
    const tone = /^done|^skipped/.test(rest || '') ? 'good' : /^running/.test(rest || '') ? 'run' : /^blocked/.test(rest || '') ? 'bad' : '';
    const step = l.app?.steps.find((s) => s.id === what);
    return h('div', { class: 'ev' },
      h('span', { class: 'bul ' + tone }),
      h('div', { class: 'msg' },
        showApp ? h('b', {}, l.app.name + ' ') : null,
        rest !== undefined ? [h('span', {}, step ? step.label : what), ` ${rest.split(':')[0] === 'done' ? 'finished' : rest}`] : l.msg),
      h('time', { datetime: l.at, title: l.at ? new Date(l.at).toLocaleString() : '' }, ago(l.at)));
  }));
}

// ---------- accounts ----------
function accountRows(accounts) {
  return h('div', { class: 'rows' }, accounts.filter(Boolean).map((a) => h('div', { class: 'line' },
    serviceTile(a),
    h('div', { class: 'grow' }, h('div', { class: 'name' }, a.label), h('div', { class: 'small' }, a.connected ? `Connected ${a.connectedAt ? ago(a.connectedAt) : ''}`.trim() : a.note)),
    hook('accountAction', a) || (a.connected
      ? h('span', { class: 'pill good' }, icon('check'), 'Connected')
      : h('button', { class: 'btn', title: 'Copy the command that connects it', onclick: () => copy(`liftoff accounts connect ${a.id}`) }, icon('copy'), 'Connect')))));
}

function renderAccounts() {
  const connected = state.accounts.filter((a) => a.connected);
  const rest = state.accounts.filter((a) => !a.connected);
  return [
    h('div', { class: 'page-head' }, h('div', {},
      h('h1', {}, 'Accounts'),
      h('p', {}, hook('accountsIntro') || ['Add a key once and every app on this machine can use it. Keys stay in your OS keychain (or ', h('code', {}, '~/.liftoff/credentials.env'), '), never in a repo.']))),
    h('div', { class: 'cols' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Not connected'), h('span', { class: 'count' }, rest.length),
          h('span', { class: 'end sub' }, HOOKS.accountAction ? 'Keys are stored encrypted' : 'Connect copies the command')),
        h('div', { class: 'card-body' }, rest.length ? accountRows(rest) : h('div', { class: 'empty-row' }, icon('checkCircle'), 'Everything is connected.'))),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Connected'), h('span', { class: 'count' }, connected.length)),
        h('div', { class: 'card-body' }, connected.length ? accountRows(connected) : h('div', { class: 'empty-row' }, 'None yet.')))),
  ];
}

// ---------- one app ----------
function money(n, cur = 'usd') {
  if (n === null || n === undefined) return '–';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.toUpperCase(), maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n);
}
function pulseTile(label, value, delta, dir) {
  return h('div', {}, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value),
    delta ? h('div', { class: 'delta' + (dir ? ` ${dir}` : '') }, delta) : null);
}
function pulseCard(app) {
  const p = app.pulse;
  const refreshBtn = h('button', { class: 'btn quiet', onclick: (e) => { e.currentTarget.disabled = true; mutate(`/api/apps/${app.slug}/pulse`, 'POST'); } }, icon('activity'), 'Refresh');
  const head = h('div', { class: 'card-head' }, h('h2', {}, 'Pulse'), p ? h('span', { class: 'sub' }, ago(p.at)) : null, h('span', { class: 'end' }, refreshBtn));
  if (!p) return h('section', { class: 'card' }, head, h('div', { class: 'card-body' }, h('div', { class: 'empty-row' }, 'No numbers yet. Refresh once Stripe or RevenueCat, PostHog and Sentry are connected.')));
  const tiles = [];
  const rev = p.revenuecat?.mrr ?? p.stripe?.mrr;
  const cur = p.revenuecat?.currency || p.stripe?.currency || 'usd';
  if (rev !== undefined && rev !== null) {
    const ch = p.change?.mrr;
    tiles.push(pulseTile('MRR', money(rev, cur), ch !== null && ch !== undefined ? `${ch >= 0 ? '+' : ''}${money(ch, cur)} vs last week` : null, ch > 0 ? 'up' : ch < 0 ? 'down' : null));
  }
  const subs = p.revenuecat?.activeSubscriptions ?? p.stripe?.activeSubscriptions;
  if (subs !== undefined && subs !== null) tiles.push(pulseTile('Subscribers', subs, p.stripe ? `+${p.stripe.newSubscriptions7d} new, −${p.stripe.cancellations7d} cancelled (7d)` : null));
  if (p.posthog) {
    const hh = p.posthog;
    const d = hh.signups7d - hh.signupsPrev7d;
    tiles.push(pulseTile('Sign-ups (7d)', hh.signups7d, `${d >= 0 ? '+' : ''}${d} vs last week`, d > 0 ? 'up' : d < 0 ? 'down' : null));
    tiles.push(pulseTile('Paywall → Pro', hh.paywallViews7d ? `${Math.round((hh.upgrades7d / hh.paywallViews7d) * 1000) / 10}%` : '–', `${hh.upgrades7d} of ${hh.paywallViews7d} views`));
  }
  if (p.sentry) {
    const cf = p.sentry.crashFreeSessions;
    tiles.push(pulseTile('Crash-free', cf !== null && cf !== undefined ? `${Math.round(cf * 1000) / 10}%` : '–', `${p.sentry.newIssues7d} new issues (7d)`, cf !== null && cf < 0.99 ? 'down' : null));
  }
  if (p.uptime) tiles.push(pulseTile('Site', p.uptime.up ? 'Up' : 'Down', p.uptime.up ? `${p.uptime.ms} ms` : String(p.uptime.status || p.uptime.error || ''), p.uptime.up ? 'up' : 'down'));
  if (p.stripe?.failedPayments7d) tiles.push(pulseTile('Failed payments (7d)', p.stripe.failedPayments7d, null, 'down'));
  const errs = Object.entries(p.errors || {});
  return h('section', { class: 'card' }, head, h('div', { class: 'card-body' },
    tiles.length ? h('div', { class: 'pulse-grid' }, tiles) : h('div', { class: 'empty-row' }, 'No sources answered.'),
    errs.length ? h('div', { class: 'small' }, errs.map(([k, v]) => `${k}: ${v}`).join(' · ')) : null));
}
function nextCard(app) {
  const a = app.nextAction;
  // "Check what the app does" is the profile card itself, just above.
  if (!a || (a.profile && app.profile)) return null;
  const cmd = a.command && a.command.startsWith('/') ? a.command : null;
  return h('section', { class: 'card next' },
    h('span', { class: 'tile' }, icon('flag')),
    h('div', { class: 'grow' },
      h('div', { class: 'small' }, 'Do this next'),
      h('h2', {}, a.title),
      h('p', {}, a.why),
      h('p', {}, a.do)),
    h('div', { class: 'acts' },
      a.url ? h('a', { class: 'btn', href: a.url, target: '_blank', rel: 'noopener' }, 'Open', icon('external')) : null,
      a.taskId ? h('button', { class: 'btn', onclick: () => mutate(`/api/apps/${app.slug}/tasks/${a.taskId}`, 'POST', { done: true }) }, 'Mark done') : null,
      hook('nextActionButton', app, a) || (cmd ? h('button', { class: 'btn', onclick: () => copy(cmd) }, icon('copy'), cmd) : null)));
}

function taskRow(app, t, showApp) {
  const url = `/api/apps/${app.slug}/tasks/${t.id}`;
  return h('div', { class: 'task' + (t.done ? ' done' : ''), key: `${app.slug}/${t.id}` },
    h('button', { class: 'tick', 'aria-label': t.done ? `Mark "${t.title}" not done` : `Mark "${t.title}" done`, title: t.done ? 'Undo' : 'Mark done',
      onclick: () => mutate(url, 'POST', { done: !t.done }) }, icon('check')),
    h('div', { class: 't' },
      h('div', { class: 'title' }, t.title),
      (showApp || (t.blocksRelease && !t.done) || (t.leadTime && !t.done)) ? h('div', { class: 'meta' },
        showApp ? [h('span', { class: 'avatar', style: { width: '14px', height: '14px', fontSize: '9px', borderRadius: '4px', background: colorFor(app.slug) } }, app.name[0]), h('span', {}, app.name)] : null,
        t.blocksRelease && !t.done ? h('span', { class: 'pill bad sm' }, 'Blocks release') : null,
        t.leadTime && !t.done ? h('span', { class: 'pill warn sm' }, `Takes ${t.leadTime}`) : null,
        t.url && !t.done ? h('a', { href: t.url, target: '_blank', rel: 'noopener' }, 'Start', icon('external')) : null) : null),
    h('div', { class: 'acts' },
      !t.done ? h('button', { class: 'btn', onclick: () => mutate(url, 'POST', { done: true }) }, 'Mark done') : null,
      t.done ? h('button', { class: 'btn quiet icon-only', title: 'Remove', 'aria-label': 'Remove task', onclick: () => mutate(url, 'DELETE') }, icon('trash')) : null));
}

// ---------- what the app does ----------
// Liftoff's read of what the app does (payments, sign-in, …). The launch
// steps, "Needs you" and the readiness checks follow it, so the owner fixes
// what the scan got wrong here. Until they confirm it, it shows in full at
// the top; after, as one line above the steps that opens again.
function featureNote(f) {
  if (f.source === 'you') return f.inCode && !f.on ? `Set by you (${f.inCode})` : 'Set by you';
  if (f.source === 'unsure') return 'Not in the code yet. Kept in case the app needs it';
  if (f.on) return f.why || 'Found in the code';
  return f.hint;
}

// How a change moved the launch: "2 fewer launch steps, 9 fewer checks".
function changeWords(before, after) {
  const d = (n, one, many) => (n === 0 ? null : `${Math.abs(n)} ${n > 0 ? 'more' : 'fewer'} ${Math.abs(n) === 1 ? one : many}`);
  return [d(after.stepsTotal - before.stepsTotal, 'launch step', 'launch steps'), d(after.checksTotal - before.checksTotal, 'check', 'checks'), d(after.openTasks - before.openTasks, 'to-do', 'to-dos')].filter(Boolean).join(', ');
}

async function toggleFeature(app, f, btn) {
  const before = { stepsTotal: app.stepsTotal, checksTotal: app.checksTotal, openTasks: app.openTasks };
  btn.disabled = true;
  try {
    await api(`/api/apps/${encodeURIComponent(app.slug)}/profile`, { method: 'POST', body: JSON.stringify({ feature: f.id, on: !f.on }) });
    await refresh(true);
    const now = state.apps.find((a) => a.slug === app.slug);
    const moved = now ? changeWords(before, now) : '';
    toast(`${f.label}: ${f.on ? 'no' : 'yes'}.${moved ? ` ${moved[0].toUpperCase()}${moved.slice(1)}.` : ''}`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

function featureSwitches(app) {
  return h('div', { class: 'feats' }, app.profile.features.map((f) => h('button', {
    class: 'feat' + (f.on ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': String(!!f.on), key: f.id,
    onclick: (e) => toggleFeature(app, f, e.currentTarget),
  },
  h('span', { class: 'sw', 'aria-hidden': 'true' }),
  h('span', { class: 'ft' }, h('b', {}, f.label), h('span', { class: 'small' }, featureNote(f))))));
}

// Steps this app's platforms have that don't fit what it does, kept in
// sight under the launch steps. Add turns on what the step is for; a step
// for several things opens the switches instead.
function openProfile(app) {
  state.open[`profile:${app.slug}`] = true;
  render();
  document.querySelector('.does')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function leftOutSteps(app) {
  const list = app.leftOut || [];
  if (!list.length || !app.profile) return null;
  const add = (s, btn) => {
    const f = s.features.length === 1 && app.profile.features.find((x) => x.id === s.features[0]);
    if (f && !f.on) toggleFeature(app, f, btn);
    else openProfile(app);
  };
  return h('div', { class: 'left-out' },
    h('div', { class: 'lo-head' },
      h('b', {}, 'Not part of this launch'), h('span', { class: 'count' }, list.length),
      h('span', { class: 'small' }, 'Turned off for this app, or not called for by its code. Add any it will need.')),
    h('div', { class: 'roadmap lo' }, list.map((s) => h('div', { class: 'step left', key: s.id },
      h('div', { class: 'lo-top' },
        h('div', { class: 'lbl' }, icon('minus'), h('span', {}, s.label)),
        h('button', { class: 'btn quiet sm', type: 'button', 'aria-label': `Add ${s.label}`, onclick: (e) => add(s, e.currentTarget) }, icon('plus'), 'Add')),
      h('div', { class: 'note' }, s.for ? `Only if it ${s.for}` : 'Doesn’t fit this app')))));
}

// "16 checks left out (Payments 8, Sign-in 3, …)"
function leftOutChecks(app) {
  const list = app.checksLeftOut || [];
  const n = list.reduce((t, c) => t + c.count, 0);
  if (!n || !app.profile) return null;
  return h('div', { class: 'lo-checks small' },
    h('span', {}, `${plural(n, 'check')} left out as not needed: ${list.map((c) => `${c.category} ${c.count}`).join(', ')}.`),
    h('button', { class: 'linkish', type: 'button', onclick: () => openProfile(app) }, 'Change what this app does'));
}

function confirmProfile(app, btn) {
  btn.disabled = true;
  delete state.open[`profile:${app.slug}`];
  mutate(`/api/apps/${encodeURIComponent(app.slug)}/profile`, 'POST', { confirm: true });
}

function profileCard(app) {
  const p = app.profile;
  if (!p) return null;
  const key = `profile:${app.slug}`;
  const asking = !p.confirmedAt;
  const open = asking || !!state.open[key];
  const counts = `${plural(app.stepsTotal, 'launch step')} · ${plural(app.checksTotal, 'check')} · ${plural(app.openTasks, 'to-do')} for you`;
  if (!open) {
    const on = p.features.filter((f) => f.on);
    return h('section', { class: 'card does slim', key: 'profile' },
      icon('layers'),
      h('span', { class: 'k' }, 'Tailored to'),
      h('div', { class: 'tags' }, on.length ? on.map((f) => h('span', { class: 'tag', key: f.id }, f.label)) : h('span', { class: 'tag' }, 'No payments, sign-in or server data')),
      h('span', { class: 'pill sm' }, p.sizeLabel),
      h('button', { class: 'btn quiet sm', type: 'button', 'aria-expanded': 'false', onclick: () => { state.open[key] = true; render(); } }, 'Change'));
  }
  return h('section', { class: 'card does' + (asking ? ' ask' : ''), key: 'profile' },
    h('div', { class: 'card-head' }, icon('layers'), h('h2', {}, `What ${app.name} does`), h('span', { class: 'pill sm' }, p.sizeLabel),
      h('span', { class: 'end sub' }, asking ? 'Liftoff’s guess from the code' : 'Confirmed by you')),
    h('div', { class: 'card-body' },
      h('p', { class: 'small lead' }, asking
        ? 'The launch steps, what needs you and the readiness checks follow from this. Anything not built yet stays in, in case the app needs it. Turn off what it won’t.'
        : 'Change this whenever the app changes. The steps and checks follow at once, and nothing you’ve done is lost.'),
      featureSwitches(app),
      h('div', { class: 'does-foot' },
        h('span', { class: 'small grow' }, counts),
        asking
          ? h('button', { class: 'btn primary', type: 'button', onclick: (e) => confirmProfile(app, e.currentTarget) }, icon('check'), 'Looks right')
          : h('button', { class: 'btn', type: 'button', onclick: () => { delete state.open[key]; render(); } }, 'Done'))));
}

const STEP_ICON = { done: 'checkCircle', skipped: 'minus', running: 'spinner', blocked: 'x', todo: 'circle' };
const STEP_WORD = { done: 'Done', skipped: 'Skipped', running: 'In progress', blocked: 'Blocked', todo: 'Not started' };

function renderApp(app) {
  const cats = [...new Set(app.checklist.map((c) => c.category))];
  const input = h('input', { type: 'text', name: 'title', placeholder: 'Add a task for yourself…', 'aria-label': 'New task', maxlength: '200' });
  const blocks = h('input', { type: 'checkbox', name: 'blocks' });
  const p = pct(app);
  const openKey = (cat) => `${app.slug}:${cat}`;

  return [
    h('section', { class: 'card hero', style: { '--c': colorFor(app.slug) } },
      h('div', { class: 'id' }, avatar(app, true),
        h('div', { style: { minWidth: 0 } },
          h('h1', {}, app.name, appStatus(app)),
          h('div', { class: 'meta' },
            h('span', {}, icon('layers'), app.framework),
            h('span', {}, icon(app.platforms.includes('web') && app.platforms.length === 1 ? 'globe' : 'phone'), app.platforms.map((x) => PLATFORM[x] || x).join(', ')),
            hook('heroMeta', app) || h('span', { title: app.root, style: { maxWidth: '100%' } }, icon('folder'), h('span', { class: 'path' }, app.root))))),
      h('div', { class: 'cta' },
        hook('heroActions', app),
        app.liveUrl ? h('a', { class: 'btn primary', href: app.liveUrl, target: '_blank', rel: 'noopener' }, 'Visit', icon('external')) : null),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('div', { class: 'ring', style: { '--p': p } }, h('b', {}, `${p}%`)),
          h('div', {}, h('div', { class: 'label' }, 'Release readiness'), h('div', { class: 'small' }, app.readyForRelease ? 'Ready for users' : `${toDo(app)} things left`))),
        h('div', { class: 'fact' }, h('div', { class: 'label' }, 'Launch steps'), h('div', { class: 'value' }, app.stepsDone, h('small', {}, ` / ${app.stepsTotal}`))),
        h('div', { class: 'fact' }, h('div', { class: 'label' }, 'Readiness checks'), h('div', { class: 'value' }, app.checksDone, h('small', {}, ` / ${app.checksTotal}`))),
        h('div', { class: 'fact' }, h('div', { class: 'label' }, 'Blocking release'), h('div', { class: 'value' + (app.blockingTasks ? ' bad' : '') }, app.blockingTasks)))),

    app.profile && !app.profile.confirmedAt ? profileCard(app) : null,
    hook('afterHero', app),
    nextCard(app),
    app.profile?.confirmedAt ? profileCard(app) : null,

    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Launch steps'), h('span', { class: 'count' }, `${app.stepsDone}/${app.stepsTotal}`),
        h('span', { class: 'end' }, hook('stepsHeadEnd', app) || h('span', { class: 'sub' }, 'Claude works through these in order'))),
      h('div', { class: 'roadmap' }, app.steps.map((s) => {
        const st = s.status || 'todo';
        return h('div', { class: 'step ' + st, title: s.note || STEP_WORD[st] },
          h('div', { class: 'lbl' }, icon(STEP_ICON[st]), h('span', {}, s.label)),
          h('div', { class: 'note' }, s.stale ? 'Stalled: run it again'
            : st === 'todo' && s.waitingOn?.length ? `Waits on ${s.waitingOn.map((id) => app.steps.find((x) => x.id === id)?.label || id).join(', ')}`
            : s.note || (s.provider ? `${STEP_WORD[st]} · ${s.provider}` : STEP_WORD[st])));
      })),
      leftOutSteps(app)),

    h('div', { class: 'cols' },
      h('div', { class: 'stack' },
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Needs you'), h('span', { class: 'count' }, app.openTasks),
            h('span', { class: 'end sub' }, 'Blockers on top')),
          h('div', { class: 'card-body' },
            h('div', { class: 'rows' }, app.tasks.length ? app.tasks.map((t) => taskRow(app, t)) : h('div', { class: 'empty-row' }, icon('checkCircle'), 'Nothing waiting on you.')),
            h('form', { class: 'add', onsubmit: (e) => {
              e.preventDefault();
              const f = e.currentTarget.elements;
              if (!f.title.value.trim()) return;
              mutate(`/api/apps/${app.slug}/tasks`, 'POST', { title: f.title.value, blocksRelease: f.blocks.checked });
            } }, input, h('label', {}, blocks, 'Blocks release'), h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Add')))),

        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Release readiness'), h('span', { class: 'count' }, `${app.checksDone}/${app.checksTotal}`),
            h('span', { class: 'end' },
              h('span', { class: 'sub' }, app.lastVerifiedAt ? `Verified ${ago(app.lastVerifiedAt)}` : 'Not verified yet'),
              h('button', { class: 'btn', title: 'Check against the live site and connected services', onclick: (e) => { e.currentTarget.disabled = true; toast('Checking the live site and services…'); mutate(`/api/apps/${app.slug}/verify`, 'POST'); } }, icon('checkCircle'), 'Verify'))),
          cats.map((cat) => {
            const items = app.checklist.filter((c) => c.category === cat);
            const done = items.filter((c) => c.done).length;
            const key = openKey(cat);
            const isOpen = key in state.open ? state.open[key] : done < items.length && cats.indexOf(cat) < 2;
            return h('details', { class: 'cat', open: isOpen, ontoggle: (e) => { state.open[key] = e.target.open; } },
              h('summary', {}, icon('chevron', 'chev'), h('span', { class: 'nm' }, cat),
                h('div', { class: 'meter' }, h('span', { class: 'ok', style: { width: `${(done / items.length) * 100}%` } })),
                h('span', { class: 'frac' + (done === items.length ? ' full' : '') }, done === items.length ? 'Complete' : `${done} of ${items.length}`)),
              h('div', { class: 'items' }, items.map((c) => h('label', { class: 'check' },
                h('input', { type: 'checkbox', checked: c.done, onchange: (e) => mutate(`/api/apps/${app.slug}/checklist/${c.id}`, 'POST', { done: e.target.checked }) }),
                h('span', { class: 'tx' }, c.title, c.verify?.ok === false ? h('span', { class: 'why' }, c.verify.detail) : null),
                c.done && c.by ? h('span', { class: 'by' }, c.by === 'verified' ? 'verified' : `by ${hook('whoTicked', c.by) || c.by}`) : null))));
          }),
          leftOutChecks(app)),
        hook('mainBottom', app)),

      h('div', { class: 'stack' },
        hook('sideTop', app),
        pulseCard(app),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Deployments')),
          h('div', { class: 'card-body' },
            app.liveUrl ? h('a', { class: 'live-link', href: app.liveUrl, target: '_blank', rel: 'noopener' },
              h('span', { class: 'status-dot live' }), h('span', { class: 'host' }, host(app.liveUrl)), icon('external')) : null,
            app.deploys.length ? h('div', { class: 'rows' }, app.deploys.map((d) => h('div', { class: 'deploy' },
              h('span', { class: 'tile' }, icon(d.platform === 'web' ? 'globe' : 'phone')),
              h('div', { class: 'grow' }, h('div', { style: { fontWeight: 500 } }, d.target),
                h('div', { class: 'small' }, d.platform === 'web' ? 'Web' : `${PLATFORM[d.platform] || d.platform} beta`, d.at ? ` · ${ago(d.at)}` : '')),
              h('div', { style: { textAlign: 'right' } },
                h('span', { class: 'pill sm ' + (d.status === 'live' ? 'good' : d.status === 'failed' ? 'bad' : 'run') }, h('span', { class: 'd' }), d.status === 'live' ? 'Live' : d.status),
                d.version ? h('div', { class: 'v', style: { marginTop: '3px' } }, d.version) : null))))
              : app.liveUrl ? null : h('div', { class: 'empty-row' }, 'Nothing deployed yet.'),
            hook('deploysFoot', app))),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Accounts this app uses'),
            h('span', { class: 'end' }, h('button', { class: 'btn quiet', onclick: () => go('accounts') }, 'All accounts', icon('arrow')))),
          h('div', { class: 'card-body' }, accountRows(app.accounts))),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Activity')),
          h('div', { class: 'card-body' }, activity(app.log.map((l) => ({ ...l, app })), 8, false))))),
  ];
}

// ---------- plumbing ----------
function render() {
  const app = state.apps.find((a) => a.slug === state.selected);
  if (state.view === 'app' && !app && state.lastSync) state.view = 'overview';
  if (state.view === 'app' && !app) return renderNav();
  renderNav();
  renderTopbar(app);
  const extra = HOOKS.views?.[state.view];
  const view = state.view === 'app' ? renderApp(app) : extra ? extra.render() : state.view === 'accounts' ? renderAccounts() : renderOverview();
  const main = $('main');
  // A new view replaces the page and slides in; the same view is patched in place.
  const key = `${state.view}:${state.view === 'app' ? state.selected : extra?.key?.() ?? ''}`;
  if (key !== shownView) {
    shownView = key;
    main.replaceChildren(...asNodes([view]));
    main.classList.remove('entering');
    void main.offsetWidth;
    main.classList.add('entering');
    clearTimeout(enterTimer);
    enterTimer = setTimeout(() => main.classList.remove('entering'), 1400);
  } else morph(main, [view]);
  const brand = HOOKS.brand || 'Flight Board';
  document.title = state.view === 'app' ? `${app.name} · ${brand}` : extra ? `${extra.title} · ${brand}` : brand;
  placeNavPill();
  hook('afterRender');
}
let shownView = null;
let enterTimer;

let toastTimer;
function toast(msg) {
  for (const t of document.querySelectorAll('.toast')) t.remove();
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(`Copied: ${text}`); }
  catch { toast(`Run: ${text}`); }
}

async function mutate(path, method, body) {
  try {
    await api(path, { method, body: body ? JSON.stringify(body) : undefined });
    await refresh(true);
  } catch (err) { toast(err.message); }
}

// The view lives in the address (#<app>, #accounts, #!<view>), and each move
// to a new view is a history entry, so the browser's Back and Forward (and a
// phone's back gesture) move between views instead of leaving the page.
function hashFor(view, slug) {
  return view === 'app' ? `#${encodeURIComponent(slug)}` : view === 'accounts' ? '#accounts' : HOOKS.views?.[view] ? `#!${view}` : '#';
}

function readHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  state.selected = null;
  if (hash === 'accounts') state.view = 'accounts';
  else if (hash.startsWith('!') && HOOKS.views?.[hash.slice(1)]) state.view = hash.slice(1);
  else if (hash && !hash.startsWith('!')) { state.view = 'app'; state.selected = hash; }
  else state.view = 'overview';
}

function go(view, slug = null) {
  state.view = view;
  state.selected = slug;
  const hash = hashFor(view, slug);
  if (hash !== (location.hash || '#')) history.pushState(null, '', hash);
  render();
  window.scrollTo(0, 0);
}

// Re-render without resetting typed-in fields (for async updates while someone types).
function repaint() {
  polling = true;
  try {
    render();
  } finally {
    polling = false;
  }
}

async function refresh(force) {
  try {
    const [apps, accounts] = await Promise.all([api('/api/apps'), api('/api/accounts'), hook('load')]);
    if (!apps || !accounts) return;
    state.apps = apps;
    state.accounts = accounts;
    state.lastSync = Date.now();
  } catch (err) {
    if (force) toast(err.message);
    return;
  }
  // A background refresh patches the page but leaves whatever is typed in fields alone.
  if (force) render();
  else repaint();
}

function configure(hooks) {
  Object.assign(HOOKS, hooks);
}

let started = false;
function start() {
  if (started) return;
  started = true;
  $('nav-overview').onclick = () => go('overview');
  $('nav-accounts').onclick = () => go('accounts');
  // Cursor spotlight on .spot cards.
  document.addEventListener('pointermove', (e) => {
    const el = e.target instanceof Element ? e.target.closest('.spot') : null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
    el.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
  }, { passive: true });
  addEventListener('resize', placeNavPill, { passive: true });
  // theme.js says when the theme changes (your pick, or the device switching).
  addEventListener('liftoff-theme', () => repaint());
  readHash();
  addEventListener('popstate', (e) => {
    readHash();
    hook('popstate', e.state);
    render();
    window.scrollTo(0, 0);
  });
  render();
  refresh(true);
  const tick = async () => {
    await refresh();
    setTimeout(tick, hook('pollMs') || 4000);
  };
  setTimeout(tick, hook('pollMs') || 4000);
}

window.Board = { configure, start, state, h, icon, logo, serviceTile, api, mutate, go, render, refresh, toast, copy, ago, colorFor, avatar, host, plural, money, morph, repaint, setTheme, themeButton, featureSwitches, PLATFORM, STEP_WORD, ICONS };
if (!document.body.hasAttribute('data-board-manual')) start();
