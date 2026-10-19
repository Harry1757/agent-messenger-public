// Run before styles load so a saved preference is applied on the first paint.
(() => {
  const key = 'messenger-theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try { preference = localStorage.getItem(key); } catch { /* Theme still works without storage. */ }
  if (preference !== 'light' && preference !== 'dark') preference = null;

  function apply() {
    const dark = preference ? preference === 'dark' : system.matches;
    if (preference) document.documentElement.dataset.theme = preference;
    else delete document.documentElement.dataset.theme;
    document.querySelector('meta[name="color-scheme"]').content = preference ?? 'light dark';
    const color = document.querySelector('meta[name="theme-color"]');
    if (color) color.content = dark ? '#17191c' : '#f7f8fa';
    document.getElementById('themeToggle')?.setAttribute('aria-checked', String(dark));
  }

  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('themeToggle')?.addEventListener('click', () => {
      const dark = preference ? preference === 'dark' : system.matches;
      preference = dark ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* Keep the choice for this page. */ }
      apply();
    });
  });
})();
