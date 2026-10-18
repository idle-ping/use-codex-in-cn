export function trackMobileViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  const update = () => {
    frame = 0;
    const mobile = root.classList.contains('mobile-device') || matchMedia('(max-width:720px)').matches;
    // Keep native pinch zoom: only adapt the keyboard/browser-chrome viewport at normal scale.
    const active = mobile && viewport && Math.abs(viewport.scale - 1) < 0.02 && viewport.height > 0;
    root.classList.toggle('visual-viewport-active', Boolean(active));
    if (active) {
      root.style.setProperty('--app-viewport-height', `${viewport.height}px`);
      root.style.setProperty('--app-viewport-top', `${viewport.offsetTop}px`);
    } else {
      root.style.removeProperty('--app-viewport-height');
      root.style.removeProperty('--app-viewport-top');
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  window.addEventListener('resize', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  update();
}
