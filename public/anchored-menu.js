// Put menus outside scrolling/clipped cards while retaining their original event handlers.
export function createAnchoredMenu() {
  let active = null;
  const close = (restoreFocus = false) => {
    if (!active) return;
    const { trigger, menu, placeholder } = active;
    active = null;
    menu.hidden = true;
    menu.classList.remove('floating-menu');
    menu.style.removeProperty('left');
    menu.style.removeProperty('top');
    menu.style.removeProperty('width');
    menu.style.removeProperty('max-height');
    if (placeholder.isConnected) placeholder.replaceWith(menu);
    else menu.remove();
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger.isConnected) trigger.focus();
  };
  const position = () => {
    if (!active) return;
    const { trigger, menu } = active;
    if (!trigger.isConnected) { close(); return; }
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const anchor = trigger.getBoundingClientRect();
    menu.style.width = `${Math.max(0, Math.min(240, width - 16))}px`;
    menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
    const rect = menu.getBoundingClientRect();
    const below = anchor.bottom + 6;
    const y = below + rect.height <= top + height - 8 ? below : anchor.top - rect.height - 6;
    menu.style.left = `${Math.max(left + 8, Math.min(anchor.right - rect.width, left + width - rect.width - 8))}px`;
    menu.style.top = `${Math.max(top + 8, Math.min(y, top + height - rect.height - 8))}px`;
  };
  const toggle = (trigger, menu) => {
    const wasOpen = active?.menu === menu;
    close();
    if (wasOpen) { trigger.focus(); return; }
    const placeholder = document.createComment('menu');
    menu.before(placeholder);
    document.body.append(menu);
    menu.hidden = false;
    menu.classList.add('floating-menu');
    menu.setAttribute('role', 'menu');
    const items = [...menu.querySelectorAll('button')];
    for (const item of items) item.setAttribute('role', 'menuitem');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'true');
    active = { trigger, menu, placeholder };
    position();
    items[0]?.focus({ preventScroll: true });
  };
  document.addEventListener('click', event => {
    if (active && !event.composedPath().includes(active.menu) && !event.composedPath().includes(active.trigger)) close();
  });
  document.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    else if (event.key === 'Tab') close(true);
    else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && active.menu.contains(event.target)) {
      event.preventDefault();
      const items = [...active.menu.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }
  });
  document.addEventListener('scroll', event => { if (active && !active.menu.contains(event.target)) close(); }, true);
  window.addEventListener('resize', position);
  window.visualViewport?.addEventListener('resize', position);
  window.visualViewport?.addEventListener('scroll', position);
  return { toggle, close, closeFor: container => { if (active && container?.contains(active.trigger)) close(); } };
}
