"""Loopback adapters for the captured, unmodified original canvas build."""
from __future__ import annotations

import hashlib
import html
import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

from local_store import LocalStore, StoreError

ROOT = Path(__file__).resolve().parents[1]
DEMO_TOKEN = 'local-demo-not-a-real-token'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'


class LocalRuntime:
    def __init__(self, data_dir, port=0):
        self.store = LocalStore(data_dir)
        self.data_dir = Path(data_dir)
        self.events = []
        self.denials = []
        self.asset_requests = []
        self.save_errors = {}
        self.alias_path = self.data_dir / 'asset-aliases.json'
        self.alias_lock = threading.RLock()
        self.aliases = json.loads(self.alias_path.read_text(encoding='utf-8')) if self.alias_path.exists() else {}
        self.external = {}
        for name in ['observed-static-fetch.json', 'm2-static-fetch.json']:
            path = ROOT / 'evidence' / name
            if path.exists():
                for asset in json.loads(path.read_text(encoding='utf-8')):
                    if 'sha256' in asset:
                        self.external[asset['url']] = asset
        runtime = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                if not isinstance(data, bytes):
                    data = json.dumps(data, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(data)

            def do_CONNECT(self):
                runtime.denials.append({'target': self.path.split('?')[0], 'status': 503})
                self.reply({'code': 503, 'msg': '本地模式：远程连接不可用'}, 503)

            def do_GET(self):
                path = urlsplit(self.path).path
                if self.path.startswith(('http://', 'https://')):
                    self.reply({'code': 503, 'msg': '本地模式：不转发外部连接'}, 503)
                elif path in ['/canvas', '/canvas/']:
                    body = (ROOT / 'harness/index.html').read_text(encoding='utf-8').replace('</head>', '<script defer src="/local-mode.js"></script></head>')
                    self.reply(body.encode('utf-8'), mime='text/html; charset=utf-8')
                elif path == '/local-mode.js':
                    self.reply((ROOT / 'harness/local-mode.js').read_bytes(), mime='application/javascript; charset=utf-8')
                elif path in ['/', '/local-projects']:
                    self.reply(runtime.project_page().encode('utf-8'), mime='text/html; charset=utf-8')
                elif path == '/local/status':
                    project_id = parse_qs(urlsplit(self.path).query).get('projectId', [''])[0]
                    try:
                        project = runtime.store.get_project(project_id)
                        self.reply({'savedAt': project['updatedAt'] if project['canvas'] else None,
                            'error': runtime.save_errors.get(project_id)})
                    except StoreError:
                        self.reply({'error': '项目暂不可读'}, 404)
                elif path.startswith('/originals/'):
                    file = ROOT / path.lstrip('/')
                    if file.resolve().is_relative_to((ROOT / 'originals').resolve()) and file.is_file():
                        self.reply(file.read_bytes(), mime=mimetypes.guess_type(file)[0] or 'application/octet-stream')
                    else:
                        self.reply({'code': 404, 'msg': '缺少已捕获资源'}, 404)
                elif path == '/api/www/lovart/time/utc/timestamp':
                    self.reply({'code': 0, 'data': {'timestamp': str(int(time.time() * 1000))}})
                elif path == '/gateway/common-server-api/common-service/api/sts/v2/0':
                    runtime.events.append({'method': 'GET', 'path': path, 'status': 200, 'adapter': 'local-only upload credentials'})
                    self.reply({'code': 0, 'data': {'securityToken': 'local-only-no-cloud-access',
                        'accessKeyId': 'LOCAL_DEMO_NOT_VALID', 'accessKeySecret': 'local-only-invalid-for-cloud'}})
                else:
                    runtime.events.append({'method': 'GET', 'path': path, 'status': 503})
                    self.reply({'code': 503, 'msg': '本地模式：此服务未接入', 'data': None}, 503)

            def do_POST(self):
                path = urlsplit(self.path).path
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 <= length <= 24 * 1024 * 1024:
                        self.reply({'code': 413, 'msg': '请求内容过大'}, 413)
                        return
                    payload = json.loads(self.rfile.read(length) or b'{}')
                    if not isinstance(payload, dict):
                        raise ValueError('Expected JSON object')
                except (ValueError, json.JSONDecodeError):
                    self.reply({'code': 400, 'msg': '请求格式错误'}, 400)
                    return
                event = {'method': 'POST', 'path': path, 'request': payload}
                runtime.events.append(event)
                try:
                    result, status = runtime.api(path, payload, self.headers.get('token'))
                except StoreError as error:
                    name = error.code.upper()
                    status = 200 if name in ['VERSION_CONFLICT', 'CONFLICT'] else 507 if name == 'STORE_IO' else 400
                    code = 100400 if name in ['VERSION_CONFLICT', 'CONFLICT'] else status
                    result = {'code': code, 'msg': str(error), 'data': None}
                except OSError:
                    status = 507
                    result = {'code': 507, 'msg': '本地写入失败，请检查磁盘空间或文件权限', 'data': None}
                event['status'] = status
                event['response'] = result
                if path == '/api/canva/project/saveProject' and payload.get('projectId'):
                    runtime.save_errors[payload['projectId']] = None if result.get('code') == 0 else result.get('msg', '保存失败')
                self.reply(result, status)

        self.server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.server.daemon_threads = True
        self.origin = 'http://127.0.0.1:' + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def api(self, path, payload, token):
        if path == '/api/www/user/getUserInfo' and token == DEMO_TOKEN:
            return {'code': 0, 'msg': None, 'data': {
                'uuid': 'local-only-demo-user', 'nickname': '本地演示用户', 'avatar': '',
                'email': '', 'preference': {'lovart_version': '1.0'}}}, 200
        if path == '/api/canva/project/saveProject':
            if not payload.get('projectId'):
                project = self.store.create_project(payload)
            else:
                project = self.store.save_project(payload)
            return {'code': 0, 'msg': None, 'data': {
                'projectId': project['projectId'], 'version': project['version'], 'validProjectId': True}}, 200
        if path == '/api/canva/project/queryProject':
            project = self.store.get_project(payload.get('projectId', ''))
            return {'code': 0, 'msg': None, 'data': {**project, 'validProjectId': True}}, 200
        if path == '/api/canva/project/lovartProjectList':
            listing = self.store.list_projects(payload.get('page', 1), payload.get('pageSize', 20))
            return {'code': 0, 'msg': None, 'data': {'data': listing['projects'], 'page': listing['page'],
                'total': listing['total'], 'hasMore': listing['page'] * listing['pageSize'] < listing['total']}}, 200
        if path == '/api/canva/agent/queryAgentLastThread':
            return {'code': 0, 'msg': None, 'data': None}, 200
        if path == '/api/canva/agent/uploadLinkArtifacts':
            source = payload.get('artifact_content', '')
            parsed = urlsplit(source)
            if parsed.hostname != 'assets-persist.lovart.ai' or parsed.path not in self.aliases:
                return {'code': 400, 'msg': '上传图片尚未写入本地', 'data': None}, 400
            digest = self.aliases[parsed.path]['sha256']
            self.store.get_asset(digest)
            url = 'https://local-assets.invalid/' + digest
            return {'code': 0, 'msg': None, 'artifact': {'artifact_content': url}}, 200
        return {'code': 503, 'msg': '本地模式：此服务未接入', 'data': None}, 503

    def upload(self, path, data, mime):
        asset = self.store.put_asset(data, mime.split(';')[0], Path(path).name)
        with self.alias_lock:
            aliases = {**self.aliases, path: asset}
            temporary = self.data_dir / 'asset-aliases.pending'
            with temporary.open('w', encoding='utf-8') as stream:
                json.dump(aliases, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.alias_path)
            self.aliases = aliases
        self.asset_requests.append({'operation': 'upload', 'path': path, 'sha256': asset['sha256'], 'size': len(data)})
        return asset

    def start(self):
        self.thread.start()
        return self

    def project_page(self):
        projects = self.store.list_projects(1, 100)['projects']
        cards = ''.join('<a class="project" href="/canvas?projectId=' + html.escape(p['projectId'], quote=True) + '&amp;v=1"><strong>' + html.escape(p['projectName'] or '未命名项目') + '</strong><span>打开继续编辑 →</span></a>' for p in projects)
        if not cards:
            cards = '<div class="empty">从一个想法开始，创建你的第一个本地项目。</div>'
        return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本地项目</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f6f6f6;color:#202124;font:14px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif}main{max-width:960px;margin:90px auto;padding:0 32px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:44px}h1{font-size:30px;font-weight:600;margin:0 0 6px}p{margin:0;color:#85858a;font-size:13px}a{text-decoration:none;color:inherit}.new{background:#202124;color:white;border-radius:12px;padding:11px 18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:18px}.project{background:white;min-height:132px;border:1px solid #e9e9ec;border-radius:16px;padding:24px;display:flex;flex-direction:column;justify-content:space-between;transition:box-shadow .15s}.project:hover{box-shadow:0 5px 20px #00000008}.project strong{font-size:17px;font-weight:500}.project span{color:#929297;font-size:12px}.empty{padding:54px 0;color:#999;grid-column:1/-1}footer{margin-top:40px;font-size:12px;color:#9b9ba1}</style>
<main><header><div><h1>本地项目</h1><p>文字、图形和图片保存在这台电脑上。</p></div><a class="new" href="/canvas?newProject=1&amp;v=1">＋ 新建项目</a></header><div class="grid">''' + cards + '''</div><footer>本地编辑模式 · AI 生成、团队与实时协作暂未接入</footer></main></html>'''

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def configure_context(self, browser):
        context = browser.new_context(viewport={'width': 1440, 'height': 900},
            device_scale_factor=1, locale='zh-CN', color_scheme='light', service_workers='block')
        context.add_cookies([{'name': 'usertoken', 'value': DEMO_TOKEN, 'url': self.origin, 'sameSite': 'Lax'},
            {'name': '__locale', 'value': 'zh', 'url': self.origin, 'sameSite': 'Lax'}])
        network = {'blocked': [], 'missing_static': [], 'static_served': [], 'errors': [], 'console': []}

        def intercept(route):
            request = route.request
            url = urlsplit(request.url)
            clean = url.scheme + '://' + url.netloc + url.path
            if request.url.startswith(self.origin + '/'):
                route.continue_()
                return
            if url.hostname == 'models-online-persist-us.oss-accelerate.aliyuncs.com' and request.method in ['PUT', 'OPTIONS']:
                cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'PUT, GET, HEAD, OPTIONS', 'Access-Control-Expose-Headers': 'ETag,x-oss-request-id'}
                if request.method == 'OPTIONS':
                    route.fulfill(status=204, headers=cors)
                    return
                try:
                    asset = self.upload(url.path, request.post_data_buffer or b'', request.headers.get('content-type', 'application/octet-stream'))
                    route.fulfill(status=200, body='', headers={**cors, 'ETag': '"' + asset['sha256'] + '"', 'x-oss-request-id': 'local-only-upload'})
                except (StoreError, OSError) as error:
                    network['errors'].append('本地图片写入失败: ' + str(error))
                    route.fulfill(status=507, body='Local asset write failed', headers=cors)
                return
            digest = None
            if url.hostname == 'local-assets.invalid':
                digest = url.path.lstrip('/')
            elif url.hostname == 'assets-persist.lovart.ai' and url.path in self.aliases:
                digest = self.aliases[url.path]['sha256']
            if digest is not None:
                try:
                    file, mime = self.store.get_asset(digest)
                    self.asset_requests.append({'operation': 'read', 'sha256': digest, 'url': clean})
                    route.fulfill(path=str(file), content_type=mime, headers={'Access-Control-Allow-Origin': '*'})
                except StoreError:
                    route.fulfill(status=404, body='Local asset missing', headers={'Access-Control-Allow-Origin': '*'})
                return
            if clean in self.external:
                asset = self.external[clean]
                path = ROOT / asset['path']
                if hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
                    network['errors'].append('静态资源哈希不匹配: ' + asset['path'])
                    route.abort('blockedbyclient')
                    return
                network['static_served'].append(asset['path'])
                route.fulfill(path=str(path), content_type=asset.get('contentType') or 'application/octet-stream',
                    headers={'Access-Control-Allow-Origin': '*'})
                return
            prefix = '/lovart_canvas_online/'
            if url.hostname == 'web-static3.lovart.ai' and url.path.startswith(prefix):
                path = ROOT / 'originals' / url.path[len(prefix):]
                if path.is_file() and path.resolve().is_relative_to((ROOT / 'originals').resolve()):
                    network['static_served'].append(str(path.relative_to(ROOT)))
                    route.fulfill(path=str(path), content_type=mimetypes.guess_type(path)[0] or 'application/octet-stream',
                        headers={'Access-Control-Allow-Origin': '*'})
                    return
                network['missing_static'].append(clean)
            else:
                network['blocked'].append({'method': request.method, 'url': clean, 'resource': request.resource_type})
            route.abort('blockedbyclient')

        context.route('**/*', intercept)
        return context, network

    def launch(self, playwright, headless=True):
        return playwright.chromium.launch(executable_path=CHROME, headless=headless,
            proxy={'server': self.origin, 'bypass': '127.0.0.1,localhost'})


def decode_canvas(value):
    import base64
    import gzip
    return json.loads(gzip.decompress(base64.b64decode(value.removeprefix('SHAKKERDATA://'))))
