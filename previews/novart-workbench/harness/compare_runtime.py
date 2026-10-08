"""Optional Novart comparison shell; native runtime and canvas stay unchanged.

The comparison's brief / notes / revision live only in compare-context sidecars.
Native project query, autosave, upload, unknown-service failures and captured
resources continue to use LocalRuntime without changing its response contract.
"""
from __future__ import annotations

import json
import math
import time
from urllib.parse import parse_qs, urlsplit

from local_runtime import LocalRuntime, ROOT
from local_store import StoreError

MAX_BODY_BYTES = 64 * 1024
MAX_REVISION = 10**16


def _integer(value, minimum=0, maximum=MAX_REVISION):
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= maximum


def _text(value, limit):
    if not isinstance(value, str) or len(value) > limit:
        return False
    try:
        value.encode('utf-8')
    except UnicodeError:
        return False
    return '\x00' not in value


def _strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def _reject_constant(value):
    raise ValueError('Non-finite JSON number')


def _finite_float(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('Non-finite JSON number')
    return result


def _error_reply(error):
    code = error.code
    if code == 'CONTEXT_CONFLICT':
        return {'error': '这份创作要求已在其他页面更新，请重新读取后再保存。'}, 409
    if code == 'NOT_FOUND':
        return {'error': '找不到这个本地项目，请返回项目列表重新选择。'}, 404
    if code == 'STORE_IO':
        return {'error': '本地写入失败，请检查磁盘空间或文件权限；原有内容仍保留。'}, 507
    if code == 'STORE_BUSY':
        return {'error': '本地存储正在处理其他操作，请稍后再试。'}, 503
    if code == 'CORRUPT_DATA':
        return {'error': '本地数据无法读取，请保留文件并检查备份。'}, 400
    return {'error': '请求格式或项目标识不正确，请检查输入后重试。'}, 400


class CompareRuntime(LocalRuntime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        self.context_dir = self.store.data_dir / 'compare-context'
        try:
            self.store._check_directory(self.context_dir)
            self.context_dir.mkdir(exist_ok=True)
        except (StoreError, OSError):
            self.server.server_close()
            raise
        runtime = self
        base_handler = self.server.RequestHandlerClass

        class CompareHandler(base_handler):
            def compare_error(self, error):
                result, status = _error_reply(error)
                self.reply(result, status)

            def project_id(self):
                values = parse_qs(urlsplit(self.path).query, keep_blank_values=True).get('projectId', [])
                if len(values) != 1:
                    raise StoreError('INVALID_PROJECT_ID', 'Exactly one project ID is required')
                return values[0]

            def serve_ui(self, name, mime):
                try:
                    self.reply((ROOT / 'harness' / name).read_bytes(), mime=mime)
                except OSError:
                    self.reply({'error': '比较版页面资源暂不可读。'}, 404)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                path = parsed.path
                if path in ('/compare', '/compare/'):
                    return self.serve_ui('comparison.html', 'text/html; charset=utf-8')
                if path in ('/compare.css', '/comparison.css'):
                    return self.serve_ui('comparison.css', 'text/css; charset=utf-8')
                if path in ('/compare.js', '/comparison.js'):
                    return self.serve_ui('comparison.js', 'application/javascript; charset=utf-8')
                if path in ('/canvas', '/canvas/') and parse_qs(parsed.query).get('ui') == ['novart']:
                    try:
                        body = (ROOT / 'harness/index.html').read_text(encoding='utf-8')
                        body = body.replace('</head>', '<link rel="stylesheet" href="/comparison.css">'
                            '<script defer src="/comparison.js"></script></head>')
                        self.reply(body.encode('utf-8'), mime='text/html; charset=utf-8')
                    except OSError:
                        self.reply({'error': '原画布入口暂不可读。'}, 404)
                    return
                if path not in ('/compare/api/projects', '/compare/api/context', '/compare/api/status'):
                    return super().do_GET()
                try:
                    if path == '/compare/api/projects':
                        summaries = runtime.store.list_projects(1, 100)['projects']
                        result = {'projects': [{**project, 'hasCanvas': bool(
                            runtime.store.get_project(project['projectId'])['canvas'])}
                            for project in summaries]}
                    elif path == '/compare/api/context':
                        result = runtime.get_context(self.project_id())
                    else:
                        project = runtime.store.get_project(self.project_id())
                        result = {'projectId': project['projectId'], 'projectName': project['projectName'],
                            'version': project['version'],
                            'savedAt': project['updatedAt'] if project['canvas'] else None,
                            'saveError': runtime.save_errors.get(project['projectId'])}
                    self.reply(result)
                except StoreError as error:
                    self.compare_error(error)
                except OSError:
                    self.compare_error(StoreError('STORE_IO', 'Local read failed'))

            def read_comparison_payload(self):
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not lengths[0].isdigit():
                    raise ValueError('Invalid request framing')
                length = int(lengths[0])
                if not 0 < length <= MAX_BODY_BYTES:
                    raise ValueError('Invalid request length')
                if self.headers.get_content_type() != 'application/json':
                    raise ValueError('Expected JSON request')
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Incomplete request')
                payload = json.loads(raw.decode('utf-8'), object_pairs_hook=_strict_pairs,
                    parse_constant=_reject_constant, parse_float=_finite_float)
                if not isinstance(payload, dict):
                    raise ValueError('Expected JSON object')
                return payload

            def do_POST(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_POST()
                path = urlsplit(self.path).path
                if path not in ('/compare/api/create', '/compare/api/context'):
                    return super().do_POST()
                try:
                    payload = self.read_comparison_payload()
                except (ValueError, UnicodeError, RecursionError):
                    self.close_connection = True
                    self.reply({'error': '请求须为有效 JSON 对象，内容不超过 64 KiB。'}, 400)
                    return
                try:
                    if path == '/compare/api/create':
                        if set(payload) != {'projectName', 'brief'} or not _text(payload['brief'], 6000):
                            raise StoreError('INVALID_INPUT', 'Invalid project creation payload')
                        project = runtime.store.create_project({'projectName': payload['projectName'],
                            'projectType': 3, 'canvas': ''})
                        try:
                            runtime.save_context({'projectId': project['projectId'], 'brief': payload['brief'],
                                'notes': '', 'revision': 0})
                        except (StoreError, OSError):
                            self.reply({'error': '项目已创建，但创作要求尚未保存。请打开该项目后重新保存要求。',
                                'projectId': project['projectId']}, 507)
                            return
                        result = {'projectId': project['projectId']}
                    else:
                        result = runtime.save_context(payload)
                    self.reply(result)
                except StoreError as error:
                    self.compare_error(error)
                except OSError:
                    self.compare_error(StoreError('STORE_IO', 'Local write failed'))

        self.server.RequestHandlerClass = CompareHandler

    @staticmethod
    def _empty_context(project_id):
        return {'projectId': project_id, 'brief': '', 'notes': '', 'updatedAt': None, 'revision': 0}

    def _read_context(self, project_id):
        path = self.store._path(self.context_dir, project_id + '.json')
        if not path.exists():
            return self._empty_context(project_id)
        value = self.store._read_json(path, MAX_BODY_BYTES)
        if (set(value) != {'projectId', 'brief', 'notes', 'updatedAt', 'revision'}
            or value['projectId'] != project_id or not _text(value['brief'], 6000)
            or not _text(value['notes'], 4000) or not _integer(value['revision'], 1)
            or not _integer(value['updatedAt'])):
            raise StoreError('CORRUPT_DATA', 'Invalid comparison context')
        return value

    def get_context(self, project_id):
        self.store.get_project(project_id)
        with self.store._locked():
            return self._read_context(project_id)

    def save_context(self, payload):
        if (not isinstance(payload, dict) or set(payload) != {'projectId', 'brief', 'notes', 'revision'}
            or not _text(payload['brief'], 6000) or not _text(payload['notes'], 4000)
            or not _integer(payload['revision'], 0, MAX_REVISION - 1)):
            raise StoreError('INVALID_INPUT', 'Invalid comparison context update')
        project_id = self.store.get_project(payload['projectId'])['projectId']
        # Reuse the store's cross-instance/process lock and atomic/fsync writer;
        # only the separate sidecar is written, never a native project record.
        with self.store._locked():
            current = self._read_context(project_id)
            if current['revision'] != payload['revision']:
                raise StoreError('CONTEXT_CONFLICT', 'Comparison context changed since read')
            value = {**payload, 'revision': current['revision'] + 1,
                'updatedAt': max(time.time_ns() // 1000000, (current['updatedAt'] or 0) + 1)}
            self.store._write_json(self.store._path(self.context_dir, project_id + '.json'), value)
            return value
