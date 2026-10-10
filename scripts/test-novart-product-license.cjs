'use strict';
// Test the real bootstrap's configuration/SDK-refusal UI blocks. This does not
// simulate a successful SDK license or substitute for production acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../deploy/novart/studio/novart-product-bootstrap.js'), 'utf8');
const prefixEnd = source.indexOf('  const NativeWebSocket =');
const uiStart = source.indexOf('  let nativeLicenseRejected =');
const uiEnd = source.indexOf('  const message =', uiStart);
assert(prefixEnd > 0 && uiStart > prefixEnd && uiEnd > uiStart, 'Bootstrap test boundaries changed');
const testedSource = source.slice(0, prefixEnd) + source.slice(uiStart, uiEnd) + '\n})();';

function setup(canvasLicense, pathname = '/canvas') {
  const nodes = [], observers = [], listeners = {};
  let marker = false;
  function element(tag = 'div') {
    return { tag, dataset: {}, style: {}, children: [], isConnected: false,
      textContent: '', setAttribute(name, value) { this[name] = value; },
      append(...children) { this.children.push(...children); for (const child of children) child.isConnected = true; },
      replaceChildren(...children) { this.children = children; },
    };
  }
  const startup = element();
  const document = { documentElement: { dataset: {} }, body: element('body'),
    getElementById() { return { textContent: JSON.stringify({ canvasLicense, workspaceId: 'fixture-workspace' }) }; },
    querySelector(selector) { assert.equal(selector, '[data-testid="tl-license-expired"]'); return marker ? {} : null; },
    createElement(tag) { const node = element(tag); nodes.push(node); return node; },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const sandbox = { document, startup, location: { pathname }, MutationObserver, clearTimeout() {},
    addEventListener(name, callback) { listeners[name] = callback; }, };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(testedSource, sandbox);
  return { sandbox, nodes, startup, document, observers, listeners, reject() { marker = true; observers[0].callback(); } };
}

for (const input of [undefined, { key: '', status: 'missing' }, { key: 'synthetic\nprivate', status: 'invalid' }, { key: 7, status: 'invalid' }]) {
  const fixture = setup(input);
  assert.equal(fixture.sandbox.__NOVART_TLDRAW_LICENSE_KEY, '');
  assert.equal(fixture.nodes.filter(node => node.className === 'np-note np-license-note').length, 1);
  assert(!fixture.nodes.some(node => node.textContent.includes('synthetic')));
}
const configured = setup({ key: 'synthetic-not-a-real-license', status: 'configured' });
const descriptor = Object.getOwnPropertyDescriptor(configured.sandbox, '__NOVART_TLDRAW_LICENSE_KEY');
assert.equal(descriptor.value, 'synthetic-not-a-real-license');
assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false); assert.equal(descriptor.enumerable, false);
assert.throws(() => vm.runInContext('"use strict"; globalThis.__NOVART_TLDRAW_LICENSE_KEY="changed"', configured.sandbox));
assert(!configured.nodes.some(node => node.className === 'np-note np-license-note'));
assert.equal(configured.startup.dataset.state, undefined, 'Configured is not a simulated license verdict');
configured.reject();
assert.equal(configured.startup.dataset.state, 'license-required');
assert.equal(configured.document.documentElement.dataset.nvStudioCanvasReady, 'false');
assert.equal(configured.startup.isConnected, true, 'Direct canvas refusal must restore a visible explanation');
assert(configured.startup.children[0].textContent.includes('此域名授权'));
assert.equal(configured.startup.children[1].textContent, '返回项目库');
assert(!configured.startup.children.some(node => node.tag === 'button'));
assert.equal(configured.observers[0].disconnected, true);
const count = configured.nodes.length; configured.reject(); assert.equal(configured.nodes.length, count);
const ordinary = setup({ key: '', status: 'missing' });
ordinary.observers[0].callback(); assert.equal(ordinary.startup.dataset.state, undefined, 'Only the actual SDK marker triggers refusal');
ordinary.listeners.pagehide(); assert.equal(ordinary.observers[0].disconnected, true);
const homepage = setup({ key: '', status: 'missing' }, '/studio');
assert(!homepage.nodes.some(node => node.className === 'np-note np-license-note'));
assert.equal(homepage.observers.length, 0);
assert(source.indexOf("Object.defineProperty(globalThis, '__NOVART_TLDRAW_LICENSE_KEY'") < source.indexOf('const scripts=['));
assert(source.includes('if (nativeLicenseRejected) return;'));
console.log('Product license bootstrap checks passed; no licensed production claim.');
