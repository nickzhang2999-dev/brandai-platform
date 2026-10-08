"""Authenticated ordinary-browser gateway. Only isolated demo data is exposed.

The inner homepage-attachment runtime preserves the isolated editor and storage. Its Playwright routing
is replaced by a service worker and a finite local resource resolver; no remote
requests are forwarded. The share cookie is a capability for one review room.
"""
from __future__ import annotations
import argparse, gzip, hashlib, http.client, json, mimetypes, secrets, threading, time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from local_runtime import ROOT, DEMO_TOKEN
from local_store import StoreError
from home_start_runtime import HomeStartRuntime


class ShareRuntime:
    def __init__(self, data_dir, port=0, host='127.0.0.1'):
        data_dir = Path(data_dir).resolve()
        if not data_dir.is_relative_to((ROOT / 'sharing').resolve()):
            raise ValueError('Share data must be isolated under sharing/')
        self.data_dir = data_dir
        data_dir.mkdir(parents=True, exist_ok=True)
        self.inner = HomeStartRuntime(data_dir / 'demo-data').start()
        self.inner.server.socket.listen(128)
        token_path = data_dir / 'access-key.txt'
        if not token_path.exists(): token_path.write_text(secrets.token_urlsafe(32), encoding='ascii')
        self.key = token_path.read_text(encoding='ascii').strip()
        self.resource_events = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass  # Do not log access capabilities.

            def end_headers(self):
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.send_header('X-Robots-Tag', 'noindex, nofollow, noarchive')
                self.send_header('X-Frame-Options', 'SAMEORIGIN')
                self.send_header('Content-Security-Policy', "default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' https: 'unsafe-inline'; connect-src 'self' https: data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
                self.send_header('Cache-Control', 'no-store')
                super().end_headers()

            def send(self, body, status=200, mime='application/json', extra=None):
                if isinstance(body, str): body = body.encode('utf-8')
                elif not isinstance(body, bytes): body = json.dumps(body, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', mime)
                if len(body) > 2048 and ('text/' in mime or 'javascript' in mime or 'json' in mime or 'svg' in mime) and 'gzip' in self.headers.get('Accept-Encoding',''):
                    body = gzip.compress(body, compresslevel=5)
                    self.send_header('Content-Encoding','gzip')
                    self.send_header('Vary','Accept-Encoding')
                for k,v in (extra or {}).items(): self.send_header(k,v)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if self.command != 'HEAD':
                    try: self.wfile.write(body)
                    except (ConnectionError, OSError): pass

            def allowed(self):
                cookie = SimpleCookie()
                try: cookie.load(self.headers.get('Cookie',''))
                except Exception: return False
                value = cookie.get('novart_review')
                return bool(value and secrets.compare_digest(value.value, owner.key))

            def do_GET(self): self.handle_request()
            def do_HEAD(self): self.handle_request()
            def do_POST(self): self.handle_request()
            def do_PUT(self): self.handle_request()

            def handle_request(self):
                parsed = urlsplit(self.path)
                if parsed.scheme or parsed.netloc: return self.send({'error':'Unsupported target'},400)
                if parsed.path == '/healthz' and self.command in ('GET', 'HEAD'):
                    ready = owner.inner.thread.is_alive()
                    return self.send({'status': 'ok' if ready else 'unavailable',
                        'service': 'novart-workbench-preview'}, 200 if ready else 503)
                if self.command == 'GET' and parsed.path.startswith('/share/'):
                    if not secrets.compare_digest(parsed.path[len('/share/'):], owner.key):
                        return self.send({'error':'评审链接无效'},404)
                    secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
                    return self.send(b'',302,extra={'Location':'/share-start','Set-Cookie':'novart_review='+owner.key+'; Path=/; HttpOnly; SameSite=Strict'+secure})
                if not self.allowed(): return self.send({'error':'请使用完整的专属评审链接打开'},401)
                if self.command not in ('GET','HEAD'):
                    origin = self.headers.get('Origin')
                    if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                        return self.send({'error':'Cross-origin write rejected'},403)
                if parsed.path == '/share-start':
                    return self.send('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NovartLab · 体验评审</title><style>body{margin:0;background:#f7f5fb;color:#26232c;font:16px/1.8 system-ui;display:grid;place-content:center;min-height:100vh}main{max-width:480px;padding:40px}h1{font-size:26px}p{color:#787180}</style><main><h1>NovartLab</h1><p id="status">正在准备设计工作台…</p></main><script>
document.cookie='usertoken=local-demo-not-a-real-token; Path=/; SameSite=Strict';
document.cookie='__locale=zh; Path=/; SameSite=Strict';
(async()=>{try{if(!('serviceWorker' in navigator))throw Error('请使用最新版 Chrome 或 Edge 浏览器打开');await navigator.serviceWorker.register('/share-worker.js',{scope:'/'});await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true});setTimeout(()=>reject(Error('初始化超时，请刷新重试')),15000)});location.replace('/studio#/home')}catch(e){document.getElementById('status').textContent=e.message}})();</script></html>''',mime='text/html; charset=utf-8')
                if parsed.path == '/share-worker.js':
                    return self.send((ROOT/'harness/share-worker.js').read_bytes(),mime='application/javascript',extra={'Service-Worker-Allowed':'/'})
                if parsed.path == '/share-client.js':
                    return self.send((ROOT/'harness/share-client.js').read_bytes(),mime='application/javascript')
                try:
                    length = int(self.headers.get('Content-Length','0'))
                    if not 0 <= length <= 24*1024*1024: return self.send({'error':'文件过大'},413)
                    body = self.rfile.read(length) if length else None
                    if parsed.path == '/share-resource':
                        return self.resource(parse_qs(parsed.query).get('url',[''])[0],body)
                    if self.command == 'PUT': return self.send({'error':'Unknown upload route'},404)
                    # Finite source runtime endpoints only; its file readers confine paths.
                    connection = http.client.HTTPConnection('127.0.0.1',owner.inner.server.server_port,timeout=25)
                    try:
                        headers = {'token':DEMO_TOKEN}
                        if self.headers.get('Content-Type'): headers['Content-Type']=self.headers['Content-Type']
                        if parsed.path == '/studio/start/upload':
                            filenames = self.headers.get_all('X-File-Name', [])
                            if len(filenames) != 1:
                                return self.send({'error': 'Exactly one X-File-Name header is required'}, 400)
                            headers['X-File-Name'] = filenames[0]
                        connection.request(self.command, self.path, body, headers)
                        response = connection.getresponse(); payload=response.read();mime=response.getheader('Content-Type','application/octet-stream');status=response.status
                    finally: connection.close()
                    if status == 200 and 'text/html' in mime:
                        payload=payload.replace(b'<head>',b'<head><script src="/share-client.js"></script><script>if(!navigator.serviceWorker.controller)location.replace("/share-start");</script>',1)
                    if status == 200 and 'javascript' in mime:
                        payload=payload.replace(b"location.hostname !== '127.0.0.1'",b'!window.__NOVART_SHARED_DEMO__')
                    if status == 200 and ('javascript' in mime or 'text/html' in mime) and not parsed.path.startswith(('/originals/','/m12-native/')):
                        for old,new in [('已存到本机','已保存'),('草稿会在本机暂存','草稿会在演示环境暂存'),('本地编辑 · AI 与协作未接入','体验评审 · AI 与协作未接入')]:
                            payload=payload.replace(old.encode('utf-8'),new.encode('utf-8'))
                    return self.send(payload,status,mime)
                except (ValueError, StoreError): return self.send({'error':'Invalid local demo request'},400)
                except Exception as error:
                    owner.resource_events.append({'error':type(error).__name__,'path':parsed.path})
                    return self.send({'error':'演示服务暂不可用，请重试'},503)

            def resource(self, url, body):
                parsed=urlsplit(url);clean=parsed.scheme+'://'+parsed.netloc+parsed.path
                runtime=owner.inner; method=self.command
                owner.resource_events.append({'method':method,'url':clean})
                if len(owner.resource_events)>2000: del owner.resource_events[:1000]
                if parsed.scheme not in ('http','https') or parsed.username or parsed.password: return self.send({'error':'Invalid resource'},400)
                if parsed.hostname == 'models-online-persist-us.oss-accelerate.aliyuncs.com' and method=='PUT':
                    asset=runtime.upload(parsed.path,body or b'',self.headers.get('Content-Type','application/octet-stream'))
                    return self.send(b'',mime='text/plain',extra={'ETag':'"'+asset['sha256']+'"','x-oss-request-id':'demo-upload'})
                if method not in ('GET','HEAD'): return self.send({'error':'Service not connected'},503)
                digest=None
                if parsed.hostname=='local-assets.invalid': digest=parsed.path.lstrip('/')
                elif parsed.hostname=='assets-persist.lovart.ai' and parsed.path in runtime.aliases: digest=runtime.aliases[parsed.path]['sha256']
                if digest is not None:
                    file,mime=runtime.store.get_asset(digest)
                    return self.send(file.read_bytes(),mime=mime)
                if clean in runtime.external:
                    asset=runtime.external[clean];file=(ROOT/asset['path']).resolve()
                    if not file.is_relative_to((ROOT/'originals').resolve()): return self.send({},404)
                    raw=file.read_bytes()
                    if hashlib.sha256(raw).hexdigest()!=asset['sha256']: return self.send({},503)
                    return self.send(raw,mime=asset.get('contentType') or 'application/octet-stream')
                prefix='/lovart_canvas_online/'
                if parsed.hostname=='web-static3.lovart.ai' and parsed.path.startswith(prefix):
                    file=(ROOT/'originals'/parsed.path[len(prefix):]).resolve()
                    if file.is_relative_to((ROOT/'originals').resolve()) and file.is_file():
                        return self.send(file.read_bytes(),mime=mimetypes.guess_type(file)[0] or 'application/octet-stream')
                return self.send({'error':'此在线服务尚未接入演示版'},503)

        self.server=ThreadingHTTPServer((host,port),Handler)
        self.server.daemon_threads=True;self.server.socket.listen(128)
        self.origin='http://127.0.0.1:'+str(self.server.server_port)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)

    def start(self): self.thread.start(); return self
    def close(self): self.server.shutdown();self.server.server_close();self.thread.join(3);self.inner.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8769);parser.add_argument('--room',default='boss-review');parser.add_argument('--host',choices=['127.0.0.1','0.0.0.0'],default='127.0.0.1')
    args=parser.parse_args()
    if not args.room.replace('-','').isalnum(): raise ValueError('Invalid room')
    runtime=ShareRuntime(ROOT/'sharing'/args.room,args.port,args.host).start()
    (runtime.data_dir/'runtime.json').write_text(json.dumps({'port':runtime.server.server_port,'entryPath':'/share/'+runtime.key},indent=2),'utf-8')
    print('Review gateway ready on port '+str(runtime.server.server_port),flush=True)
    try:
        while True: time.sleep(1)
    except KeyboardInterrupt: pass
    finally: runtime.close()
