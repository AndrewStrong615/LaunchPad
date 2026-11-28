// Light, dark, or whatever the device is set to. Loaded in <head> before the
// stylesheets paint, so the page never flashes the wrong theme. The choice is
// kept in this browser; Liftoff Cloud also saves it to your account.
(() => {
  const KEY = 'liftoff-theme';
  const CHOICES = ['system', 'light', 'dark'];
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  let pref = 'system';
  try {
    const saved = localStorage.getItem(KEY);
    if (CHOICES.includes(saved)) pref = saved;
  } catch {}

  const resolved = () => (pref === 'system' ? (media.matches ? 'dark' : 'light') : pref);
  const apply = () => {
    root.dataset.theme = resolved();
    root.dataset.themePref = pref;
    dispatchEvent(new Event('liftoff-theme'));
  };
  apply();
  media.addEventListener('change', () => { if (pref === 'system') apply(); });

  window.LiftoffTheme = {
    CHOICES,
    get: () => pref,
    resolved,
    // Cross-fades the switch where the browser can, unless motion is turned off.
    set(next, { animate = true } = {}) {
      next = CHOICES.includes(next) ? next : 'system';
      if (next === pref) return pref;
      const before = resolved();
      pref = next;
      try {
        if (pref === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, pref);
      } catch {}
      const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (animate && !calm && before !== resolved() && document.startViewTransition) document.startViewTransition(apply);
      else apply();
      return pref;
    },
  };
})();
