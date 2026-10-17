/** Exercise the actual Next-compiled codec, not its TS source. Synthetic pixels
 * only; the route entry/auth/database are deliberately not executed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { readPsd, initializeCanvas } = require('ag-psd');

async function main() {
  const root = path.resolve(__dirname, '..');
  const server = path.join(root, '.next/server');
  const route = path.join(server, 'app/api/workspaces/[wsId]/studio/decomposition/[requestId]/export/route.js');
  const runtime = require(path.join(server, 'webpack-runtime.js'));
  const routeRequire = createRequire(route);
  // Register the route's native externals without running its entry point.
  const registerOnly = Object.assign(() => { throw Error('Route entry must not execute'); }, { C: runtime.C, X: () => ({}) });
  vm.runInNewContext(fs.readFileSync(route, 'utf8'), {
    exports: {}, module: { exports: {} }, __filename: route, __dirname: path.dirname(route),
    require: name => name.endsWith('webpack-runtime.js') ? registerOnly : routeRequire(name),
    process, Buffer, console,
  }, { filename: route, timeout: 5000 });
  const candidates = [];
  for (const file of fs.readdirSync(path.join(server, 'chunks')).filter(name => name.endsWith('.js'))) {
    const chunk = require(path.join(server, 'chunks', file));
    for (const [id, factory] of Object.entries(chunk.modules ?? {})) {
      if (factory.toString().includes("throw new Error('empty-layer')")) {
        runtime.C(chunk); candidates.push(id);
      }
    }
  }
  assert.equal(candidates.length, 1, 'Find exactly one compiled PSD codec');
  const functions = Object.values(runtime(candidates[0])).filter(value => typeof value === 'function' && value.length === 5);
  assert.equal(functions.length, 1, 'Find the compiled five-argument encoder');
  const encode = functions[0], width = 8, height = 8;
  const sources = [];
  for (const alpha of [255, 4]) {
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([120, 70, 220, alpha], i);
    sources.push(await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer());
  }
  const layers = sources.map((body, order) => ({ order, width, height, sizeBytes: body.length,
    assetSha256: createHash('sha256').update(body).digest('hex') }));
  const body = await encode(width, height, layers, async layer => sources[layer.order], AbortSignal.timeout(10000));
  initializeCanvas(() => { throw Error('No canvas needed'); }, (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));
  const document = readPsd(body, { useImageData: true });
  assert.equal(document.children.length, 2);
  assert.equal(document.children[0].imageData.data[3], 4);
  console.log(JSON.stringify({ passed: true, compiledNextCodec: true, syntheticPixels: true, modelCalls: 0, layerCount: 2, faintAlpha: 4, sizeBytes: body.length }));
}
main().catch(error => { console.error(JSON.stringify({ passed: false, name: error.name, status: error.status, message: error.message })); process.exitCode = 1; });
