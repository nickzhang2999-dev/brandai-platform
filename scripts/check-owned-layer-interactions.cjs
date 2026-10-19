/* Actual React UI against full-frame PNG loopback fixtures. This only verifies
 * browser behaviour; the PNG fixtures are never AI/provider acceptance. */
'use strict';
const assert = require('node:assert/strict');

async function runOwnedLayerChecks({page,surface,origin,fixture,png,material,layerResults,shapes,check,report,setStage,allowLayerDownloads,state,failureOnly=false,queueRecovery=false}) {
  const button=name=>page.getByRole('button',{name,exact:true});
  const waitSaved=async()=>{await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==='saved');};
  const save=async()=>{if(!await page.getByRole('dialog',{name:'图片分层',exact:true}).isVisible()){const control=button('保存');if(await control.isEnabled())await control.click();}await waitSaved();};
  const sourceRecord=()=>shapes().find(value=>value.meta?.novartAssetId===material.assetId);

  setStage('layers-empty-canvas');assert.equal(await button('选图AI分层').count(),0);assert.equal(await button('开始 AI 分层').isVisible(),false);assert.equal(state().decompositionPosts,0);check('empty-canvas-cannot-request-ai-layers');
  setStage('layers-upload-and-saved-selection');await page.locator('input[type=file]').first().setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});
  const sourceNode=page.locator('[data-testid="owned-canvas-item"][data-kind="image"]');await sourceNode.waitFor();await save();
  const sourceId=sourceRecord().id;assert.equal(shapes().length,1);await sourceNode.click();await button('选图AI分层').click();await page.getByTestId('owned-layer-panel').waitFor();
  assert.equal(await sourceNode.getAttribute('data-selected'),'true');assert.equal(await button('开始 AI 分层').isEnabled(),true);check('uploaded-persistent-source-selected-and-saved-before-ai-layers');
  const options=page.getByTestId('owned-layer-options');
  await options.getByText('按内容自动拆分，无需指定层数。',{exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'拆分层数',exact:true}).count(),0);
  await options.locator('summary').click();
  await options.getByRole('radio',{name:'手动指定层数',exact:true}).check();
  await page.getByRole('combobox',{name:'拆分层数',exact:true}).selectOption('2');await page.getByRole('textbox',{name:'分层说明',exact:true}).fill('Fixture only: preserve foreground and background');
  const acceptedRevision=state().revision;setStage('layers-submit-and-poll');await button('开始 AI 分层').click();
  const task=page.getByTestId('owned-layer-task');await task.getByText('等待处理',{exact:true}).waitFor();
  assert.equal(state().decompositionPosts,1);assert.equal(state().decompositionPostInputs[0].documentRevision,acceptedRevision);assert.equal(state().decompositionPostInputs[0].sourceShapeId,sourceId);
  assert.equal(state().decompositionPostInputs[0].assetId,material.assetId);assert.equal(state().decompositionPostInputs[0].assetSha256,material.assetSha256);
  assert.equal(state().decompositionPostInputs[0].layerMode,'MANUAL');assert.equal(state().decompositionPostInputs[0].layerCount,2);
  await page.locator('[data-testid="owned-layer-task"][data-status="RUNNING"]').waitFor();
  if (failureOnly) {
    await page.locator('[data-testid="owned-layer-task"][data-status="FAILED"]').waitFor();
    const notice=page.getByTestId('owned-layer-task');
    if(queueRecovery) {
      await notice.filter({hasText:'分层等待超时'}).waitFor();
      assert.equal(await button('用同样设置重新分层').count(),0);
      await page.reload();await surface.waitFor();await page.getByTestId('owned-canvas-item').click();await button('选图AI分层').click();
      await button('检查并保存已有结果').click();
      await notice.filter({hasText:'图层已保存'}).waitFor();
      assert.equal(state().decompositionPosts,1);assert.equal(state().layerRecoveryPosts,1);
      assert.equal(shapes().length,1);assert.notEqual(sourceRecord().meta?.novartOwned?.hidden,true);
      check('expired-provider-task-survives-reload-and-recovers-via-explicit-read-without-resubmission');
      await page.reload();await surface.waitFor();await page.getByTestId('owned-canvas-item').click();await button('选图AI分层').click();
      await button('展开为可编辑图层').waitFor();
      assert.equal(state().decompositionPosts,1);assert.equal(state().layerRecoveryPosts,1);
      check('recovered-result-persists-and-remains-explicitly-placeable');
      report.unverified=['This fixture tests UI recovery only; no real provider or database is used'];
      return;
    }
    await notice.filter({hasText:'HTTP 400'}).waitFor();
    assert.ok(!(await notice.innerText()).includes('任务仍会继续'));
    await page.waitForTimeout(3000);assert.equal(state().decompositionPosts,1);
    assert.equal(shapes().length,1);assert.notEqual(sourceRecord().meta?.novartOwned?.hidden,true);
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await notice.filter({hasText:'HTTP 400'}).waitFor();
    assert.equal(state().decompositionPosts,1);
    check('failed-task-replaces-running-notice-preserves-source-and-does-not-retry');
    report.unverified=['Real provider failure and model quality; this is a local fixture UI test'];
    return;
  }
  await page.locator('[data-testid="owned-layer-task"][data-status="SUCCEEDED"]').waitFor();
  await page.getByTestId('owned-layer-notice').filter({hasText:'图层已保存'}).waitFor();
  assert.deepEqual([...new Set(state().layerTaskReads.map(value=>value.status))],['PENDING','RUNNING','SUCCEEDED']);assert.equal(shapes().length,1);assert.notEqual(sourceRecord().meta?.novartOwned?.hidden,true);
  check('strict-saved-source-request-pending-running-succeeded-without-auto-insert');

  setStage('layers-failed-download-is-atomic');const unchanged=state().canvas,baselineWrites=state().writes;await button('展开为可编辑图层').click();
  await page.getByTestId('owned-layer-notice').filter({hasText:'图层暂时无法读取，原图未改动'}).waitFor();
  assert.equal(state().canvas,unchanged);assert.equal(state().writes,baselineWrites);assert.equal(shapes().length,1);
  assert.ok(state().layerDownloads.some(value=>value.order===0&&!value.failed));assert.ok(state().layerDownloads.some(value=>value.order===1&&value.failed));
  check('second-layer-download-failure-inserts-no-partial-group-and-preserves-source');
  setStage('layers-retry-download-and-placement');allowLayerDownloads();await page.reload();await surface.waitFor();await page.locator('[data-testid="owned-canvas-item"][data-kind="image"]').click();await button('选图AI分层').click();await button('展开为可编辑图层').waitFor();
  const actualPngs=await page.evaluate(async paths=>{
    const result=[];
    for(const path of paths) {
      const bytes=await (await fetch(path,{cache:'no-store'})).blob(),image=await createImageBitmap(bytes),canvas=document.createElement('canvas');
      canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);
      const pixels=context.getImageData(0,0,image.width,image.height).data;let transparent=0,ink=0;
      for(let offset=3;offset<pixels.length;offset+=4){if(pixels[offset]<255)transparent++;if(pixels[offset]>=64)ink++;}
      result.push({width:image.width,height:image.height,transparent,ink});image.close();
    }
    return result;
  },layerResults.map(value=>value.url));
  assert.deepEqual(actualPngs.map(value=>[value.width,value.height]),[[12,8],[12,8]]);assert.equal(actualPngs[0].transparent,0);assert.equal(actualPngs[1].transparent,84);assert.equal(actualPngs[1].ink,12);
  check('two-real-full-frame-png-fixtures-decode-with-transparent-foreground');
  await button('展开为可编辑图层').click();await page.getByTestId('owned-layer-notice').filter({hasText:'已展开图层'}).waitFor();await save();
  assert.equal(shapes().length,3);assert.equal(sourceRecord().id,sourceId);assert.notEqual(sourceRecord().meta.novartOwned.hidden,true);
  const placed=shapes().filter(value=>value.id!==sourceId),groupId=placed[0].meta.novartOwned.groupId;
  assert.ok(groupId);assert.equal(placed[1].meta.novartOwned.groupId,groupId);
  for(const layer of placed) {assert.equal(layer.x,sourceRecord().x+sourceRecord().props.w+48);assert.equal(layer.y,sourceRecord().y);assert.equal(layer.props.w,sourceRecord().props.w);assert.equal(layer.props.h,sourceRecord().props.h);}
  assert.equal(await page.getByTestId('owned-canvas-item').count(),3);check('all-layers-insert-as-one-aligned-group-beside-visible-retained-source');

  setStage('layers-idempotent-placement');const placedCanvas=state().canvas,placedWrites=state().writes;await button('展开为可编辑图层').click();await page.getByText('这一组图层已经在画布中，保留当前编辑。',{exact:true}).waitFor();await save();
  assert.equal(shapes().length,3);assert.equal(state().canvas,placedCanvas);assert.equal(state().writes,placedWrites);check('repeated-place-click-does-not-add-or-resave-duplicate-layers');
  setStage('layers-single-undo-redo');await button('关闭工具窗口').click();await button('撤销').click();await save();assert.equal(shapes().length,1);assert.equal(sourceRecord().id,sourceId);assert.notEqual(sourceRecord().meta?.novartOwned?.hidden,true);assert.equal(await page.getByTestId('owned-canvas-item').count(),1);
  await button('重做').click();await save();assert.equal(shapes().length,3);assert.notEqual(sourceRecord().meta.novartOwned.hidden,true);assert.equal(await page.getByTestId('owned-canvas-item').count(),3);check('one-undo-keeps-source-and-redo-restores-entire-layer-group');
  setStage('layers-refresh-and-persistence');const savedCanvas=state().canvas;await page.reload();await page.getByTestId('owned-canvas-item').nth(1).waitFor();await waitSaved();assert.equal(state().canvas,savedCanvas);assert.equal(shapes().length,3);assert.notEqual(sourceRecord().meta.novartOwned.hidden,true);
  await button('图层').click();assert.equal(await page.locator(`[data-testid="owned-layer-row"][data-layer-id="${sourceId}"]:not([data-hidden="true"])`).count(),1);check('save-refresh-retains-visible-source-and-layer-group');
  setStage('layers-deep-link-read-only');const baseline={canvas:state().canvas,writes:state().writes,posts:state().decompositionPosts,reads:state().layerTaskReads.length};
  await page.goto(origin+'/canvas?'+new URLSearchParams({workspaceId:fixture.workspaceId,projectId:fixture.projectId,layerRequestId:'fixture-decomposition'}));
  await page.getByTestId('owned-layer-panel').waitFor();await page.locator('[data-testid="owned-layer-task"][data-status="SUCCEEDED"]').waitFor();await page.waitForTimeout(300);
  assert.ok(state().layerTaskReads.slice(baseline.reads).some(value=>value.direct&&value.requestId==='fixture-decomposition'));assert.equal(state().canvas,baseline.canvas);assert.equal(state().writes,baseline.writes);assert.equal(state().decompositionPosts,baseline.posts);assert.equal(shapes().length,3);
  check('layer-request-deep-link-opens-existing-panel-without-model-call-or-placement');
  report.layerFixture={decompositionPosts:state().decompositionPosts,sourceSize:[12,8],layerPngs:actualPngs,statuses:[...new Set(state().layerTaskReads.map(value=>value.status))],sourcePreserved:true,downloadFailureAtomic:true,taskReads:state().layerTaskReads.length};
  report.unverified=['Real AI decomposition quality and provider configuration','Database authorization, provider billing and private artifact publication'];
}

module.exports={runOwnedLayerChecks};
