// Sign-in page: shows the sign-in options this server has, and the light/dark switch.
(async () => {
  const $ = (id) => document.getElementById(id);
  const errors = { state: 'That sign-in link expired. Try again.', denied: 'GitHub sign-in was cancelled. Nothing was shared.' };
  const q = new URLSearchParams(location.search);
  const err = q.get('error');
  if (err) {
    $('error').textContent = errors[err] || 'Sign-in failed. Try again.';
    $('error').hidden = false;
  }
  // After deleting an account in Account settings.
  const deleted = q.get('deleted');
  if (deleted) {
    $('notice').textContent = deleted === 'github'
      ? 'Your account and everything in it were deleted. To also remove Liftoff Cloud from GitHub, open GitHub Settings, then Applications.'
      : 'Your account and everything in it were deleted.';
    $('notice').hidden = false;
  }

  // The sun and moon, as on every other page.
  const T = window.LiftoffTheme;
  const themeBtn = $('theme');
  const label = () => {
    const text = T && T.resolved() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    themeBtn.title = text;
    themeBtn.setAttribute('aria-label', text);
  };
  if (T) {
    label();
    themeBtn.addEventListener('click', () => T.set(T.resolved() === 'dark' ? 'light' : 'dark'));
    addEventListener('liftoff-theme', label);
  } else themeBtn.hidden = true;

  try {
    const opts = await (await fetch('/login/options')).json();
    $('github').hidden = !opts.github;
    $('perm').hidden = !opts.github;
    $('first-time').hidden = !opts.github;
    $('or').hidden = !(opts.github && opts.dev);
    $('dev').hidden = !opts.dev;
    // On its own, the local sign-in is the main button.
    if (opts.dev && !opts.github) $('dev').querySelector('button').classList.add('primary');
    $('none').hidden = opts.github || opts.dev;
    // The assistant's name, if this server gives it another one.
    if (opts.assistant) for (const el of document.querySelectorAll('[data-ai]')) el.textContent = opts.assistant;
  } catch {
    $('none').hidden = false;
  }
})();
