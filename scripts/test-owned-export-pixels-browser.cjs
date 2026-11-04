/* Loopback-only PNG pixel regression using production exporter and browser decoder. */
'use strict';
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), http=require('node:http');
const {chromium}=require('playwright-core');
const repo=path.resolve(__dirname,'..');
const esbuildName=fs.readdirSync(path.join(repo,'node_modules/.pnpm')).find(name=>name.startsWith('esbuild@0.28.'));
const esbuild=require(path.join(repo,'node_modules/.pnpm',esbuildName,'node_modules/esbuild'));
const directory=fs.mkdtempSync(path.join(repo,'.novart-build/temporary/export-pixels-'));
let browser,server;
(async()=>{
  const entry=path.join(directory,'entry.ts');
  fs.writeFileSync(entry,`import {exportOwnedPng,exportOwnedSvg} from '${path.join(repo,'apps/web/src/lib/owned-canvas-export').replaceAll('\\','/')}'; import {emptyOwnedDocument} from '${path.join(repo,'apps/web/src/lib/owned-canvas-model').replaceAll('\\','/')}'; Object.assign(window,{exportOwnedPng,exportOwnedSvg,emptyOwnedDocument});`);
  await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent'});
  server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?fs.readFileSync(path.join(directory,'app.js')):'<script src="/app.js"></script>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,...(process.env.NOVART_CHROMIUM_EXECUTABLE?{executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result=await page.evaluate(async()=>{
    const src=document.createElement('canvas');src.width=1024;src.height=1024;
    const ctx=src.getContext('2d');ctx.fillStyle='#7c5cff';ctx.fillRect(0,0,1024,1024);ctx.fillStyle='#fff';ctx.fillRect(0,0,512,512);
    const bytes=await new Promise(resolve=>src.toBlob(resolve,'image/png'));
    const fetcher=async()=>new Response(bytes,{headers:{'content-type':'image/png'}});
    const item={id:'shape:image',kind:'image',x:0,y:0,w:900,h:900,rotation:0,opacity:1,url:'/asset.png'};
    const doc={...window.emptyOwnedDocument(),items:[item]},before=JSON.stringify(doc);
    async function dimensions(options,document=doc){const blob=await window.exportOwnedPng(document,{fetcher,...options});const bitmap=await createImageBitmap(blob);const size=[bitmap.width,bitmap.height];bitmap.close();return size;}
    const sizes={source:await dimensions({pngResolution:'source'}),one:await dimensions({pngResolution:1}),two:await dimensions({pngResolution:2})};
    const cropped={...doc,items:[{...item,w:450,h:450,crop:{x:.25,y:.25,w:.5,h:.5},flipX:true}]};sizes.crop=await dimensions({pngResolution:'source'},cropped);
    const frame={id:'shape:frame',kind:'frame',x:0,y:0,w:300,h:200,rotation:0,opacity:1};
    sizes.frame=await dimensions({pngResolution:2,frameId:frame.id},{...doc,items:[frame,{...item,frameId:frame.id}]});
    const svg=await window.exportOwnedSvg(doc,{fetcher,pngResolution:2});
    const huge={...doc,items:[{...item,w:5000,h:5000}]};let failure='';try{await dimensions({pngResolution:2},huge);}catch(error){failure=error.message;}
    // Native source preservation may exceed the pixel cap even when canvas fits.
    const large=document.createElement('canvas');large.width=4096;large.height=4096;const largeBlob=await new Promise(resolve=>large.toBlob(resolve,'image/png'));
    let sourceFailure='';try{await window.exportOwnedPng(doc,{pngResolution:'source',fetcher:async()=>new Response(largeBlob,{headers:{'content-type':'image/png'}})});}catch(error){sourceFailure=error.message;}
    return {sizes,unchanged:before===JSON.stringify(doc),svgUnscaled:svg.includes('width="900" height="900" viewBox="0 0 900 900"'),failure,sourceFailure};
  });
  assert.deepEqual(result.sizes,{source:[1024,1024],one:[900,900],two:[1800,1800],crop:[512,512],frame:[600,400]});
  assert.equal(result.unchanged,true);assert.equal(result.svgUnscaled,true);assert.match(result.failure,/8192/);assert.match(result.sourceFailure,/1600/);
  console.log(JSON.stringify({loopback:true,providerCalls:0,...result},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());assert.equal(path.dirname(directory),path.join(repo,'.novart-build/temporary'));fs.rmSync(directory,{recursive:true,force:true});});
