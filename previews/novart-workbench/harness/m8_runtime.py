"""Local studio shell and independent frontend preferences around M7.

The state endpoint stores frontend metadata on this computer only. It does not
update a service account, apply a brand to a document, or submit any AI task.
Native project, workflow, asset and network contracts remain inherited from M7.
"""
from __future__ import annotations

import copy
import re
from urllib.parse import parse_qs, urlsplit

from compare_runtime import MAX_BODY_BYTES, MAX_REVISION, _error_reply, _integer, _text
from local_store import StoreError
from m7_runtime import M7Runtime


STATE_FIELDS = {'revision', 'profile', 'brand', 'favorites'}
PROFILE_FIELDS = {'nickname', 'density', 'motion'}
BRAND_FIELDS = {'name', 'colors', 'font', 'notes'}
COLOR = re.compile(r'#[0-9a-fA-F]{6}\Z')


def _state_payload(value, *, stored=False):
    if not isinstance(value, dict) or set(value) != STATE_FIELDS:
        return False
    if not _integer(value['revision'], 1 if stored else 0,
                    MAX_REVISION if stored else MAX_REVISION - 1):
        return False
    profile, brand, favorites = value['profile'], value['brand'], value['favorites']
    if (not isinstance(profile, dict) or set(profile) != PROFILE_FIELDS
        or not _text(profile['nickname'], 40)
        or profile['density'] not in ('comfortable', 'compact')
        or profile['motion'] not in ('system', 'reduce')):
        return False
    if (not isinstance(brand, dict) or set(brand) != BRAND_FIELDS
        or not _text(brand['name'], 60) or not _text(brand['notes'], 2000)
        or brand['font'] not in ('system', 'sans', 'serif', 'mono')
        or not isinstance(brand['colors'], list) or len(brand['colors']) != 3
        or any(not isinstance(color, str) or COLOR.fullmatch(color) is None
               for color in brand['colors'])):
        return False
    return (isinstance(favorites, list) and len(favorites) <= 100
            and all(isinstance(project_id, str) for project_id in favorites)
            and len(set(favorites)) == len(favorites))


class M8Runtime(M7Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        self.studio_dir = self.store.data_dir / 'frontend-preview'
        try:
            # Reading untouched defaults does not materialize this directory.
            self.store._check_directory(self.studio_dir)
        except (StoreError, OSError):
            self.server.server_close()
            raise
        runtime = self
        base_handler = self.server.RequestHandlerClass

        class StudioHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                studio_canvas = (parsed.path in ('/canvas', '/canvas/')
                    and query.get('ui') == ['novart'] and query.get('studio') == ['1'])
                if (studio_canvas and status == 200 and mime.startswith('text/html')
                    and isinstance(data, bytes)):
                    additions = (b'<link rel="stylesheet" href="/m8-canvas.css">'
                        b'<script defer src="/m8-canvas.js"></script>')
                    data = data.replace(b'</head>', additions + b'</head>', 1)
                return super().reply(data, status, mime)

            def studio_error(self, error, *, writing=False):
                if error.code == 'STUDIO_CONFLICT':
                    result, status = {'error': '本机前端设置已在其他页面更新，请重新读取后再保存。'}, 409
                elif error.code == 'INVALID_ASSOCIATION':
                    result, status = {'error': '收藏项目不属于当前本机项目库，请刷新项目后重新选择。'}, 400
                elif error.code == 'STORE_IO':
                    result, status = {'error': '本机前端设置保存失败，请检查磁盘空间或文件权限；已保存内容仍保留。'
                        if writing else '本机前端设置暂时无法读取，请检查文件权限后重试。'}, 507
                else:
                    result, status = _error_reply(error)
                self.reply({'code': error.code, **result}, status)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m8-studio.html', 'text/html; charset=utf-8')
                if path in ('/m8-studio.css', '/m8-studio.js', '/m8-canvas.css', '/m8-canvas.js'):
                    return self.serve_ui(path[1:], 'text/css; charset=utf-8' if path.endswith('.css')
                        else 'application/javascript; charset=utf-8')
                if path != '/studio/state':
                    return super().do_GET()
                try:
                    self.reply(runtime.get_studio_state())
                except StoreError as error:
                    self.studio_error(error)
                except OSError:
                    self.studio_error(StoreError('STORE_IO', 'Local frontend read failed'))

            def do_POST(self):
                if self.path.startswith(('http://', 'https://')) or urlsplit(self.path).path != '/studio/state':
                    return super().do_POST()
                try:
                    payload = self.read_comparison_payload()
                except (ValueError, UnicodeError, RecursionError):
                    self.close_connection = True
                    return self.reply({'code': 'INVALID_INPUT',
                        'error': '请求须为有效 JSON 对象，内容不超过 64 KiB。'}, 400)
                try:
                    self.reply(runtime.save_studio_state(payload))
                except StoreError as error:
                    self.studio_error(error, writing=True)
                except OSError:
                    self.studio_error(StoreError('STORE_IO', 'Local frontend write failed'), writing=True)

        self.server.RequestHandlerClass = StudioHandler

    @staticmethod
    def _empty_studio_state():
        return {'revision': 0,
            'profile': {'nickname': 'Nine', 'density': 'comfortable', 'motion': 'system'},
            'brand': {'name': '', 'colors': ['#8B77B5', '#171717', '#F5F3FA'],
                'font': 'system', 'notes': ''}, 'favorites': []}

    def _favorites_exist(self, favorites, *, stored=False):
        for project_id in favorites:
            try:
                self.store._project_id(project_id)
                self.store._read_project(project_id)
            except StoreError as error:
                if error.code in ('INVALID_PROJECT_ID', 'NOT_FOUND'):
                    raise StoreError('CORRUPT_DATA' if stored else 'INVALID_ASSOCIATION',
                        'Frontend favorite is not an existing local project') from error
                raise

    def _read_studio_state(self):
        path = self.store._path(self.studio_dir, 'state.json')
        if not path.exists():
            return self._empty_studio_state()
        value = self.store._read_json(path, MAX_BODY_BYTES)
        if not _state_payload(value, stored=True):
            raise StoreError('CORRUPT_DATA', 'Invalid local frontend state')
        self._favorites_exist(value['favorites'], stored=True)
        return value

    def get_studio_state(self):
        with self.store._locked():
            return self._read_studio_state()

    def save_studio_state(self, payload):
        if not _state_payload(payload):
            raise StoreError('INVALID_INPUT', 'Invalid local frontend state payload')
        with self.store._locked():
            current = self._read_studio_state()
            if current['revision'] != payload['revision']:
                raise StoreError('STUDIO_CONFLICT', 'Frontend state changed since read')
            self._favorites_exist(payload['favorites'])
            value = {**copy.deepcopy(payload), 'revision': current['revision'] + 1}
            self.store._check_directory(self.studio_dir)
            self.studio_dir.mkdir(exist_ok=True)
            self.store._write_json(self.store._path(self.studio_dir, 'state.json'), value)
            return value
