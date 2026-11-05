/** Real browser interaction with synthetic receipts, not model-quality proof. */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
const webRoot=fileURLToPath(new URL("../../apps/web/",import.meta.url));
const r=createRequire(new URL("../../apps/web/package.json",import.meta.url));
const {build}=createRequire(r.resolve("tsx"))("esbuild");
const {outputFiles}=await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {OwnedLayerResolution} from './src/components/owned-canvas/OwnedLayerResolution';
const root=createRoot(document.getElementById('root'));
window.show=(mode)=>root.render(<OwnedLayerResolution task={{sourceWidth:1000,sourceHeight:1000,layers:[{assetId:'a',order:0,width:1000,height:1000,...(mode==='legacy'?{}:{resolution:{providerWidth:640,providerHeight:640,scaleX:1.5625,scaleY:1.5625,rgbSource:mode==='protected'?'SOURCE_VISIBLE':'PROVIDER',sourcePixelCount:500000}})}]}}/>);
window.show('protected');`,resolveDir:webRoot,loader:"tsx"},bundle:true,write:false,platform:"browser",jsx:"automatic"});
const server=createServer((req,res)=>{res.setHeader("Content-Type",req.url==="/app.js"?"application/javascript":"text/html; charset=utf-8");res.end(req.url==="/app.js"?outputFiles[0].contents:'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
try{
  browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    for(const [mode,pattern] of [['protected',/已保留 500000 个可见区域原图像素/],['provider',/颜色来自模型结果/],['legacy',/有效分辨率未知/]]){
      await page.evaluate(mode=>window.show(mode),mode);
      const panel=page.getByTestId('owned-layer-resolution');await panel.waitFor();
      const details=panel.locator('details');if(await details.getAttribute('open')===null)await details.locator('summary').click();
      await page.waitForFunction(([mode])=>document.querySelector('[data-testid="owned-layer-resolution"]').innerText.includes(mode==='protected'?'500000':mode==='legacy'?'有效分辨率未知':'颜色来自模型结果'),[mode]);
      assert.match(await panel.innerText(),pattern);
    }
  }
  assert.deepEqual(errors,[]);console.log('PASS: desktop/mobile layer provenance, legacy unknown, expandable measured pixel details');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
