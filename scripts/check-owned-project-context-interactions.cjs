/* Exercise actual OwnedEditorClient and server-backed project context through
 * synthetic loopback persistence. This does not test real model quality. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
exports.runOwnedProjectContextChecks=async({page,fixture,check,fixtureSettled,setStage,context,state,setReadOnly,switchProject,loseNextConversation})=>{
  const originalProject=fixture.projectId;
  const sidebar=()=>page.getByTestId('owned-project-content');
  const info=()=>page.getByTestId('owned-project-context');
  const input=()=>page.getByRole('textbox',{name:'对话设计需求',exact:true});
  const ready=async()=>{await page.waitForFunction(()=>document.querySelector('[data-testid="owned-conversation"]')?.dataset.conversationReady==='true');};
  const savedDraft=async()=>{await page.waitForFunction(()=>document.querySelector('[data-testid="conversation-draft-status"]')?.dataset.saved==='true');};
  const open=async()=>{if(!await sidebar().isVisible())await page.getByRole('button',{name:'项目内容',exact:true}).click();if(!await info().getAttribute('open'))await info().locator('summary').click();await info().getByRole('textbox',{name:'项目目标',exact:true}).waitFor();};
  const save=async()=>{const before=context.current(fixture.projectId).revision;await info().getByRole('button',{name:'保存项目资料',exact:true}).click();await fixtureSettled(()=>context.current(fixture.projectId).revision===before+1);await page.waitForFunction(()=>document.querySelector('[data-testid="owned-project-context"] summary')?.textContent?.includes('已保存'));};
  const close=async()=>{if(await sidebar().isVisible())await sidebar().getByRole('button',{name:'收起项目内容',exact:true}).click();};

  setStage('project-context-confirm-and-refresh');await page.reload();await ready();await open();
  await info().getByRole('textbox',{name:'目标受众',exact:true}).fill('保留的受众');
  await info().getByRole('textbox',{name:'已确认文案',exact:true}).fill('保留的文案');
  await info().getByRole('combobox',{name:'项目起点',exact:true}).selectOption('product');
  const writesBeforePreset=context.writes.length;await info().getByRole('button',{name:'补充空白目标与要求',exact:true}).click();
  assert.match(await info().getByRole('textbox',{name:'项目目标',exact:true}).inputValue(),/产品主图/);
  assert.equal(await info().getByRole('textbox',{name:'目标受众',exact:true}).inputValue(),'保留的受众');
  assert.equal(await info().getByRole('textbox',{name:'已确认文案',exact:true}).inputValue(),'保留的文案');
  assert.equal(context.writes.length,writesBeforePreset);assert.equal(context.current(fixture.projectId).facts.goal,'');assert.equal(state().conversationPosts.length,0);
  await save();const presetGoal=await info().getByRole('textbox',{name:'项目目标',exact:true}).inputValue(),presetVisual=await info().getByRole('textbox',{name:'视觉要求',exact:true}).inputValue();
  await info().getByRole('combobox',{name:'项目起点',exact:true}).selectOption('packaging');assert.equal(await info().getByRole('button',{name:'补充空白目标与要求',exact:true}).isDisabled(),true);
  assert.equal(await info().getByRole('textbox',{name:'项目目标',exact:true}).inputValue(),presetGoal);assert.equal(await info().getByRole('textbox',{name:'视觉要求',exact:true}).inputValue(),presetVisual);
  assert.equal(context.current(fixture.projectId).facts.goal,presetGoal);check('optional-task-start-only-fills-empty-draft-fields-preserves-copy-and-audience-and-requires-save');
  await info().getByRole('textbox',{name:'项目目标',exact:true}).fill('春季茶饮海报，社交平台发布');
  await info().getByRole('textbox',{name:'目标受众',exact:true}).fill('年轻消费者');
  await info().getByRole('textbox',{name:'已确认文案',exact:true}).fill('春日新味');
  await info().getByRole('textbox',{name:'视觉要求',exact:true}).fill('紫色系，保留产品包装');await save();
  assert.equal(state().conversationPosts.length,0);await page.reload();await ready();await open();
  assert.equal(await info().getByRole('textbox',{name:'项目目标',exact:true}).inputValue(),'春季茶饮海报，社交平台发布');
  assert.equal(await info().getByRole('textbox',{name:'已确认文案',exact:true}).inputValue(),'春日新味');
  assert.equal(await page.getByRole('checkbox',{name:'沿用项目资料',exact:true}).isChecked(),true);
  check('confirmed-facts-survive-refresh-through-server-with-visible-default-use-and-no-model-submit');

  setStage('project-context-material-roles');await sidebar().getByRole('tab',{name:'素材',exact:true}).click();
  await sidebar().getByRole('combobox',{name:'素材职责 context-a.png',exact:true}).selectOption('PRODUCT');
  await sidebar().getByRole('combobox',{name:'素材职责 context-b.png',exact:true}).selectOption('STYLE');await save();
  assert.deepEqual(context.current(fixture.projectId).materials.map(({assetId,role})=>({assetId,role})),[{assetId:'context-a',role:'PRODUCT'},{assetId:'context-b',role:'STYLE'}]);
  assert.equal(state().conversationDraft?.references.length??0,0);check('product-facts-and-style-responsibilities-save-without-changing-current-composer-references');

  setStage('project-context-master-and-explicit-target');await sidebar().getByRole('tab',{name:'画布',exact:true}).click();
  await sidebar().getByRole('button',{name:'查看图片1',exact:true}).click();await fixtureSettled(()=>state().conversationDraft?.quickEditTargetId==='shape:context-a');await savedDraft();
  await info().getByRole('button',{name:'将选中图片设为主稿',exact:true}).click();await info().getByTestId('project-master-name').filter({hasText:'context-a.png'}).waitFor();await save();
  await sidebar().getByRole('button',{name:'查看图片2',exact:true}).click();await fixtureSettled(()=>state().conversationDraft?.quickEditTargetId==='shape:context-b');await savedDraft();
  assert.equal(context.current(fixture.projectId).master.assetId,'context-a');await close();
  await input().fill('只修改当前选中的图片，保持产品内容');await savedDraft();await page.getByRole('button',{name:'发送',exact:true}).click();
  await fixtureSettled(()=>state().conversationPosts.length===1);await fixtureSettled(()=>state().conversationDraft?.text==='');
  const submitted=state().conversationPosts[0];assert.equal(submitted.projectContextRevision,context.current(fixture.projectId).revision);
  assert.equal(submitted.quickEditTargetId,'shape:context-b');assert.equal(submitted.references.find(value=>value.referenceId===submitted.quickEditTargetId).assetId,'context-b');
  assert.ok(!submitted.references.some(value=>value.assetId==='context-a'));assert.equal(context.current(fixture.projectId).master.assetId,'context-a');
  check('selected-master-is-separate-from-current-edit-target-and-next-explicit-submit-freezes-context-revision');

  setStage('project-context-current-request-opt-out');await page.getByRole('checkbox',{name:'沿用项目资料',exact:true}).uncheck();
  await input().fill('本轮只参考当前图片');await savedDraft();await page.getByRole('button',{name:'发送',exact:true}).click();
  await fixtureSettled(()=>state().conversationPosts.length===2);assert.equal('projectContextRevision' in state().conversationPosts[1],false);
  await fixtureSettled(()=>state().conversationDraft?.text==='');check('user-can-explicitly-disable-project-context-without-erasing-confirmed-project-data');

  setStage('project-context-pending-replay');await page.getByRole('checkbox',{name:'沿用项目资料',exact:true}).check();
  await input().fill('保持本轮已确认资料，等待提交回执');await savedDraft();loseNextConversation();const pendingPosts=state().conversationPosts.length;
  await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('button',{name:'检查上次提交',exact:true}).waitFor();
  const frozen=structuredClone(state().conversationPosts[pendingPosts]);context.update(fixture.projectId,value=>({...value,revision:value.revision+1,facts:{...value.facts,audience:'提交后另一人更新的受众'}}));
  await page.reload();await ready();await page.getByRole('button',{name:'检查上次提交',exact:true}).waitFor();assert.equal(state().conversationPosts.length,pendingPosts+1);
  await page.getByRole('button',{name:'检查上次提交',exact:true}).click();await fixtureSettled(()=>state().conversationPosts.length===pendingPosts+2);await fixtureSettled(()=>state().conversationDraft?.text==='');
  assert.deepEqual(state().conversationPosts[pendingPosts+1],frozen);assert.notEqual(frozen.projectContextRevision,context.current(fixture.projectId).revision);
  check('uncertain-submit-refresh-and-explicit-replay-preserve-original-context-target-and-mutation-without-auto-submit');

  setStage('project-context-conflict');await open();await info().getByRole('textbox',{name:'项目目标',exact:true}).fill('我的未保存目标');
  context.configure({conflictNext:true});await info().getByRole('button',{name:'保存项目资料',exact:true}).click();await info().getByRole('button',{name:'保留我的修改',exact:true}).waitFor();
  assert.equal(await info().getByRole('textbox',{name:'项目目标',exact:true}).inputValue(),'我的未保存目标');
  assert.equal(context.current(fixture.projectId).facts.goal,'同事更新的项目目标');
  await info().getByRole('button',{name:'保留我的修改',exact:true}).click();assert.equal(context.current(fixture.projectId).facts.goal,'同事更新的项目目标');await save();
  assert.equal(context.current(fixture.projectId).facts.goal,'我的未保存目标');check('conflict-keeps-both-versions-and-requires-explicit-rebase-and-save');

  setStage('project-context-lost-save');await info().getByRole('textbox',{name:'目标受众',exact:true}).fill('通勤人群');context.configure({lostNext:true});
  const writes=context.writes.length;await info().getByRole('button',{name:'保存项目资料',exact:true}).click();await info().getByRole('button',{name:'确认上次保存',exact:true}).waitFor();
  await info().getByRole('button',{name:'确认上次保存',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="owned-project-context"] summary')?.textContent?.includes('已保存'));
  assert.equal(context.writes.length,writes+1);check('lost-save-receipt-is-confirmed-by-reading-without-a-duplicate-write');

  setStage('project-context-stale-source');context.update(fixture.projectId,value=>({...value,issues:[{scope:'master',assetId:'context-a',code:'SOURCE_CHANGED',message:'测试图片来源变化'}]}));
  await info().getByRole('button',{name:'读取最新',exact:true}).click();await info().getByText('内容已变化',{exact:false}).waitFor();await close();
  await page.getByRole('checkbox',{name:'沿用项目资料',exact:true}).check();await input().fill('来源变化时不可默默沿用');await savedDraft();
  const before=state().conversationPosts.length;await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('项目资料中的图片来源已变化',{exact:false}).waitFor();
  assert.equal(state().conversationPosts.length,before);check('stale-master-is-explained-and-blocks-submission-before-model-or-conversation-post');
  await open();await info().getByRole('button',{name:'清除主稿',exact:true}).click();await save();assert.equal(context.current(fixture.projectId).master,null);
  check('master-can-be-cleared-without-deleting-the-canvas-image-or-other-project-facts');

  setStage('project-context-readonly');setReadOnly(true);await page.evaluate(()=>window.changeFixtureReadOnly(true));
  assert.equal(await info().getByRole('textbox',{name:'项目目标',exact:true}).isDisabled(),true);assert.equal(await info().getByRole('button',{name:'保存项目资料',exact:true}).isDisabled(),true);
  assert.equal(await info().getByRole('button',{name:'将选中图片设为主稿',exact:true}).isDisabled(),true);check('read-only-context-remains-visible-with-all-mutations-disabled');
  setReadOnly(false);await page.evaluate(()=>window.changeFixtureReadOnly(false));

  const output=path.resolve(__dirname,'../.novart-build/project-context-interactions');fs.mkdirSync(output,{recursive:true});
  await page.screenshot({path:path.join(output,'01-project-context-desktop.png')});await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(output,'02-project-context-mobile.png')});await page.setViewportSize({width:1366,height:850});
  check('compact-project-context-stays-inside-desktop-and-mobile-layout');

  setStage('project-context-load-failure');context.configure({failRead:true});await page.reload();await ready();await page.getByRole('button',{name:'项目内容',exact:true}).click();await info().locator('summary').click();await info().getByText('项目资料暂时无法读取。',{exact:true}).waitFor();
  assert.equal(await info().getByRole('textbox',{name:'项目目标',exact:true}).count(),0);assert.equal(await info().getByRole('button',{name:'保存项目资料',exact:true}).isDisabled(),true);
  context.configure({failRead:false});await info().getByRole('button',{name:'读取最新',exact:true}).click();await info().getByRole('textbox',{name:'项目目标',exact:true}).waitFor();check('failed-context-load-never-invents-or-saves-empty-project-facts');

  setStage('project-context-switch-project');context.configure({delayRead:600});const reads=context.reads;await info().getByRole('button',{name:'读取最新',exact:true}).click();await fixtureSettled(()=>context.reads>reads);
  const next=switchProject();await page.evaluate(projectId=>window.changeFixtureProject(projectId),next);context.configure({delayRead:0});await ready();await open();
  assert.equal(await info().getByRole('textbox',{name:'项目目标',exact:true}).inputValue(),'');await page.waitForTimeout(750);
  assert.equal(await info().getByRole('textbox',{name:'项目目标',exact:true}).inputValue(),'');assert.equal(context.current(originalProject).facts.goal,'我的未保存目标');
  assert.equal(await page.getByRole('checkbox',{name:'沿用项目资料',exact:true}).isChecked(),false);check('project-switch-clears-old-facts-usage-and-ignores-late-previous-project-reads');
};
