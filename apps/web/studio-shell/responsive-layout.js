/* Dynamic viewport sizing only; never scale or mutate native canvas records. */
(() => {
  'use strict';
  const root = document.documentElement;
  root.dataset.nvResponsive = 'true';
  let raf = 0;
  function update() {
    raf = 0;
    const height = Math.round(window.visualViewport?.height || innerHeight);
    const value = height + 'px';
    if (root.style.getPropertyValue('--nv-viewport-height') !== value) root.style.setProperty('--nv-viewport-height', value);
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(update); }
  window.addEventListener('resize',schedule);
  window.visualViewport?.addEventListener('resize',schedule);
  window.addEventListener('pagehide',() => { cancelAnimationFrame(raf); window.removeEventListener('resize',schedule); window.visualViewport?.removeEventListener('resize',schedule); },{once:true});
  update();
})();
