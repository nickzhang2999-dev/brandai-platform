/* M21: native chat becomes a drawer below 900px of actual canvas viewport. */
(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  const expected = {ui:'novart',studio:'1',inputGuard:'m10',canvasTools:'m12',motion:'m13',feedback:'m14',visual:'m16',statusUi:'m20',layoutUi:'m21'};
  if (location.hostname !== '127.0.0.1' || !Object.entries(expected).every(([key,value]) => query.getAll(key).length === 1 && query.get(key) === value)) return;

  function install() {
    const html = document.documentElement;
    const compact = matchMedia('(max-width:899px)');
    html.dataset.nvLayout = 'm21';
    const originalAttributes = new WeakMap(), blocked = new Set();
    let wasCompact = false, enterPending = compact.matches, wasDrawer = false;
    let composing = false, restoreFocus = false, openRequested = false, caret = null, raf = 0;
    let mirror = null, receipt = null, receiptObserver = null;
    const panel = () => document.querySelector('[data-testid="agent-panel-container"]');
    const input = () => document.querySelector('[data-testid="agent-message-input"]');
    const isOpen = n => n && !n.classList.contains('agent-chat-collapsed');
    const visible = n => n && n.getBoundingClientRect().width > 0 && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).display !== 'none';
    const activeFrame = () => {
      const slot = window.frameElement?.closest('.ns-frame-slot');
      return !slot || (!slot.inert && slot.dataset.active === 'true');
    };
    function setAttribute(node, key, value) {
      if (value === null) { if (node.hasAttribute(key)) node.removeAttribute(key); }
      else if (node.getAttribute(key) !== value) node.setAttribute(key,value);
    }
    function block(node) {
      if (!node || blocked.has(node)) return;
      originalAttributes.set(node,{inert:node.inert,aria:node.getAttribute('aria-hidden')});
      blocked.add(node); node.inert = true; setAttribute(node,'aria-hidden','true');
      node.dataset.m21Background = '';
    }
    function unblock() {
      for (const node of blocked) {
        const old = originalAttributes.get(node);
        node.inert = old.inert; setAttribute(node,'aria-hidden',old.aria);
        delete node.dataset.m21Background;
      }
      blocked.clear();
    }
    function rememberCaret() {
      const edit = input(), selection = getSelection();
      if (edit && selection?.rangeCount && edit.contains(selection.anchorNode) && edit.contains(selection.focusNode)) caret = {
        range:selection.getRangeAt(0).cloneRange(), anchor:selection.anchorNode, anchorOffset:selection.anchorOffset,
        focus:selection.focusNode, focusOffset:selection.focusOffset
      };
    }
    function focusInput() {
      const edit = input(); if (!edit || !activeFrame() || !wasDrawer || !isOpen(panel())) return;
      if (!edit.contains(document.activeElement)) edit.focus({preventScroll:true});
      if (caret?.anchor.isConnected && caret?.focus.isConnected && edit.contains(caret.anchor) && edit.contains(caret.focus)) {
        const selection = getSelection();
        if (selection.setBaseAndExtent) selection.setBaseAndExtent(caret.anchor,caret.anchorOffset,caret.focus,caret.focusOffset);
        else {selection.removeAllRanges();selection.addRange(caret.range);}
      }
    }
    function close() {
      if (!activeFrame() || composing) return;
      rememberCaret(); restoreFocus = true;
      document.querySelector('[data-testid="agent-collapse-button"]')?.click();
      schedule();
    }
    function popupOpen() {
      return [...document.querySelectorAll('[data-lovart-popover-content],[data-radix-popper-content-wrapper],[role="dialog"],[role="listbox"],[role="menu"]')]
        .some(n => n !== panel()?.closest('.right-panel-wrapper') && !n.contains(panel()) && !panel()?.contains(n) && visible(n));
    }
    function mirrorReceipt() {
      if (!mirror || !receipt) return;
      if (mirror.textContent !== receipt.textContent) mirror.textContent = receipt.textContent;
      for (const key of ['title','aria-label','data-save-state','data-saved-at','data-error']) setAttribute(mirror,key,receipt.getAttribute(key));
    }
    function findFixed(node) {
      for (let n=node; n && n !== document.body; n=n.parentElement) if (getComputedStyle(n).position === 'fixed') return n;
      return null;
    }
    function update() {
      raf = 0;
      const n = panel(), wrapper = n?.closest('.right-panel-wrapper');
      if (!n || !wrapper) return;
      wrapper.dataset.m21Drawer = '';
      const small = compact.matches;
      if (small && !wasCompact) enterPending = true;
      if (!small) enterPending = false;
      wasCompact = small;
      if (enterPending) {
        enterPending = false;
        // Resizing while typing keeps the same editor and caret in the drawer.
        if (isOpen(n) && !composing && !n.contains(document.activeElement)) document.querySelector('[data-testid="agent-collapse-button"]')?.click();
      }
      const drawer = small && isOpen(n);
      html.dataset.m21Compact = String(small);
      html.dataset.m21ChatOpen = String(!!isOpen(n));
      if (!mirror || !mirror.isConnected) {
        mirror = document.createElement('span'); mirror.id = 'm21-drawer-receipt';
        mirror.setAttribute('role','status'); mirror.setAttribute('aria-live','polite'); mirror.setAttribute('aria-atomic','true');
        wrapper.append(mirror);
      }
      const source = document.querySelector('#novart-bar .nv-save');
      if (source && source !== receipt) {
        receiptObserver?.disconnect(); receipt = source;
        receiptObserver = new MutationObserver(mirrorReceipt);
        receiptObserver.observe(receipt,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','data-save-state','data-saved-at','data-error']});
      }
      mirrorReceipt();
      if (drawer) {
        block(wrapper.parentElement.querySelector(':scope > main'));
        for (const id of ['novart-bar','novart-context','novart-switcher','novart-workflow','nv-workflow-summary','novart-availability']) block(document.getElementById(id));
        setAttribute(wrapper,'role','dialog'); setAttribute(wrapper,'aria-modal','true'); setAttribute(wrapper,'aria-label','创作对话');
        if (!wasDrawer && openRequested) requestAnimationFrame(focusInput);
      } else {
        unblock(); setAttribute(wrapper,'role',null); setAttribute(wrapper,'aria-modal',null); setAttribute(wrapper,'aria-label',null);
        const toggle = document.getElementById('nv-chat-toggle');
        // The original comparison layer reveals this button after its own RAF.
        // Consume the close intent only when it is actually focusable.
        if (restoreFocus && activeFrame() && visible(toggle) && !toggle.hidden && !toggle.closest('[inert]')) {
          toggle.focus({preventScroll:true}); restoreFocus = false;
        }
        if (!small) restoreFocus = false;
      }
      wasDrawer = drawer; openRequested = false;
      const floating = findFixed(document.querySelector('[data-testid="float-layer-button"]'));
      const toolbar = document.querySelector('[data-testid="bottom-toolbar"]');
      if (floating && toolbar) {
        const a=floating.getBoundingClientRect(),b=toolbar.getBoundingClientRect();
        // Stack rather than shrink when the two native controls share horizontal space.
        const overlap = a.x < b.right + 12 && a.right > b.x - 12;
        if (floating.dataset.m21FloatStack !== String(overlap)) floating.dataset.m21FloatStack = String(overlap);
      }
      html.dataset.m21LayoutReady = 'true';
    }
    function schedule() { if (!raf) raf = requestAnimationFrame(update); }
    // Only chat composition keeps the chat visible on resize. Canvas/title
    // composition must retain its own view rather than opening a chat drawer.
    document.addEventListener('compositionstart',event => {if (panel()?.contains(event.target)) composing=true;},true);
    document.addEventListener('compositionend',event => {if (panel()?.contains(event.target)) {composing=false;schedule();}},true);
    document.addEventListener('pointerdown', event => {
      if (event.target.closest?.('[data-testid="agent-collapse-button"]') && compact.matches) {rememberCaret();restoreFocus=true;}
    },true);
    document.addEventListener('click', event => {
      if (event.target.closest?.('#nv-chat-toggle')) {openRequested=true;schedule();}
      if (wasDrawer && event.target.closest?.('#nv-context-toggle,#nv-workflow-toggle')) close();
    },true);
    window.addEventListener('keydown', event => {
      if (!wasDrawer || !activeFrame() || composing || event.isComposing || event.keyCode === 229 || popupOpen()) return;
      if (event.key === 'Escape') {event.preventDefault();event.stopImmediatePropagation();close();return;}
      if (event.key !== 'Tab') return;
      const wrapper = panel()?.closest('.right-panel-wrapper'); if (!wrapper) return;
      const items = [...wrapper.querySelectorAll('button:not([disabled]),a[href],input,textarea,select,[contenteditable="true"],[tabindex]')]
        // Lexical's implicit contenteditable has DOM tabIndex=-1 but belongs
        // to the browser's natural Tab order. Respect explicit tabindex=-1.
        .filter(n => (n.tabIndex >= 0 || (n.isContentEditable && !n.hasAttribute('tabindex'))) && visible(n) && !n.closest('[inert]'));
      if (!items.length) return;
      const index = items.indexOf(document.activeElement), next = event.shiftKey ? index-1 : index+1;
      if (index < 0 || next < 0 || next >= items.length) {event.preventDefault();event.stopImmediatePropagation();items[event.shiftKey ? items.length-1 : 0].focus({preventScroll:true});}
    },true);
    compact.addEventListener('change',schedule);
    window.addEventListener('resize',schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden']});
    window.addEventListener('pagehide',() => {observer.disconnect();receiptObserver?.disconnect();cancelAnimationFrame(raf);unblock();}, {once:true});
    schedule();
  }
  if (document.readyState === 'complete') install();
  else document.addEventListener('DOMContentLoaded',install,{once:true});
})();
