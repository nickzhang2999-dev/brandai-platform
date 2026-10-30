/* Actual OwnedEditorClient intake/journal handlers with an in-memory loopback
 * API. This proves interaction/recovery boundaries, never model quality. */
'use strict';
const assert = require('node:assert/strict');

async function runOwnedLayerRepairChecks({page,origin,fixture,material,check,fixtureSettled,setStage,state,holdNext,releaseOld}) {
  // Deliver a late HTTP response even after the component cancels its scope.
  // This fixture transport makes the handler's scope guard observable instead
  // of letting a browser AbortError hide the old-scope 4xx cleanup branch.
  await page.addInitScript(()=>{const originalFetch=window.fetch.bind(window);window.fetch=(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input),location.href);
    return originalFetch(input,url.pathname.endsWith('/studio-image-tools')&&init?.method==='POST'?{...init,signal:undefined}:init);
  };});
  const journal=user=>'deepflare:image-tool-pending:'+JSON.stringify([user,fixture.workspaceId,fixture.projectId]);
  const taskUrl=origin+'/canvas?'+new URLSearchParams({workspaceId:fixture.workspaceId,projectId:fixture.projectId,layerRequestId:'fixture-decomposition'});
  const open=async()=>{await page.goto(taskUrl);await page.getByTestId('owned-layer-repair-open').waitFor();await page.getByTestId('owned-layer-repair-open').click();try{await page.getByRole('dialog',{name:'图片蒙版擦除',exact:true}).waitFor({timeout:8000});}catch(error){throw Error(error.message+'; fixture notices: '+await page.locator('[data-testid="owned-layer-notice"], [data-testid="owned-notice"]').allTextContents());}};
  const paint=async()=>{
    await page.waitForFunction(()=>document.querySelector('img[alt="待擦除原图"]')?.naturalWidth===12);
    await page.getByRole('slider',{name:'蒙版画笔范围',exact:true}).fill('4');
    const box=await page.getByTestId('owned-inpaint-mask').boundingBox();await page.mouse.move(box.x+box.width*.4,box.y+box.height*.4);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.5,{steps:4});await page.mouse.up();
  };
  setStage('editor-layer-repair-original-mask');await open();
  assert.equal(await page.getByRole('dialog',{name:'图片分层',exact:true}).isVisible(),false);
  assert.equal(await page.locator('img[alt="待擦除原图"]').getAttribute('src'),material.url);
  assert.match(await page.getByRole('dialog',{name:'图片蒙版擦除',exact:true}).innerText(),/遮挡处依据周围内容推断/);
  const baseline={canvas:state().canvas,writes:state().writes};assert.equal(state().imageToolInputs.length,0);
  check('actual-editor-opens-original-mask-and-closes-layer-modal-without-submitting');
  setStage('editor-layer-repair-lost-response');await paint();await page.getByRole('button',{name:'擦除并补全',exact:true}).click();
  await page.getByRole('dialog',{name:'图片蒙版擦除',exact:true}).getByRole('alert').waitFor();
  assert.equal(state().imageToolInputs.length,1);const original=state().imageToolInputs[0];assert.equal(original.decompositionRequestId,'fixture-decomposition');assert.equal(original.target.shapeId,'shape:repair-source');assert.equal(original.target.assetSha256,material.assetSha256);
  const retained=await page.evaluate(key=>localStorage.getItem(key),journal(fixture.userId));assert.deepEqual(JSON.parse(retained),original);
  await page.getByRole('button',{name:'关闭蒙版工具',exact:true}).click();
  await page.reload();await page.getByTestId('owned-layer-repair-open').waitFor();assert.equal(await page.getByTestId('owned-layer-repair-open').isDisabled(),true);
  await page.getByRole('button',{name:'关闭工具窗口',exact:true}).click();await page.getByRole('tab',{name:'任务记录',exact:true}).click();
  const resume=page.getByRole('button',{name:'检查上次图片编辑',exact:true});await resume.waitFor();assert.equal(state().imageToolInputs.length,1);
  check('actual-editor-retains-parent-mask-and-mutation-after-lost-response-and-refresh-without-auto-retry');
  setStage('editor-layer-repair-explicit-replay');await resume.click();await fixtureSettled(()=>state().imageToolInputs.length===2);
  await page.waitForFunction(key=>localStorage.getItem(key)===null,journal(fixture.userId));assert.deepEqual(state().imageToolInputs[1],original);assert.equal(state().canvas,baseline.canvas);assert.equal(state().writes,baseline.writes);
  check('actual-editor-explicit-recovery-replays-identical-payload-and-preserves-original-canvas');
  setStage('editor-layer-repair-late-old-scope-rejection');await open();await paint();holdNext();await page.getByRole('button',{name:'擦除并补全',exact:true}).click();await fixtureSettled(()=>state().imageToolInputs.length===3);
  const oldRequest=state().imageToolInputs[2],nextUser='fixture-user-next',nextRequest={...oldRequest,mutationId:'213a4129-41e6-46cf-b040-bb3572ebfe7c'};
  await page.evaluate(({key,input,user})=>{localStorage.setItem(key,JSON.stringify(input));window.changeFixtureUser(user);},{key:journal(nextUser),input:nextRequest,user:nextUser});
  await page.waitForFunction(()=>!document.querySelector('[aria-label="图片蒙版擦除"]'));
  await page.getByRole('tab',{name:'任务记录',exact:true}).click();await resume.waitFor();
  const oldResponse=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/studio-image-tools')&&response.status()===422);
  releaseOld();await oldResponse;await page.waitForTimeout(100);
  assert.deepEqual(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),journal(nextUser))),nextRequest);
  assert.equal(await resume.isVisible(),true);assert.equal(await resume.isEnabled(),true);assert.equal(state().imageToolInputs.length,3);
  assert.equal(state().canvas,baseline.canvas);assert.equal(state().writes,baseline.writes);
  check('actual-editor-late-old-scope-4xx-does-not-clear-new-scope-pending-journal-or-operation');
}

module.exports={runOwnedLayerRepairChecks};
