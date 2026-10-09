"""Compile the reviewed UI for the authenticated Next runtime, without shipping local data.

The original Python adapter is used only as a build-time asset compiler. Its
project store is disposable and never copied to the result. Nothing is fetched
from a third-party website. Existing native patch builders validate their inputs.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
from pathlib import Path
import re
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

REPO = Path(__file__).resolve().parents[1]
PREVIEW = REPO / 'previews' / 'novart-workbench'
OUT = REPO / '.novart-build' / 'studio'
sys.path.insert(0, str(PREVIEW / 'harness'))
from home_start_runtime import HomeStartRuntime  # noqa: E402
from rc3_runtime import RC3_PARAMETERS  # noqa: E402

ASSET = re.compile(r'''["'(](\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|css|png|svg|woff2?|ttf|jpg|webp))(?:["')?])''')

# These reviewed overlays also run in the local archive. Change their storage
# claims only in the product export; browser recovery-cache wording stays local.
# An exact occurrence count makes an upstream copy change fail the compiler.
PRODUCT_STORAGE_COPY = {
    '/studio.html': [
        ('项目和素材保存在本机，AI 与在线协作尚未接入', '项目与画布随品牌保存，进入项目即可编辑或提交图片生成', 1),
        ('>本地预览</span>', '>创作工作台</span>', 1),
        ('创建后进入画布，需求随项目保留。AI 生成暂未接入。', '创建项目后进入画布，上传素材或描述图片需求。', 1),
    ],
    '/home-start-studio.js': [
        ('偏好已保存在本机', '偏好已随账号与品牌保存', 1),
        ('品牌规范已保存在本机', '品牌草稿已随品牌保存', 1),
        ('收藏已保存在本机', '收藏已随账号与品牌保存', 1),
    ],
    '/m24-canvas.js': [
        ('草稿已在本机暂存', '草稿已随账号保存', 1),
        ('草稿会在本机暂存', '草稿会随账号保存', 2),
        ('本机还没有已暂存稿', '服务器还没有已暂存稿', 1),
    ],
    '/m20-comparison.js': [
        ('已存到本机 ', '已保存到服务器 ', 1),
    ],
    '/m20-canvas.js': [
        ('本地编辑 · AI 与协作未接入', '云端保存 · 图片生成状态见任务列表', 1),
        ('画布保存到这台电脑。', '画布随当前品牌保存到服务器。', 1),
        ('上次确认写入本机：', '上次确认写入服务器：', 1),
        ('暂时无法读取本机保存状态', '暂时无法读取服务器保存状态', 1),
        ('最近一次确认写入本机的时间', '最近一次确认写入服务器的时间', 1),
        ('画布还没有确认写入本机的内容', '画布还没有确认写入服务器的内容', 1),
        ('正在读取本机保存状态。', '正在读取服务器保存状态。', 1),
        ('可继续本地编辑，画布保存状态请看顶部。', '可继续编辑，画布保存状态请看顶部。', 2),
    ],
    '/m14-canvas.js': [
        ('AI 与协作未接入 · 支持本地编辑', '支持编辑、云端保存与图片生成 · 实时协作暂未接入', 1),
        ('线上服务提示不代表本地保存失败。', 'AI 服务提示不代表画布保存失败。', 1),
        ('确认本地预览服务仍在运行。', '请检查网络和工作台服务后重试。', 1),
        ('最近一次确认写入本机的时间', '最近一次确认写入服务器的时间', 1),
    ],
}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    temp_root = REPO / '.novart-build' / 'temporary'
    temp_root.mkdir(parents=True, exist_ok=True)
    records: dict[str, dict] = {}
    external: dict[str, str] = {}

    def product_patch(url_path: str, body: bytes, mime: str) -> bytes:
        if url_path.startswith('/novart-product-'):
            return body
        if not any(kind in mime for kind in ['html', 'javascript', 'css']):
            return body
        text = body.decode('utf-8')
        for before, after, count in PRODUCT_STORAGE_COPY.get(url_path, []):
            assert text.count(before) == count, f'Product storage copy changed: {url_path}: {before!r}'
            text = text.replace(before, after)
        # Overlay opt-in remains explicit; product identity is not a demo flag.
        text = text.replace("location.hostname !== '127.0.0.1'", "(!window.__NOVART_PRODUCT__ && location.hostname !== '127.0.0.1')")
        text = text.replace('https://web-static3.lovart.ai/lovart_canvas_online/', '/originals/')
        if url_path.endswith('/lovart-canvas.358a3a91.js'):
            before = 'return d.Q7?t:(0,a.jsxs)(u.we,'
            assert text.count(before) == 1, 'Fingerprint provider boundary changed'
            text = text.replace(before, 'return (window.__NOVART_PRODUCT__||d.Q7)?t:(0,a.jsxs)(u.we,')
        if url_path.endswith('/1773.fe2335a6.js'):
            # The product has explicit, persisted target/reference choices. The
            # vendor selection subscriber otherwise adds transient URL mentions
            # on selection/undo and makes the strict server draft unsaveable.
            original = PREVIEW / 'originals/static/js/1773.fe2335a6.js'
            assert hashlib.sha256(original.read_bytes()).hexdigest() == '2dc5773410b0759fa63a05fc97fbf6c9f6e11d9423af40090eb8aa354ba25750', 'Native selection source changed'
            before = 'let f=(0,r.memo)(function(){let e=(0,l.y5)("selection"),t=(0,d.X_T)()'
            assert text.count(before) == 1, 'Native selection mention boundary changed'
            text = text.replace(before, 'let f=(0,r.memo)(function(){if(window.__NOVART_PRODUCT__)return null;let e=(0,l.y5)("selection"),t=(0,d.X_T)()')
            before = 'createSocket(){if(this.socket)return;let e=(0,X.Ri)(G.v6);'
            assert text.count(before) == 1, 'Native agent socket boundary changed'
            text = text.replace(before, 'createSocket(){if(window.__NOVART_PRODUCT__)return;if(this.socket)return;let e=(0,X.Ri)(G.v6);')
            before = 'async uploadAndInsertImages(e,t){let a='
            assert text.count(before) == 1, 'Native resource upload boundary changed'
            text = text.replace(before, 'async uploadAndInsertImages(e,t){if(window.__NOVART_PRODUCT__)return window.NovartProductMaterials.uploadAndInsert(e,t);let a=')
            before = 'async function p(e,t,a){try{let{noBotDetector:r,onSubmitBefore:c,onSubmitAfter:d,...p}=a||{};'
            assert text.count(before) == 1, 'Native composer submit boundary changed'
            text = text.replace(before, 'async function p(e,t,a){if(window.__NOVART_PRODUCT__)return window.NovartProductGeneration.submit(e,t);try{let{noBotDetector:r,onSubmitBefore:c,onSubmitAfter:d,...p}=a||{};')
            before = 'async sendChatMessage(e,t,a){let{insufficientQuotaCheck:r=!0,'
            assert text.count(before) == 1, 'Native chat manager boundary changed'
            text = text.replace(before, 'async sendChatMessage(e,t,a){if(window.__NOVART_PRODUCT__)return window.NovartProductGeneration.submit(e,t);let{insufficientQuotaCheck:r=!0,')
            before = 'sendGeneratorMessage(e,t,a){let{onBeforeRequest:i,onAfterRequest:r,'
            assert text.count(before) == 1, 'Native generator boundary changed'
            text = text.replace(before, 'sendGeneratorMessage(e,t,a){if(window.__NOVART_PRODUCT__)return window.NovartProductGeneration.unsupported();let{onBeforeRequest:i,onAfterRequest:r,')
        if url_path == '/m6-workflow.js':
            before = "const payload=()=>({projectId,revision:state.revision,mode:state.mode,target:state.target,references:state.references});"
            assert text.count(before) == 1, 'Workflow read-only snapshot boundary changed'
            text = text.replace(before, before + "\n  window.NovartProductWorkflowSnapshot=()=>({loaded,busy,dirty,stale,...(state?JSON.parse(JSON.stringify(payload())):{})});")
            before = '仅保存素材设置，AI 尚未接入。'
            assert text.count(before) == 1, 'Workflow help copy changed'
            text = text.replace(before, '先保存用途与创作方式，再从输入框提交；改图结果另存，原图保留。')
        if url_path == '/home-start-studio.js':
            before = 'const payload = clone(savedState);'
            assert text.count(before) == 1
            text = text.replace(before, before + ' payload.group = group;')
            before = "api('/compare/api/create', {projectName: name, brief})"
            assert text.count(before) == 1
            text = text.replace(before, "api('/compare/api/create', {projectName: name, brief, requestId: crypto.randomUUID()})")
            text = text.replace("'&v=1&ui=novart&studio=1", "'&workspaceId=' + encodeURIComponent(window.__NOVART_PRODUCT__.workspaceId) + '&v=1&ui=novart&studio=1")
            text = text.replace("'/studio' + (panel ? '?panel='", "'/studio?workspaceId=' + encodeURIComponent(window.__NOVART_PRODUCT__.workspaceId) + (panel ? '&panel='")
            text = text.replace("nickname: 'Nine'", "nickname: ''")
        if '/originals/' not in url_path and '/m12-native/' not in url_path:
            text = text.replace('本机设置', '账号设置').replace('本机项目', '项目').replace('本地项目', '项目').replace('本机规范', '品牌草稿')
            text = text.replace('本地服务', '工作台服务').replace('请确认预览窗口仍在运行后重试', '请检查网络后重试')
            text = text.replace('仅保存在本机。', '偏好随当前账号与品牌保存。').replace('用于首页问候与本机显示', '用于当前品牌的工作台显示')
            text = text.replace('仅作本机视觉参考，暂不应用到画布或 AI 生成。', '品牌草稿按品牌保存；确认品牌规则后才能用于 AI 生成。')
        return text.encode('utf-8')

    def write(url_path: str, body: bytes, mime: str):
        body = product_patch(url_path, body, mime)
        relative = url_path.lstrip('/')
        target = (OUT / relative).resolve()
        if not target.is_relative_to(OUT.resolve()) or not body:
            raise RuntimeError('Invalid compiled asset: ' + url_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        records[url_path] = {'file':relative, 'mime':mime, 'bytes':len(body), 'sha256':hashlib.sha256(body).hexdigest()}

    with tempfile.TemporaryDirectory(prefix='studio-export-', dir=temp_root) as temporary:
        assert Path(temporary).resolve().is_relative_to(temp_root.resolve())
        runtime = HomeStartRuntime(temporary)
        runtime.start()
        try:
            # This ID is solely for the compiler's archive guard; HTML must not contain it.
            project = runtime.store.create_project({'projectName':'Build-time resource validation'})
            project_id = project['projectId']
            canvas_path = '/canvas?' + urlencode({'projectId':project_id, 'v':'1', **RC3_PARAMETERS})
            queue = [('/studio', '/studio.html'), (canvas_path, '/canvas.html')]
            visited = set()
            while queue:
                request_path, output_path = queue.pop(0)
                if output_path in visited:
                    continue
                visited.add(output_path)
                try:
                    with urlopen(runtime.origin + request_path, timeout=15) as response:
                        body = response.read()
                        mime = response.headers.get('Content-Type', 'application/octet-stream')
                except HTTPError as error:
                    raise RuntimeError(f'Asset compilation failed for {request_path}: {error.read(400).decode()}') from error
                if output_path.endswith('.html') and project_id.encode() in body:
                    raise RuntimeError('Build-time project leaked into HTML')
                write(output_path, body, mime)
                if any(kind in mime for kind in ['html', 'javascript', 'css']):
                    for match in ASSET.finditer(body.decode('utf-8')):
                        path = match.group(1)
                        if 'javascript' in mime and not re.match(r'^/(?:m\d+[-/]|rc\d+-|home-start-|project-library-|responsive-|comparison\.|local-mode\.|originals/)', path):
                            continue  # Unexecuted vendor examples are not asset dependencies.
                        if path not in visited and not path.startswith('/api/'):
                            queue.append((path, path))
            # Native lazy chunks and captured fonts are not all referenced in HTML.
            for source in (PREVIEW / 'originals').rglob('*'):
                if source.is_file() and source.relative_to(PREVIEW / 'originals').parts[0] in ('static', 'external'):
                    path = '/originals/' + source.relative_to(PREVIEW / 'originals').as_posix()
                    if path not in records:
                        write(path, source.read_bytes(), mimetypes.guess_type(source.name)[0] or 'application/octet-stream')
            for remote, asset in runtime.external.items():
                source = (PREVIEW / asset['path']).resolve()
                if not source.is_relative_to((PREVIEW / 'originals').resolve()):
                    raise RuntimeError('Captured external asset escaped originals')
                body = source.read_bytes()
                if hashlib.sha256(body).hexdigest() != asset['sha256']:
                    raise RuntimeError('Captured external asset hash mismatch')
                external[remote] = '/' + source.relative_to(PREVIEW).as_posix()
                native_prefix = 'https://web-static3.lovart.ai/lovart_canvas_online/'
                if remote.startswith(native_prefix):
                    alias = '/originals/' + remote.removeprefix(native_prefix)
                    if alias not in records:
                        write(alias, body, asset.get('contentType') or mimetypes.guess_type(source.name)[0] or 'application/octet-stream')
                    external[remote] = alias
        finally:
            runtime.close()

    for asset_path in list(records):
        if asset_path.startswith('/originals/static/'):
            external['https://web-static3.lovart.ai/lovart_canvas_online/' + asset_path.removeprefix('/originals/')] = asset_path
    mapping = json.dumps(external, ensure_ascii=False)
    bootstrap = (REPO / 'deploy/novart/studio/novart-product-bootstrap.js').read_text(encoding='utf-8')
    write('/novart-product-bootstrap.js', ('window.__NOVART_ASSET_MAP__=' + mapping + ';\n' + bootstrap).encode(), 'application/javascript; charset=utf-8')
    materials = (REPO / 'deploy/novart/studio/novart-product-materials.js').read_bytes()
    write('/novart-product-materials.js', materials, 'application/javascript; charset=utf-8')
    generation = (REPO / 'deploy/novart/studio/novart-product-generation.js').read_bytes()
    write('/novart-product-generation.js', generation, 'application/javascript; charset=utf-8')
    task_inbox = (REPO / 'deploy/novart/studio/novart-product-task-inbox.js').read_bytes()
    write('/novart-product-task-inbox.js', task_inbox, 'application/javascript; charset=utf-8')
    worker = '''const assets=MAP;
self.addEventListener('install', event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event=>{
 const url=new URL(event.request.url);
 if(url.origin===self.location.origin || !/^https?:$/.test(url.protocol))return;
 const local=assets[url.origin+url.pathname];
 event.respondWith(local && event.request.method==='GET'
   ? fetch(local,{credentials:'same-origin',cache:'no-store'})
   : Promise.resolve(new Response('External service is not connected',{status:503,headers:{'Access-Control-Allow-Origin':'*'}})));
});'''.replace('MAP', mapping, 1)
    write('/novart-product-worker.js', worker.encode(), 'application/javascript; charset=utf-8')
    manifest = {'format':'novart-studio-assets-v1', 'files':records, 'external':external}
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'files':len(records), 'capturedExternal':len(external), 'bytes':sum(v['bytes'] for v in records.values()), 'output':str(OUT)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
