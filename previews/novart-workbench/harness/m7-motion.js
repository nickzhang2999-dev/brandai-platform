/* Only hidden-state accessibility for new comparison panels. No editor hooks. */
(() => {
  'use strict';
  if(document.getElementById('compare-app')) {
    const label=document.querySelector('.nv-wordmark i');if(label)label.textContent='动效比较版';
    document.documentElement.dataset.nvMotionReady='true';return;
  }
  if(new URLSearchParams(location.search).get('ui')!=='novart')return;
  const definitions=[['novart-context','nv-context-toggle','nv-context-close'],
    ['novart-workflow','nv-workflow-toggle','nv-workflow-close'],
    ['novart-switcher','nv-project-switch',null]];
  const observers=[],pendingDismiss=new Map(),cleanupTimers=new Set();
  function markDismiss(id) {
    const ticket={};pendingDismiss.set(id,ticket);
    // Intent lasts this input turn only; it never delays the hidden state.
    const timer=setTimeout(()=>{cleanupTimers.delete(timer);if(pendingDismiss.get(id)===ticket)pendingDismiss.delete(id);},0);
    cleanupTimers.add(timer);
  }
  const pointer=event=>{
    pendingDismiss.clear();
    if(!(event.target instanceof Element))return;
    for(const [id,,closer] of definitions)if(closer&&event.target.closest('#'+closer))markDismiss(id);
  };
  const keyboard=event=>{
    if(event.key!=='Escape'||event.isComposing||event.ctrlKey||event.altKey||event.metaKey||!(event.target instanceof Element))return;
    for(const [id,opener,closer] of definitions) {
      const panel=document.getElementById(id);
      if(!panel||panel.hidden||panel.inert||!panel.contains(event.target))continue;
      // Native window hotkeys can stop Escape before the old panel listener.
      // Use its existing close action, then retain this event's focus intent.
      event.preventDefault();event.stopPropagation();
      document.getElementById(closer||opener)?.click();markDismiss(id);break;
    }
  };
  // The preserved native HotkeyService consumes Enter at window capture.
  // Restore standard activation only for focused comparison buttons/links.
  const activate=event=>{
    if(event.key!=='Enter'||event.repeat||event.isComposing||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey||!(event.target instanceof Element))return;
    const control=event.target.closest('button,a[href]');
    if(!control||document.activeElement!==control||control.disabled||control.closest('[hidden],[inert]')||!control.closest('#novart-bar,#novart-context,#novart-workflow,#novart-switcher'))return;
    event.preventDefault();event.stopPropagation();control.click();
  };
  window.addEventListener('keydown',activate,true);
  document.addEventListener('pointerdown',pointer,true);
  document.addEventListener('click',pointer,true);
  window.addEventListener('keydown',keyboard,true);
  for(const [id,opener] of definitions) {
    const panel=document.getElementById(id);if(!panel)continue;
    let previous;
    function sync() {
      const closed=panel.hidden;if(closed===previous)return;previous=closed;
      const active=document.activeElement,focus=panel.contains(active),neutral=!active||active===document.body||active===document.documentElement;
      if(panel.inert!==closed)panel.inert=closed;
      panel.setAttribute('aria-hidden',String(closed));
      // Repair explicit dismissals only; switching panels/canvas never steals focus.
      if(closed&&pendingDismiss.has(id)&&(focus||neutral)) {
        const button=document.getElementById(opener);
        if(button&&!button.disabled&&!button.hidden)button.focus({preventScroll:true});
      }
      pendingDismiss.delete(id);
    }
    sync();
    const observer=new MutationObserver(sync);observer.observe(panel,{attributes:true,attributeFilter:['hidden']});observers.push(observer);
  }
  document.documentElement.dataset.nvMotionReady='true';
  window.addEventListener('pagehide',()=>{
    observers.forEach(observer=>observer.disconnect());
    cleanupTimers.forEach(timer=>clearTimeout(timer));pendingDismiss.clear();
    document.removeEventListener('pointerdown',pointer,true);document.removeEventListener('click',pointer,true);window.removeEventListener('keydown',keyboard,true);
    window.removeEventListener('keydown',activate,true);
  },{once:true});
})();
