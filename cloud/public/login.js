// Sign-in page: shows the sign-in options this server has.
(async () => {
  const $ = (id) => document.getElementById(id);
  const errors = { state: 'That sign-in link expired. Try again.', denied: 'GitHub sign-in was cancelled.' };
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
  try {
    const opts = await (await fetch('/login/options')).json();
    $('github').hidden = !opts.github;
    $('dev').hidden = !opts.dev;
    $('none').hidden = opts.github || opts.dev;
  } catch {
    $('none').hidden = false;
  }
})();
