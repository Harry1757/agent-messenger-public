/** Preserve the select's value/change contract while placing its menu below the field. */
export function createSelectMenu(select) {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = `${select.id}Button`;
  button.className = `field select-trigger ${select.id}-trigger`;
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const label = document.querySelector(`label[for="${select.id}"]`);
  if (label) { label.id ||= `${select.id}Label`; button.setAttribute('aria-labelledby', `${label.id} ${button.id}`); label.htmlFor = button.id; }
  select.hidden = true;
  select.after(button);
  let menu = null;
  let signature = '';
  function close(focus = false) {
    menu?.remove(); menu = null;
    button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
  }
  function sync() {
    const next = JSON.stringify([select.value, select.disabled, [...select.options].map(o => [o.value, o.textContent, o.disabled])]);
    button.textContent = select.selectedOptions[0]?.textContent || '선택하세요';
    button.disabled = select.disabled;
    if (menu && next !== signature) close();
    signature = next;
  }
  function position() {
    if (!menu) return;
    const rect = button.getBoundingClientRect();
    const scroller = button.closest('.settings-body');
    const bounds = scroller?.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight || (bounds && (rect.bottom <= bounds.top || rect.top >= bounds.bottom))) { close(); return; }
    Object.assign(menu.style, {left: `${Math.max(8, rect.left)}px`, top: `${rect.bottom + 6}px`, width: `${Math.min(rect.width, innerWidth - 16)}px`, maxHeight: `${Math.min(260, Math.max(0, innerHeight - rect.bottom - 18))}px`});
  }
  function open() {
    if (button.disabled) return;
    if (menu) { close(); return; }
    if (innerHeight - button.getBoundingClientRect().bottom < 100) button.scrollIntoView({block: 'center'});
    document.dispatchEvent(new CustomEvent('select-menu-opening', {detail: button}));
    menu = document.createElement('div');
    menu.className = 'select-options';
    menu.id = `${select.id}Options`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-labelledby', label?.id || button.id);
    button.setAttribute('aria-controls', menu.id);
    button.setAttribute('aria-expanded', 'true');
    for (const option of select.options) {
      const item = document.createElement('button');
      item.type = 'button'; item.tabIndex = -1;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.disabled = option.disabled;
      item.textContent = option.textContent;
      item.addEventListener('click', () => {
        select.value = option.value;
        close(true); sync();
        select.dispatchEvent(new Event('change', {bubbles: true}));
      });
      menu.append(item);
    }
    (button.closest('dialog') || document.body).append(menu);
    position();
    if (!menu) return;
    const enabled = [...menu.querySelectorAll('button:not(:disabled)')];
    (enabled.find(item => item.getAttribute('aria-selected') === 'true') || enabled[0])?.focus({preventScroll:true});
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (event.key === 'Tab') { close(true); return; }
      const index = enabled.indexOf(document.activeElement);
      const target = event.key === 'ArrowDown' ? (index + 1) % enabled.length : event.key === 'ArrowUp' ? (index - 1 + enabled.length) % enabled.length : event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : null;
      if (target !== null) { event.preventDefault(); enabled[target]?.focus(); }
    });
  }
  button.addEventListener('click', open);
  button.addEventListener('keydown', event => { if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); if (!menu) open(); } });
  document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target) && !button.contains(event.target)) close(); });
  document.addEventListener('select-menu-opening', event => { if (event.detail !== button) close(); });
  window.addEventListener('resize', () => close());
  document.addEventListener('scroll', event => { if (menu && !menu.contains(event.target)) position(); }, true);
  document.getElementById('accountSettings')?.addEventListener('toggle', () => close());
  sync();
  return {sync};
}
