/* Local synthetic API fixtures; actual production React and Chromium only.
 * No provider, authentication or database acceptance is claimed. */
'use strict';
const assert=require('node:assert/strict');
const zlib=require('node:zlib');
exports.runOwnedExperienceChecks=async function({page,surface,origin,fixture,check,shapes,setStage,state,addResult,allowResult,materialForHandoff,recoverArchivedResult}) {
  const button=name=>page.getByRole('button',{name,exact:true});
  const ready=()=>page.waitForFunction(()=>document.querySelector('[data-testid="owned-conversation"]')?.dataset.conversationReady==='true');
  const saved=()=>page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==='saved');
  const images=()=>page.locator('[data-kind="image"][data-owned-id]');
  const scene=()=>JSON.parse(zlib.gunzipSync(Buffer.from(state().canvas.slice('SHAKKERDATA://'.length),'base64')));
  const refreshTasks=async()=>{await button('任务记录').click();await button('刷新任务').click();await button('关闭工具窗口').click();};
  await ready();
  setStage('single-composer-and-panel-structure');
  assert.equal(await page.getByRole('textbox',{name:'对话设计需求',exact:true}).count(),1);
  assert.equal(await page.getByRole('textbox',{name:'创作需求',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'AI 分层',exact:true}).count(),0);
  check('one-conversation-composer-without-duplicate-global-layer-trigger');

  setStage('ready-image-auto-place-and-focus');
  addResult('one');await refreshTasks();await images().nth(0).waitFor();await saved();
  let list=shapes();assert.equal(list.length,1);assert.equal(list[0].x,0);assert.equal(list[0].y,0);
  assert.equal(await images().first().getAttribute('data-selected'),'true');
  check('completed-result-inserts-and-selects-image');

  setStage('world-placement-independent-of-panned-camera');
  await button('移动画布').click();const bounds=await surface.boundingBox();
  await page.mouse.move(bounds.x+300,bounds.y+400);await page.mouse.down();await page.mouse.move(bounds.x+800,bounds.y+650,{steps:6});await page.mouse.up();await saved();
  addResult('two');await refreshTasks();await images().nth(1).waitFor();await saved();
  addResult('three');await refreshTasks();await images().nth(2).waitFor();await saved();
  list=shapes();assert.deepEqual(list.map(item=>[item.x,item.y]),[[0,0],[0,176],[0,352]]);
  const selected=page.locator('[data-kind="image"][data-selected="true"]');assert.equal(await selected.count(),1);
  assert.equal(await selected.getAttribute('data-owned-id'),list[2].id);
  const focused=await selected.boundingBox(),viewport=await surface.boundingBox();
  assert.ok(focused.x>=viewport.x&&focused.y>=viewport.y&&focused.x+focused.width<=viewport.x+viewport.width&&focused.y+focused.height<=viewport.y+viewport.height,'Latest image is panned into the visible canvas');
  check('three-images-use-world-rows-and-latest-result-pans-into-view');

  setStage('placed-ledger-survives-refresh-and-user-deletion');
  const complete=state().canvas;await page.reload();await ready();await images().nth(2).waitFor();await saved();assert.equal(state().canvas,complete);
  await button('选择').click();await images().nth(2).click();await surface.focus();await page.keyboard.press('Delete');await saved();
  assert.equal(shapes().length,2);await page.reload();await ready();await saved();assert.equal(await images().count(),2);
  assert.deepEqual(scene().novartPlacedGenerations,['experience-one','experience-two','experience-three']);
  check('saved-result-ledger-prevents-reinsertion-after-refresh-and-explicit-delete');

  setStage('failed-image-fetch-retry');
  addResult('four',{fail:true});await refreshTasks();await button('重试放入').waitFor();assert.equal(await images().count(),2);
  assert.ok(!scene().novartPlacedGenerations.includes('experience-four'));
  allowResult('four');await button('重试放入').click();await images().nth(2).waitFor();await saved();assert.ok(scene().novartPlacedGenerations.includes('experience-four'));
  assert.equal(state().generationPosts,0);
  check('image-fetch-failure-keeps-result-retryable-without-a-new-generation');

  setStage('aspect-lock-shortcuts-and-preference');
  await button('调整图片像素尺寸').click();const width=page.getByRole('spinbutton',{name:'图片像素宽度',exact:true}),height=page.getByRole('spinbutton',{name:'图片像素高度',exact:true});
  assert.equal(await button('锁定宽高比例').getAttribute('aria-pressed'),'true');
  await width.fill('400');assert.equal(await height.inputValue(),'200');await height.fill('150');assert.equal(await width.inputValue(),'300');
  for(const [label,w,h] of [['50%',128,64],['100%',256,128],['200%',512,256]]){await button(label).click();assert.equal(await width.inputValue(),String(w));assert.equal(await height.inputValue(),String(h));}
  await button('锁定宽高比例').click();await width.fill('350');assert.equal(await height.inputValue(),'256');
  await button('关闭尺寸工具').click();await button('调整图片像素尺寸').click();assert.equal(await button('锁定宽高比例').getAttribute('aria-pressed'),'false');await button('关闭尺寸工具').click();
  await page.reload();await ready();await images().nth(2).click();await button('调整图片像素尺寸').click();assert.equal(await button('锁定宽高比例').getAttribute('aria-pressed'),'false');
  await button('锁定宽高比例').click();await button('关闭尺寸工具').click();
  check('resize-lock-default-ratio-shortcuts-unlocked-edit-and-refresh-preference');

  setStage('edit-result-beside-original');
  const source=shapes()[0];addResult('variant',{sourceShapeId:source.id});await refreshTasks();await images().nth(3).waitFor();await saved();
  const variant=shapes().find(item=>item.meta?.novartAssetId==='experience-variant');assert.ok(variant);assert.equal(variant.x,304);assert.equal(variant.y,0);
  assert.deepEqual(shapes().find(item=>item.id===source.id),source);
  check('edited-image-placed-beside-original-without-changing-source');

  setStage('archive-recovery-same-task-inserts-once');
  addResult('archive',{archiveFailed:true});await refreshTasks();assert.equal(await images().count(),4);assert.ok(!scene().novartPlacedGenerations.includes('experience-archive'));
  recoverArchivedResult('archive');await refreshTasks();await images().nth(4).waitFor();await saved();assert.ok(scene().novartPlacedGenerations.includes('experience-archive'));assert.equal(state().generationPosts,0);
  check('same-task-archive-failure-then-ready-still-inserts-once-without-generation');

  setStage('responsive-dialog-and-canvas');
  for(const viewport of [{width:1366,height:850},{width:1024,height:620},{width:390,height:740}]){
    await page.setViewportSize(viewport);await button('任务记录').click();const modal=await page.getByRole('dialog',{name:'任务记录',exact:true}).boundingBox();
    assert.ok(modal.x>=0&&modal.y>=0&&modal.x+modal.width<=viewport.width&&modal.y+modal.height<=viewport.height);
    await button('关闭工具窗口').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  check('task-modal-and-editor-fit-desktop-tablet-mobile');
  setStage('parent-handoff-auto-focus-save-receipt');await page.setViewportSize({width:1366,height:850});await page.goto(origin+'/shell');await page.waitForFunction(()=>receipts.some(r=>r.action==='ready'));
  const requestId=require('node:crypto').randomUUID();await page.evaluate(({requestId,projectId,material})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin),{requestId,projectId:fixture.projectId,material:materialForHandoff()});
  await page.waitForFunction(id=>receipts.some(r=>r.action==='insert-material-result'&&r.requestId===id),requestId);const receipt=await page.evaluate(id=>receipts.find(r=>r.action==='insert-material-result'&&r.requestId===id),requestId);
  assert.equal(receipt.status,'saved',receipt.error);check('parent-image-handoff-confirms-focus-and-save-in-one-receipt');
};
