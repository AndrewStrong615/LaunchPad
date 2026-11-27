// Sign-in page: shows the sign-in options this server has.
(async () => {
  const $ = (id) => document.getElementById(id);
  const errors = { state: 'That sign-in link expired. Try again.', denied: 'GitHub sign-in was cancelled.' };
  const err = new URLSearchParams(location.search).get('error');
  if (err) {
    $('error').textContent = errors[err] || 'Sign-in failed. Try again.';
    $('error').hidden = false;
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
