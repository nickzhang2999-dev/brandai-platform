/* Additional real React canvas interaction checks for the existing isolated
 * loopback harness. The fixture is deliberately not provider acceptance. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function runOwnedToolChecks({page, surface, check, records, shapes, png, waitSaved}) {
  const button = name => page.getByRole('button', {name, exact:true});
  const node = id => page.locator(`[data-testid="owned-canvas-item"][data-owned-id="${id}"]`);
  const record = id => {const value=records()[id];assert.ok(value, `Expected persisted object ${id}`);return value;};
  const owned = value => value.meta?.novartOwned || {};
  const save = async () => {
    const control=button('保存');if(await control.isEnabled())await control.click();
    if(waitSaved)await waitSaved();
    await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==='saved');
  };
  const key = async value => {await surface.focus();await page.keyboard.press(value);};
  const clear = async () => {await key('Escape');await button('选择').click();};
  const row = id => page.locator(`[data-testid="owned-layer-row"][data-layer-id="${id}"]`);
  const openLayers = async () => {if(await button('图层').getAttribute('aria-expanded')!=='true')await button('图层').click();};
  const closeLayers = async () => {if(await button('图层').getAttribute('aria-expanded')==='true')await button('图层').click();};
  const select = async (id,additive=false) => {
    await openLayers();await row(id).locator('.oc-layer-select').click(additive?{modifiers:['Shift']}:{});await closeLayers();
  };
  const box = async locator => {const value=await locator.boundingBox();assert.ok(value&&value.width>0&&value.height>0);return value;};
  const draw = async (label,x,y,w,h,shape) => {
    await clear();await button(label).click();
    if(shape)await page.getByRole('combobox',{name:'图形种类',exact:true}).selectOption(shape);
    const bounds=await box(surface), previous=new Set(shapes().map(value=>value.id));
    await page.mouse.move(bounds.x+x,bounds.y+y);await page.mouse.down();
    await page.mouse.move(bounds.x+x+w,bounds.y+y+h,{steps:10});await page.mouse.up();await save();
    const added=shapes().find(value=>!previous.has(value.id));assert.ok(added, 'Pointer drawing must persist one new item');return added.id;
  };
  const field = async (name,value) => {const input=page.getByRole('spinbutton',{name,exact:true});await input.fill(String(value));await input.press('Tab');};
  const action = async name => {if(!await page.getByTestId('owned-object-menu').count())await button('更多元素操作').click();await page.getByRole('menuitem',{name,exact:true}).click();};
  const download = async label => {
    await button('导出').click();const pending=page.waitForEvent('download');await button(label).click();
    const file=await pending;assert.equal(await file.failure(),null);const location=await file.path();assert.ok(location);return fs.readFileSync(location);
  };
  const compareRaster = async (svg,pngBytes,requireInteriorContent=false) => {
    const result=await page.evaluate(async ({svg,png})=>{
      async function pixels(mime,base64) {
        const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('Downloaded image did not decode'));image.src=`data:${mime};base64,${base64}`;});
        const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        return {w:canvas.width,h:canvas.height,data:context.getImageData(0,0,canvas.width,canvas.height).data};
      }
      const a=await pixels('image/svg+xml',svg),b=await pixels('image/png',png);let differences=0,interiorInk=0;
      if(a.data.length===b.data.length)for(let index=0;index<a.data.length;index++)if(a.data[index]!==b.data[index])differences++;
      for(let y=12;y<b.h-12;y++)for(let x=12;x<b.w-12;x++) {const offset=(y*b.w+x)*4;if(b.data[offset+3]>0&&Math.min(b.data[offset],b.data[offset+1],b.data[offset+2])<245)interiorInk++;}
      return {a:[a.w,a.h],b:[b.w,b.h],differences,interiorInk};
    },{svg:svg.toString('base64'),png:pngBytes.toString('base64')});
    assert.deepEqual(result.a,result.b,'PNG and SVG export dimensions must match');assert.equal(result.differences,0,'PNG must preserve the SVG scene pixels');
    if(requireInteriorContent)assert.ok(result.interiorInk>50,'Frame background must not cover all child content with white pixels');return result.a;
  };

  await surface.waitFor();await save();
  assert.equal(shapes().filter(value=>value.type==='c-image').length,1,'New-tool checks start with one saved fixture image');
  await surface.evaluate(element=>{
    window.__ownedToolClipboardEvents=[];
    for(const type of ['copy','paste','keydown'])element.addEventListener(type,event=>{
      if(type==='keydown'&&(!(event.ctrlKey||event.metaKey)||!['c','v','d'].includes(event.key.toLowerCase())))return;
      window.__ownedToolClipboardEvents.push({type,key:event.key,target:event.target.tagName});
    },true);
  });
  const imageId=shapes().find(value=>value.type==='c-image').id, imageBefore=structuredClone(record(imageId));
  await node(imageId).click();await key('ControlOrMeta+c');await key('ControlOrMeta+v');await save();
  assert.equal(shapes().filter(value=>value.type==='c-image').length,2);
  await key('ControlOrMeta+v');await save();
  const secondPasteCount=shapes().filter(value=>value.type==='c-image').length;
  if(secondPasteCount!==3) {
    const observation=await page.evaluate(()=>({
      events:window.__ownedToolClipboardEvents,domImages:document.querySelectorAll('[data-owned-id][data-kind="image"]').length,
      state:document.querySelector('[data-testid="owned-editor"]').dataset.saveState,
      selected:document.querySelectorAll('[data-owned-id][data-selected="true"]').length,
      status:document.querySelector('.oc-status')?.textContent,
    }));
    assert.equal(secondPasteCount,3,'Repeated paste must persist a third image; '+JSON.stringify(observation));
  }
  assert.equal(new Set(shapes().map(value=>value.id)).size,shapes().length,'Repeated paste must create fresh unique shape identifiers');
  await button('撤销').click();await save();assert.equal(shapes().filter(value=>value.type==='c-image').length,2);
  // Undo removed the selected second paste. Select an existing object before
  // testing duplicate; Ctrl+D with an empty selection correctly does nothing.
  await select(imageId);await key('ControlOrMeta+d');await save();assert.equal(shapes().filter(value=>value.type==='c-image').length,3);
  const imageCopies=shapes().filter(value=>value.type==='c-image'&&value.id!==imageId);
  for(const copy of imageCopies) {
    assert.equal(copy.props.url,imageBefore.props.url);assert.equal(copy.meta.novartAssetSha256,imageBefore.meta.novartAssetSha256);
    assert.equal(owned(copy).sourceShapeId,imageId,'Pasted and duplicated images reference the original shape, never a temporary clipboard ID');
    assert.ok(Number.isSafeInteger(owned(copy).imageNumber)&&owned(copy).imageNumber>owned(imageBefore).imageNumber,'Each copy receives a fresh project image number');
  }
  assert.equal(new Set(shapes().filter(value=>value.type==='c-image').map(value=>owned(value).imageNumber)).size,3,'Image numbers remain unique after repeated paste and duplicate');
  await button('撤销').click();await save();assert.equal(shapes().filter(value=>value.type==='c-image').length,2);
  await button('重做').click();await save();assert.equal(shapes().filter(value=>value.type==='c-image').length,3);
  check('owned-tools-keyboard-copy-paste-duplicate-keeps-material-identity');

  await select(imageId);await button('裁切图片').click();
  await field('裁切宽度',50);await field('裁切高度',80);await field('裁切左边距',25);await field('裁切上边距',10);
  await button('取消裁切').last().click();await save();assert.equal(record(imageId).props.cropRegion,undefined);
  await button('裁切图片').click();await field('裁切宽度',50);await field('裁切高度',80);await field('裁切左边距',25);await field('裁切上边距',10);
  await button('应用裁切').click();await save();assert.deepEqual(record(imageId).props.cropRegion,{x:.25,y:.1,w:.5,h:.8});
  await action('水平翻转图片');await action('垂直翻转图片');await save();
  assert.equal(record(imageId).props.flipX,true);assert.equal(record(imageId).props.flipY,true);
  check('owned-tools-image-crop-cancel-apply-and-both-flips-persist');

  const transformedImage=structuredClone(record(imageId));await action('替换图片');
  await page.getByTestId('owned-replace-image-input').setInputFiles({name:'replacement-fixture.png',mimeType:'image/png',buffer:png});
  await page.getByText('图片已替换，可撤销',{exact:true}).waitFor();await save();
  assert.equal(shapes().filter(value=>value.type==='c-image').length,3);const replaced=record(imageId);
  assert.deepEqual([replaced.x,replaced.y,replaced.props.w,replaced.props.h],[transformedImage.x,transformedImage.y,transformedImage.props.w,transformedImage.props.h]);
  assert.equal(replaced.props.cropRegion,undefined);assert.equal(replaced.props.flipX,false);assert.equal(replaced.props.flipY,false);
  assert.equal(replaced.meta.novartAssetSha256,imageBefore.meta.novartAssetSha256);
  await button('撤销').click();await save();assert.deepEqual(record(imageId).props.cropRegion,transformedImage.props.cropRegion);
  assert.equal(record(imageId).props.flipX,true);await button('重做').click();await save();assert.equal(record(imageId).props.cropRegion,undefined);
  // Keep original-image transforms present for later reload/export assertions.
  await button('撤销').click();await save();check('owned-tools-replace-keeps-object-geometry-and-undo-redo-restores-crop');

  await select(imageCopies[1].id);await node(imageCopies[1].id).click({button:'right',position:{x:12,y:12}});
  await page.getByRole('menuitem',{name:'复制元素',exact:true}).click();await action('粘贴元素');await save();assert.equal(shapes().filter(value=>value.type==='c-image').length,4);
  await action('创建副本');await save();assert.equal(shapes().filter(value=>value.type==='c-image').length,5);
  await button('撤销').click();await button('撤销').click();await save();assert.equal(shapes().filter(value=>value.type==='c-image').length,3);
  check('owned-tools-context-menu-copy-paste-and-duplicate-use-actual-history');

  await clear();await button('文字').click();const canvasBox=await box(surface);
  await page.mouse.click(canvasBox.x+380,canvasBox.y+330);
  const editor=page.getByRole('textbox',{name:'编辑画布文字',exact:true});await editor.waitFor();
  await editor.fill('工具属性测试<&"\n第二行');await editor.press('ControlOrMeta+Enter');await save();
  const textId=shapes().find(value=>value.props.novartKind==='text').id;
  await field('文字字号',30);await button('文字加粗').click();await button('文字斜体').click();
  await button('文字排版').click();await page.getByRole('combobox',{name:'文字字体',exact:true}).selectOption('serif');
  await field('文字行距',1.6);await button('文字居中对齐').click();await button('文字排版').click();await save();
  assert.equal(record(textId).props.fontSize,30);assert.equal(record(textId).props.fontWeight,'bold');assert.equal(record(textId).props.fontStyle,'italic');
  assert.equal(record(textId).props.fontFamily,'serif');assert.equal(record(textId).props.textAlign,'center');assert.equal(record(textId).props.lineHeight,1.6);
  const textPaint=await node(textId).locator('svg text').evaluate(element=>({family:element.getAttribute('font-family'),weight:element.getAttribute('font-weight'),style:element.getAttribute('font-style'),anchor:element.getAttribute('text-anchor'),lines:[...element.querySelectorAll('tspan')].map(line=>({x:line.getAttribute('x'),y:line.getAttribute('y')}))}));
  assert.deepEqual(textPaint,{family:'Georgia, Times New Roman, serif',weight:'bold',style:'italic',anchor:'middle',lines:[{x:'120',y:'30'},{x:'120',y:'78'}]});
  check('owned-tools-text-font-weight-style-alignment-lineheight-render-and-save');

  await key('ControlOrMeta+d');await save();const secondTextId=shapes().filter(value=>value.props.novartKind==='text'&&value.id!==textId)[0].id;
  await select(textId);await select(secondTextId,true);await action('元素左对齐');await save();
  assert.equal(record(textId).x,record(secondTextId).x);await action('组合选中元素');await save();
  const groupId=owned(record(textId)).groupId;assert.ok(groupId);assert.equal(owned(record(secondTextId)).groupId,groupId);
  const groupedBefore=[structuredClone(record(textId)),structuredClone(record(secondTextId))];await key('Shift+ArrowRight');await save();
  assert.equal(record(textId).x,groupedBefore[0].x+10);assert.equal(record(secondTextId).x,groupedBefore[1].x+10);
  await action('取消组合');await save();assert.equal(owned(record(textId)).groupId,undefined);assert.equal(owned(record(secondTextId)).groupId,undefined);
  await select(secondTextId);await key('ControlOrMeta+d');await save();const thirdTextId=shapes().filter(value=>value.props.novartKind==='text'&&![textId,secondTextId].includes(value.id))[0].id;
  await select(thirdTextId);await key('Shift+ArrowRight');await key('Shift+ArrowRight');await key('Shift+ArrowRight');await save();
  await select(textId);await select(secondTextId,true);await select(thirdTextId,true);await action('水平等距分布');await save();
  const textOrder=[textId,secondTextId,thirdTextId].map(record).sort((a,b)=>a.x-b.x);
  assert.ok(Math.abs((textOrder[1].x-textOrder[0].x)-(textOrder[2].x-textOrder[1].x))<.01);
  check('owned-tools-multi-select-alignment-group-move-ungroup-and-distribution');

  await select(imageCopies[0].id);await openLayers();await row(imageCopies[0].id).getByRole('button',{name:'隐藏图层',exact:true}).click();await save();
  assert.equal(owned(record(imageCopies[0].id)).hidden,true);assert.equal(await node(imageCopies[0].id).count(),0);
  await row(imageCopies[0].id).getByRole('button',{name:'显示图层',exact:true}).click();await save();assert.equal(await node(imageCopies[0].id).count(),1);
  await closeLayers();await select(imageCopies[1].id);await openLayers();await row(imageCopies[1].id).getByRole('button',{name:'锁定图层',exact:true}).click();await save();
  const locked=structuredClone(record(imageCopies[1].id));await closeLayers();await key('ArrowRight');await key('Delete');await save();
  assert.deepEqual(record(imageCopies[1].id),locked);
  await openLayers();await row(imageCopies[1].id).getByRole('button',{name:'解锁图层',exact:true}).click();await closeLayers();await save();
  await select(imageCopies[0].id);await openLayers();await row(imageCopies[0].id).dragTo(row(textId));await save();
  const persistedOrder=shapes().sort((a,b)=>a.index.localeCompare(b.index)).map(value=>value.id);
  assert.equal(persistedOrder.indexOf(imageCopies[0].id),persistedOrder.indexOf(textId)+1);
  await closeLayers();check('owned-tools-layer-hide-show-lock-inertness-unlock-and-drag-order');

  const lineId=await draw('图形',450,440,140,-55,'line');const arrowId=await draw('图形',630,440,120,50,'arrow');
  assert.equal(record(lineId).props.novartShape,'line');assert.equal(record(arrowId).props.novartShape,'arrow');
  assert.equal(record(lineId).props.novartPoints.length,2);assert.equal(record(arrowId).props.novartPoints.length,2);
  assert.ok(record(lineId).props.novartPoints[0].y>record(lineId).props.novartPoints[1].y,'Drawing an upward line preserves local endpoint direction');
  const linePaint=await node(lineId).locator('line').getAttribute('x1');assert.equal(Number(linePaint),record(lineId).props.novartPoints[0].x);
  assert.ok(await node(arrowId).locator('line').getAttribute('marker-end'));check('owned-tools-line-arrow-drag-endpoints-and-rendered-marker');

  const strokeId=await draw('画笔',420,530,180,25);await button('橡皮擦').click();
  const strokeBox=await box(node(strokeId));await page.mouse.move(strokeBox.x+strokeBox.width/2,strokeBox.y+strokeBox.height/2);await page.mouse.down();await page.mouse.move(strokeBox.x+strokeBox.width/2+5,strokeBox.y+strokeBox.height/2,{steps:3});await page.mouse.up();await save();
  assert.equal(records()[strokeId],undefined);assert.ok(records()[lineId]);assert.ok(records()[arrowId]);assert.ok(records()[imageId]);
  await button('撤销').click();await save();assert.ok(records()[strokeId]);await button('重做').click();await save();assert.equal(records()[strokeId],undefined);
  check('owned-tools-eraser-only-removes-stroke-and-supports-undo-redo');

  const frameId=await draw('画框',290,250,510,245), frameBefore=structuredClone(record(frameId));
  assert.equal(owned(record(textId)).frameId,frameId);assert.equal(owned(record(lineId)).frameId,frameId);
  await select(frameId);const frameMemberBefore=structuredClone(record(textId));await key('Shift+ArrowDown');await save();
  assert.equal(record(frameId).y,frameBefore.y+10);assert.equal(record(textId).y,frameMemberBefore.y+10);assert.equal(owned(record(textId)).frameId,frameId);
  await openLayers();await row(frameId).getByRole('button',{name:'隐藏图层',exact:true}).click();await save();
  assert.equal(await node(frameId).count(),0);assert.equal(await node(textId).count(),0);assert.equal(await node(lineId).count(),0);
  await row(frameId).getByRole('button',{name:'显示图层',exact:true}).click();await save();assert.equal(await node(textId).count(),1);await closeLayers();
  // Preserve one hidden and one locked item through final export/reopen checks.
  await openLayers();await row(imageCopies[0].id).getByRole('button',{name:'隐藏图层',exact:true}).click();
  await row(imageCopies[1].id).getByRole('button',{name:'锁定图层',exact:true}).click();await closeLayers();await save();
  check('owned-tools-frame-membership-and-frame-move-preserve-world-coordinate-children');

  await select(imageId);const selectedSvg=await download('导出选中元素SVG'), selectedPng=await download('导出选中元素PNG');
  assert.match(selectedSvg.toString(),/data:image\/png;base64,/);assert.doesNotMatch(selectedSvg.toString(),/工具属性测试/);
  await compareRaster(selectedSvg,selectedPng);check('owned-tools-selected-png-svg-actual-downloads-have-identical-pixels');
  await select(frameId);const frameSvg=await download('导出当前画框SVG'), framePng=await download('导出当前画框PNG');
  assert.match(frameSvg.toString(),/owned-export-frame/);assert.match(frameSvg.toString(),/font-weight="bold" font-style="italic" text-anchor="middle"/);
  assert.deepEqual(await compareRaster(frameSvg,framePng,true),[Math.ceil(record(frameId).props.w),Math.ceil(record(frameId).props.h)]);
  check('owned-tools-frame-png-svg-actual-downloads-clip-and-have-identical-pixels');

  const savedRecords=structuredClone(records());await page.reload();await surface.waitFor();await save();
  assert.deepEqual(records(),savedRecords,'Reopening must retain all object attributes and memberships');
  assert.equal(owned(record(imageCopies[0].id)).hidden,true);assert.equal(await node(imageCopies[0].id).count(),0);
  assert.equal(owned(record(imageCopies[1].id)).locked,true);assert.equal(await node(imageCopies[1].id).getAttribute('data-locked'),'true');
  await select(imageId);assert.deepEqual(record(imageId).props.cropRegion,transformedImage.props.cropRegion);assert.equal(record(imageId).props.flipX,true);
  assert.deepEqual(await download('导出选中元素SVG'),selectedSvg,'Reloaded selected export must retain identical bytes');
  await select(frameId);assert.deepEqual(await download('导出当前画框SVG'),frameSvg,'Reloaded frame export must retain identical bytes');
  check('owned-tools-save-reopen-retains-attributes-memberships-and-export-bytes');
}

module.exports = {runOwnedToolChecks};
