/** Keep navigation and settings usable without changing conversation or permission state. */
export function createWorkspaceLayout() {
  const get = id => document.getElementById(id);
  const sidebar = get('sidebar'), main = get('main'), toggle = get('sidebarToggle');
  const backdrop = get('sidebarBackdrop'), close = get('sidebarClose');
  const settings = get('accountSettings'), dialog = get('settingsDialog');
  const narrow = matchMedia('(max-width: 900px)');
  let opened = false;
  function navigation(value, restoreFocus = false) {
    opened = narrow.matches && value;
    document.body.classList.toggle('navigation-open', opened);
    sidebar.inert = narrow.matches && !opened;
    main.inert = opened;
    backdrop.hidden = !opened;
    toggle.setAttribute('aria-expanded', String(opened));
    if (opened) close.focus();
    else if (restoreFocus && narrow.matches) toggle.focus();
  }
  toggle.addEventListener('click', () => navigation(!opened));
  close.addEventListener('click', () => navigation(false, true));
  backdrop.addEventListener('click', () => navigation(false, true));
  sidebar.querySelector('#threads').addEventListener('click', event => {
    if (event.target.closest('.thread')) navigation(false);
  });
  narrow.addEventListener('change', () => navigation(false));
  document.addEventListener('keydown', event => {
    if (!opened || dialog.open) return;
    if (event.key === 'Escape') { event.preventDefault(); navigation(false, true); }
    if (event.key !== 'Tab') return;
    const items = [...sidebar.querySelectorAll('button:not(:disabled),a[href],input,summary,[tabindex="0"]')]
      .filter(el => el.getClientRects().length && !el.closest('[hidden]'));
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  settings.addEventListener('toggle', () => {
    if (settings.open && !dialog.open) dialog.showModal();
    else if (!settings.open && dialog.open) dialog.close();
  });
  dialog.addEventListener('close', () => {
    settings.open = false;
    if (narrow.matches && !opened) toggle.focus();
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  navigation(false);
  return {closeNavigation: () => navigation(false), openNavigation: () => navigation(true)};
}
