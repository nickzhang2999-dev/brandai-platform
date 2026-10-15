/* Actual production React canvas/tool interactions in a fresh loopback profile.
 * Synthetic raster pixels test editing, coordinates and file dimensions only.
 * No provider, authentication, business database or existing browser is used. */
'use strict';
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process'); const {createHash} = require('node:crypto');
const fs = require('node:fs'); const path = require('node:path'); const http = require('node:http');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname, '..'), temporaryRoot = path.join(repo, '.novart-build/temporary'); fs.mkdirSync(temporaryRoot, {recursive: true});
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'image-context-'));
const installed = fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).find(name => name.startsWith('esbuild@0.28.'));
const esbuild = require(path.join(repo, 'node_modules/.pnpm', installed, 'node_modules/esbuild'));
const sharp = require(path.join(repo, 'apps/web/node_modules/sharp'));
const canvasPath=path.join(repo,'apps/web/src/components/owned-canvas/OwnedCanvas.tsx'), baseline=process.env.NOVART_IMAGE_CONTEXT_BASELINE;
let canvasSource=fs.readFileSync(canvasPath);if(baseline){assert.match(baseline,/^[a-f0-9]{7,40}$/,'Baseline must be a commit hash');const result=spawnSync('git',['show',baseline+':apps/web/src/components/owned-canvas/OwnedCanvas.tsx'],{cwd:repo,encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});assert.equal(result.status,0,'Read the historical component without changing the workspace');canvasSource=Buffer.from(result.stdout);}
const report = {isolated: true, realBackend: false, realProvider: false, providerCalls: 0, checks: [], errors: [], externalRequests: [], baseline:baseline||null, sourceSha256: createHash('sha256').update(canvasSource).update(fs.readFileSync(path.join(repo,'apps/web/src/components/owned-canvas/owned-canvas.css'))).digest('hex')};
let server, browser, stage = 'prepare'; const check = label => report.checks.push(label);
(async () => {
  const png = await sharp({create: {width: 96, height: 64, channels: 4, background: {r: 20, g: 130, b: 210, alpha: 1}}}).png().toBuffer();
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(entry, `import React,{useState} from 'react'; import{createRoot}from'react-dom/client';
import{OwnedCanvas}from ${JSON.stringify(path.join(repo,'apps/web/src/components/owned-canvas/OwnedCanvas.tsx'))};
import{OwnedImageResize}from ${JSON.stringify(path.join(repo,'apps/web/src/components/owned-canvas/OwnedImageResize.tsx'))};
import{OwnedImageMask}from ${JSON.stringify(path.join(repo,'apps/web/src/components/owned-canvas/OwnedImageMask.tsx'))};
import{assignOwnedImageNames,emptyOwnedDocument,serializeOwnedDocument,parseOwnedDocument}from ${JSON.stringify(path.join(repo,'apps/web/src/lib/owned-canvas-model.ts'))};
const image=id=>({id:'shape:'+id,kind:'image',x:id==='a'?70:330,y:130,w:192,h:128,rotation:0,opacity:1,url:'/image.png',assetId:id,assetSha256:id.repeat(64)});
function App(){const[doc,setDoc]=useState(()=>assignOwnedImageNames({...emptyOwnedDocument(),camera:{x:0,y:0,zoom:1},items:[image('a'),image('b')]}));const[mode,setMode]=useState('canvas'),[locked,setLocked]=useState(false); window.snapshot=()=>serializeOwnedDocument(doc);window.reopen=()=>setDoc(parseOwnedDocument(window.snapshot()));window.lock=()=>setLocked(true);window.events=window.events||[];window.populateLayers=()=>setDoc(previous=>({...previous,items:[...previous.items,...Array.from({length:8},(_,index)=>({id:'shape:layer-'+index,kind:'shape',shape:'rect',x:750+index*4,y:40,w:12,h:12,rotation:0,opacity:1,fill:'#ded7ec'}))]}));
window.insertAsyncImage=()=>setDoc(previous=>assignOwnedImageNames({...previous,items:[...previous.items,{...image('c'),x:700}]}));
return <><div style={{position:'absolute',right:8,top:8,zIndex:90}}><button onClick={()=>setMode('resize')}>尺寸测试</button><button onClick={()=>setMode('mask')}>蒙版测试</button></div><div style={{position:'relative',width:'100vw',height:'100vh'}}><OwnedCanvas document={doc} clipboardScope="fixture" readOnly={locked} onChange={next=>setDoc(assignOwnedImageNames(next,Number(doc.source.novartOwnedCanvas?.imageSequence)||0))} onImageAction={(action,ids)=>window.events.push({action,ids})} onQuickEdit={async(id,instruction)=>window.events.push({action:'quick-edit',id,instruction})} onExport={async()=>{}} imageTools={{removeBackground:{available:true,reason:null},inpaint:{available:true,reason:null}}}/>{mode==='resize'&&<OwnedImageResize document={doc} item={doc.items[0]} readOnly={locked} onClose={()=>setMode('canvas')} onStore={async file=>{window.resized=Array.from(new Uint8Array(await file.arrayBuffer()));window.events.push({action:'resize',name:file.name})}}/>}{mode==='mask'&&<OwnedImageMask source={{assetId:'a',assetSha256:'a'.repeat(64),url:'/image.png',width:96,height:64}} name="图片1" readOnly={locked} onClose={()=>setMode('canvas')} onSubmit={async(mask,instruction)=>{window.mask={mask,instruction};window.events.push({action:'mask'})}}/>}</div></>};createRoot(document.getElementById('root')).render(<App/>);`);
  await esbuild.build({entryPoints:[entry],bundle:true,outfile:path.join(directory,'app.js'),jsx:'automatic',platform:'browser',loader:{'.css':'css'},alias:{'@':path.join(repo,'apps/web/src')},nodePaths:[path.join(repo,'apps/web/node_modules')],logLevel:'silent',plugins:baseline?[{name:'historical-canvas-read-only',setup(build){build.onLoad({filter:/OwnedCanvas\.tsx$/},args=>path.resolve(args.path)===path.resolve(canvasPath)?{contents:canvasSource.toString('utf8'),loader:'tsx',resolveDir:path.dirname(canvasPath)}:undefined);}}]:[]});
  const css = spawnSync(process.execPath, [path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'), '-i',path.join(repo,'packages/ui/src/styles.css'), '-o',path.join(directory,'tokens.css'), '-c',path.join(repo,'apps/web/tailwind.config.ts'), '--content',path.join(repo,'apps/web/src/components/owned-canvas/*.{ts,tsx}')], {cwd:repo,encoding:'utf8',timeout:60000});
  assert.equal(css.status,0,'Actual product CSS must compile: '+css.stderr);
  server = http.createServer((req,res) => {const url = new URL(req.url,'http://127.0.0.1'); if(url.pathname==='/image.png'){res.setHeader('Content-Type','image/png');return res.end(png);} if(url.pathname==='/app.js'||url.pathname==='/app.css'||url.pathname==='/tokens.css'){res.setHeader('Content-Type',url.pathname.endsWith('css')?'text/css':'application/javascript');return res.end(fs.readFileSync(path.join(directory,url.pathname.slice(1))));}res.setHeader('Content-Type','text/html');res.end('<html><head><meta charset="utf-8"><style>body{margin:0}button,input,textarea{font:inherit}</style><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',args:['--no-proxy-server','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1280,height:820}});page.on('pageerror',error=>report.errors.push(String(error.message)));page.on('request',request=>{if(!request.url().startsWith(origin)&&!request.url().startsWith('blob:')&&!request.url().startsWith('data:'))report.externalRequests.push(request.url());});
  await page.goto(origin);const object=id=>page.locator(`[data-owned-id="shape:${id}"]`);await object('a').click();
  stage='image-name';assert.deepEqual(await page.getByTestId('owned-image-name').allTextContents(),['图片1','图片2']);check('persistent-image-number-labels');
  // Keep the real layer panel open throughout: ordinary pointer clicks must
  // reach both navigation and selection tools, including a tall layer list.
  for(const width of[1280,390,326,320]){
    const height=width===320?320:820;
    stage='open-layers-reference-'+width;await page.setViewportSize({width,height});await page.reload();await object('a').waitFor();await page.evaluate(()=>populateLayers());
    await page.getByRole('button',{name:'图层',exact:true}).click();const layers=page.getByRole('complementary',{name:'画布图层',exact:true});await layers.waitFor();
    for(const [name,id] of[['图片1','shape:a'],['图片2','shape:b']]){
      await layers.getByRole('button',{name:'选择图层 '+name,exact:true}).click({timeout:3000});
      await page.getByRole('button',{name:'加入对话',exact:true}).click({timeout:3000});
      assert.equal(await layers.isVisible(),true,'Adding a reference must not close the layer panel');
      assert.deepEqual(await page.evaluate(()=>events.filter(event=>event.action==='add-reference').at(-1).ids),[id]);
    }
    assert.deepEqual(await page.evaluate(()=>events.filter(event=>event.action==='add-reference').map(event=>event.ids)),[['shape:a'],['shape:b']]);
    await layers.getByRole('button',{name:'选择图层 图片1',exact:true}).click({timeout:3000});await layers.getByRole('button',{name:'选择图层 图片2',exact:true}).click({modifiers:['Shift'],timeout:3000});
    await page.getByRole('button',{name:'加入对话',exact:true}).click({timeout:3000});assert.deepEqual(await page.evaluate(()=>events.filter(event=>event.action==='add-reference').at(-1).ids),['shape:a','shape:b']);
    await layers.getByRole('button',{name:'选择图层 图片1',exact:true}).click({timeout:3000});await page.getByRole('button',{name:'快捷编辑图片',exact:true}).click({timeout:3000});
    await page.getByRole('textbox',{name:'快捷编辑需求',exact:true}).fill('图层保持打开时修改背景');await page.getByRole('button',{name:'提交修改',exact:true}).click({timeout:3000});
    await page.waitForFunction(()=>events.some(event=>event.action==='quick-edit'));assert.deepEqual(await page.evaluate(()=>events.find(event=>event.action==='quick-edit')),{action:'quick-edit',id:'shape:a',instruction:'图层保持打开时修改背景'});
    await layers.getByRole('button',{name:'选择图层 图片2',exact:true}).click({timeout:3000});assert.equal(await layers.isVisible(),true);
    const toolbar=await page.getByTestId('owned-image-toolbar').boundingBox();const panel=await layers.boundingBox();assert.ok(toolbar.x>=0&&toolbar.x+toolbar.width<=width+.1);assert.ok(toolbar.y>=0&&toolbar.y+toolbar.height<=height+.1,'Selection toolbar must stay inside the available canvas height');
    assert.ok(toolbar.x+toolbar.width<=panel.x||toolbar.x>=panel.x+panel.width||toolbar.y+toolbar.height<=panel.y||toolbar.y>=panel.y+panel.height,'Selection toolbar must avoid the measured layer panel');
    check('open-tall-layers-normal-click-reference-order-quick-edit-'+width);
  }
  await page.setViewportSize({width:1280,height:820});await page.reload();await object('a').click();
  stage='quick-edit';await page.getByRole('button',{name:'快捷编辑图片',exact:true}).click();await page.getByRole('textbox',{name:'快捷编辑需求',exact:true}).fill('把背景换成蓝色');await page.getByRole('button',{name:'提交修改',exact:true}).click();await page.waitForFunction(()=>events.some(event=>event.action==='quick-edit'));assert.deepEqual(await page.evaluate(()=>events.find(event=>event.action==='quick-edit')),{action:'quick-edit',id:'shape:a',instruction:'把背景换成蓝色'});check('near-image-quick-edit-frozen-target-and-text');
  stage='selection-reference';await object('a').click();await object('b').click({modifiers:['Shift']});await page.getByRole('button',{name:'加入对话',exact:true}).click();const references=await page.evaluate(()=>events.find(event=>event.action==='add-reference'));assert.deepEqual(references.ids,['shape:a','shape:b']);await page.keyboard.press('Escape');await object('a').click();assert.deepEqual(await page.evaluate(()=>events.find(event=>event.action==='add-reference')),references);check('multi-selection-only-explicit-add-frozen-ordered-references');
  stage='transforms';await page.getByRole('button',{name:'快捷水平翻转',exact:true}).click();await page.getByRole('button',{name:'快捷旋转90度',exact:true}).click();await page.evaluate(()=>reopen());const shape=await page.evaluate(()=>snapshot().tldrawSnapshot.document.store['shape:a']);assert.equal(shape.props.flipX,true);assert.equal(shape.rotation,Math.PI/2);assert.equal(shape.meta.novartOwned.imageNumber,1);check('flip-rotate-and-v3-reopen');
  stage='responsive-toolbar';for(const width of[768,390]){await page.setViewportSize({width,height:820});await object('a').click();const toolbar=await page.getByTestId('owned-image-toolbar').boundingBox();assert.ok(toolbar.x>=0&&toolbar.x+toolbar.width<=width+.1);check('context-toolbar-in-viewport-'+width);}await page.setViewportSize({width:1280,height:820});
  stage='duplicate-undo-identity';await page.keyboard.press('Escape');await object('a').click();await page.keyboard.press('Control+d');await page.waitForFunction(()=>document.querySelectorAll('[data-owned-id]').length===3);const copied=await page.evaluate(()=>Object.values(snapshot().tldrawSnapshot.document.store).find(shape=>shape.meta?.novartOwned?.imageNumber===3).id);await page.keyboard.press('Control+z');await page.keyboard.press('Control+Shift+z');assert.equal(await page.evaluate(id=>snapshot().tldrawSnapshot.document.store[id].meta.novartOwned.imageNumber,copied),3);check('duplicate-undo-redo-keeps-one-persistent-name');
  stage='resize';await page.getByRole('button',{name:'尺寸测试',exact:true}).click();await page.getByRole('spinbutton',{name:'图片像素宽度',exact:true}).fill('320');await page.getByRole('spinbutton',{name:'图片像素高度',exact:true}).fill('240');await page.getByRole('button',{name:'保存并加入画布',exact:true}).click();await page.waitForFunction(()=>window.resized?.length);const resized=Buffer.from(await page.evaluate(()=>resized));const metadata=await sharp(resized).metadata();assert.equal(metadata.width,320);assert.equal(metadata.height,240);assert.ok(metadata.hasAlpha);check('deterministic-resize-actual-png-pixels-and-alpha');
  stage='resize-budget';await page.getByRole('button',{name:'尺寸测试',exact:true}).click();await page.getByRole('spinbutton',{name:'图片像素宽度',exact:true}).fill('8192');await page.getByRole('spinbutton',{name:'图片像素高度',exact:true}).fill('8192');await page.getByRole('button',{name:'保存并加入画布',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').textContent(),/1677/);await page.getByRole('button',{name:'关闭尺寸工具',exact:true}).click();check('resize-rejects-memory-budget-with-original-intact');
  stage='mask';await page.getByRole('button',{name:'蒙版测试',exact:true}).click();const mask=page.getByTestId('owned-inpaint-mask');await mask.waitFor();await page.waitForFunction(()=>document.querySelector('img[alt="待擦除原图"]')?.naturalWidth===96);const rectangle=await mask.boundingBox();await page.mouse.move(rectangle.x+rectangle.width*.2,rectangle.y+rectangle.height*.3);await page.mouse.down();await page.mouse.move(rectangle.x+rectangle.width*.6,rectangle.y+rectangle.height*.3,{steps:10});await page.mouse.up();await page.getByRole('button',{name:'擦除并补全',exact:true}).click();await page.waitForFunction(()=>window.mask);const data=await page.evaluate(()=>window.mask);const raster=await sharp(Buffer.from(data.mask.split(',')[1],'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(raster.info.width,96);assert.equal(raster.info.height,64);assert.equal(raster.data[0],0);const index=(Math.round(64*.3)*96+Math.round(96*.4))*raster.info.channels;assert.ok(raster.data[index]>240);assert.match(data.instruction,/补全/);check('mask-css-coordinate-normalized-original-pixels-white-edit-black-preserve');
  for(const gesture of ['move','draw','cancel-move']) {
    stage='async-insertion-history-'+gesture;await page.reload();await object('a').waitFor();
    const before=await page.evaluate(()=>snapshot().tldrawSnapshot.document.store['shape:a']);
    if(gesture==='draw')await page.getByRole('button',{name:'画笔',exact:true}).click();
    const start=gesture==='draw'?{x:120,y:470}:{x:130,y:180};
    await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+90,start.y+50,{steps:8});
    await page.evaluate(()=>insertAsyncImage());await object('c').waitFor();
    if(gesture==='cancel-move')await page.keyboard.press('Escape');
    await page.mouse.up();await page.getByTestId('owned-canvas').focus();
    const completed=await page.evaluate(()=>snapshot().tldrawSnapshot.document.store);
    if(gesture!=='cancel-move')await page.keyboard.press('Control+z');
    assert.equal(await object('c').count(),1,'Undo/cancel of the gesture preserves the completed insertion');
    await page.keyboard.press('Control+z');
    const undone=await page.evaluate(()=>snapshot().tldrawSnapshot.document.store);
    assert.equal(undone['shape:a'].x,before.x,'Undoing the asynchronous insertion must not revive an already undone drag');
    assert.equal(undone['shape:a'].y,before.y);assert.equal(undone['shape:c'],undefined);
    assert.equal(Object.values(undone).filter(item=>item.typeName==='shape').length,2,'Undoing insertion must not resurrect an unfinished stroke');
    await page.keyboard.press('Control+Shift+z');
    if(gesture!=='cancel-move')await page.keyboard.press('Control+Shift+z');
    await page.evaluate(()=>reopen());
    const reopened=await page.evaluate(()=>snapshot().tldrawSnapshot.document.store);
    const shapeEntries=records=>Object.values(records).filter(item=>item.typeName==='shape');
    assert.deepEqual(shapeEntries(reopened),shapeEntries(completed),'Redo and save/reopen restore each action exactly once');
    check(stage);
  }
  stage='async-insertion-during-erase';await page.reload();await object('a').waitFor();
  await page.getByRole('button',{name:'画笔',exact:true}).click();await page.mouse.move(120,470);await page.mouse.down();await page.mouse.move(210,520,{steps:8});await page.mouse.up();
  const stroke=await page.locator('[data-owned-id][data-kind="stroke"]').getAttribute('data-owned-id');assert.ok(stroke);
  await page.getByRole('button',{name:'橡皮擦',exact:true}).click();await page.mouse.move(160,490);await page.mouse.down();
  assert.equal(await page.locator('[data-owned-id][data-kind="stroke"]').count(),0);
  await page.evaluate(()=>insertAsyncImage());await object('c').waitFor();
  assert.equal(await page.locator('[data-owned-id][data-kind="stroke"]').count(),0,'An asynchronous insertion must not revive a stroke while the eraser pointer remains down');
  await page.mouse.up();await page.getByTestId('owned-canvas').focus();
  await page.keyboard.press('Control+z');assert.equal(await page.locator(`[data-owned-id="${stroke}"]`).count(),1);assert.equal(await object('c').count(),1);
  await page.keyboard.press('Control+z');assert.equal(await page.locator(`[data-owned-id="${stroke}"]`).count(),1);assert.equal(await object('c').count(),0);
  await page.keyboard.press('Control+Shift+z');await page.keyboard.press('Control+Shift+z');await page.evaluate(()=>reopen());
  assert.equal(await page.locator(`[data-owned-id="${stroke}"]`).count(),0);assert.equal(await object('c').count(),1);check(stage);
  stage='readonly';await page.evaluate(()=>lock());await object('b').click();assert.equal(await page.getByTestId('owned-image-toolbar').count(),0);check('readonly-hides-executable-image-tools');assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.passed=true;
})().catch(error=>{report.passed=false;report.fatal={stage,message:String(error.message).slice(0,900)};process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));const file=process.env.NOVART_IMAGE_CONTEXT_REPORT||path.join(repo,'.novart-build/image-context-browser-report.json');fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify(report));const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(temporaryRoot));fs.rmSync(resolved,{recursive:true,force:true});});
