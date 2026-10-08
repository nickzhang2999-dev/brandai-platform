"""Opt-in native input-form drafts with bounded JSON and atomic local CAS.

Uploads belong to the inherited global asset registry, not a fabricated project
owner. Canvas references additionally require the current project's c-image.
This captured input-form subset is not a claim of full service-schema support.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import time
from urllib.parse import parse_qs, urlsplit

from compare_runtime import _error_reply, _finite_float, _integer, _reject_constant, _strict_pairs, _text
from local_runtime import ROOT
from local_store import StoreError
from m21_runtime import LAYOUT_PARAMETERS, M21Runtime


MAX_DRAFT_BYTES = 256 * 1024
MAX_STORED_BYTES = MAX_DRAFT_BYTES + 4096
MAX_DRAFT_REVISION = 2**53 - 1
MAX_DEPTH = 40
MAX_NODES = 6000
LISTEN_BACKLOG = 128
FORM_FIELDS = {'text', 'lexicalJSONState', 'paramList', 'mentionPreviewList',
    'toolNameList', 'agentConfig', 'useWebSearch', 'threadIdType',
    'preferToolCategories', 'preferToolParams', 'presetSkill'}
REQUIRED_FORM_FIELDS = {'text', 'paramList', 'toolNameList', 'agentConfig'}
TRANSIENT_FIELDS = {'reconciliation', 'nextReconciliation', 'isFlushSync'}
RESOURCE_FIELDS = {'imageUrl', 'thumbnail', 'videoUrl', 'audioUrl', 'fileUrl',
    'url', 'src', 'originalUrl'}
LOCAL_ASSET = re.compile(r'https://local-assets\.invalid/([0-9a-f]{64})\Z')
ORIGINAL_SHA256 = {
    'originals/static/js/1773.fe2335a6.js': '2dc5773410b0759fa63a05fc97fbf6c9f6e11d9423af40090eb8aa354ba25750',
    'originals/static/js/1528.b3e6d520.js': '8bd70573e0beda72b79ec90c396f9d685e3c86023792d6b2de0466570b7ebe8f',
    'originals/static/js/runtime.dc1a2d6c.js': '6c9447ff69b7a9a413a95f5f2f0a966d563db159e4cf8006681535e093223e1e',
}
ASSET_MIMES = {
    '/m22-studio.css': 'text/css; charset=utf-8',
    '/m22-studio.js': 'application/javascript; charset=utf-8',
    '/m22-canvas.css': 'text/css; charset=utf-8',
    '/m22-canvas.js': 'application/javascript; charset=utf-8',
}
DRAFT_PARAMETERS = {**LAYOUT_PARAMETERS, 'draftUi': 'm22'}
CANVAS_DRAFT_TAGS = (b'<link rel="stylesheet" href="/m22-canvas.css">'
    b'<script defer src="/m22-canvas.js"></script>')


def _decode_object(raw):
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=_strict_pairs,
        parse_constant=_reject_constant, parse_float=_finite_float)
    if not isinstance(value, dict):
        raise ValueError('Expected JSON object')
    return value


def _bounded_json(value):
    stack, nodes = [(value, 0)], 0
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if nodes > MAX_NODES or depth > MAX_DEPTH:
            return False
        if isinstance(current, dict):
            if any(not _text(key, 200) for key in current):
                return False
            stack.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            stack.extend((item, depth + 1) for item in current)
        elif isinstance(current, str):
            if not _text(current, 20000):
                return False
        elif current is None or isinstance(current, bool):
            pass
        elif isinstance(current, int):
            if abs(current) > MAX_DRAFT_REVISION:
                return False
        elif isinstance(current, float):
            if not math.isfinite(current) or abs(current) > MAX_DRAFT_REVISION:
                return False
        else:
            return False
    return True


def _walk_dicts(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk_dicts(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_dicts(child)


def _form_valid(value):
    if (not isinstance(value, dict) or not REQUIRED_FORM_FIELDS <= set(value)
        or not set(value) <= FORM_FIELDS or not _bounded_json(value)
        or not _text(value['text'], 20000)
        or not isinstance(value['paramList'], list) or len(value['paramList']) > 20
        or any(not isinstance(item, dict) for item in value['paramList'])
        or not isinstance(value['toolNameList'], list) or len(value['toolNameList']) > 20
        or any(not _text(item, 200) for item in value['toolNameList'])
        or not isinstance(value['agentConfig'], dict)):
        return False
    if 'useWebSearch' in value and not isinstance(value['useWebSearch'], bool):
        return False
    if 'threadIdType' in value and not _integer(value['threadIdType'], 0, 100):
        return False
    preview = value.get('mentionPreviewList', [])
    if (not isinstance(preview, list) or any(not isinstance(item, (str, dict)) for item in preview)
        or sum(isinstance(item, dict) for item in preview) > 20):
        return False
    lexical = value.get('lexicalJSONState')
    if lexical is not None:
        if (not isinstance(lexical, dict) or set(lexical) != {'root'}
            or not isinstance(lexical['root'], dict)
            or lexical['root'].get('type') != 'root'
            or lexical['root'].get('version') != 1
            or not isinstance(lexical['root'].get('children'), list)):
            return False
        if any(TRANSIENT_FIELDS.intersection(item) for item in _walk_dicts(lexical)):
            return False
        if sum(item.get('type') == 'lovart-beautiful-mention' for item in _walk_dicts(lexical)) > 20:
            return False
    return True


def _payload_valid(value, *, stored=False):
    fields = {'projectId', 'revision', 'inputForm'} | ({'updatedAt'} if stored else set())
    return (isinstance(value, dict) and set(value) == fields
        and isinstance(value['projectId'], str)
        and _integer(value['revision'], 1 if stored else 0,
            MAX_DRAFT_REVISION if stored else MAX_DRAFT_REVISION - 1)
        and _form_valid(value['inputForm'])
        and (not stored or _integer(value['updatedAt'], 1, MAX_DRAFT_REVISION)))


class M22Runtime(M21Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        self.draft_dir = self.store.data_dir / 'conversation-drafts'
        try:
            # LocalRuntime has already bound/listened, but serve_forever has
            # not started. Expand only this instance's pending-connection queue
            # for concurrent native iframe assets and local draft requests.
            self.server.request_queue_size = LISTEN_BACKLOG
            self.server.socket.listen(LISTEN_BACKLOG)
            self.store._check_directory(self.draft_dir)
            for name, expected in ORIGINAL_SHA256.items():
                if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected:
                    raise StoreError('RESOURCE_MISMATCH', 'Original input-form resource changed')
        except (StoreError, OSError):
            self.server.server_close()
            raise
        runtime = self
        base_handler = self.server.RequestHandlerClass

        class DraftFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                opted_in = (parsed.path in ('/canvas', '/canvas/') and
                    all(query.get(key) == [value] for key, value in DRAFT_PARAMETERS.items()))
                if opted_in and status == 200 and mime.startswith('text/html') and isinstance(data, bytes):
                    if data.count(b'</body>') != 1 or b'/m22-canvas.css' in data or b'/m22-canvas.js' in data:
                        return super().reply({'error': 'M22 草稿入口校验失败，请检查本机资源。'}, 503)
                    data = data.replace(b'</body>', CANVAS_DRAFT_TAGS + b'</body>', 1)
                return super().reply(data, status, mime)

            def draft_error(self, error, *, writing=False):
                if error.code == 'DRAFT_CONFLICT':
                    result, status = {'error': '草稿已在其他页面更新，请先比较两份内容再选择保留。'}, 409
                elif error.code == 'INVALID_ASSOCIATION':
                    result, status = {'error': '草稿引用无法验证，请保留当前内容并检查本地素材或重新选择。'}, 400
                elif error.code == 'STORE_IO':
                    result, status = {'error': ('草稿写入失败，之前已存内容仍保留；请检查磁盘空间或权限后重试。'
                        if writing else '草稿暂时无法读取，请检查文件权限后重试。')}, 507
                else:
                    result, status = _error_reply(error)
                self.reply({'code': error.code, **result}, status)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m22-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_MIMES:
                    return self.serve_ui(path[1:], ASSET_MIMES[path])
                if path != '/studio/draft':
                    return super().do_GET()
                try:
                    self.reply(runtime.get_draft(self.project_id()))
                except StoreError as error:
                    self.draft_error(error)
                except OSError:
                    self.draft_error(StoreError('STORE_IO', 'Draft read failed'))

            def read_draft_payload(self):
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not lengths[0].isdigit():
                    raise ValueError('Invalid request framing')
                length = int(lengths[0])
                if not 0 < length <= MAX_DRAFT_BYTES or self.headers.get_content_type() != 'application/json':
                    raise ValueError('Invalid JSON request length or content type')
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Incomplete request')
                return _decode_object(raw)

            def do_POST(self):
                if self.path.startswith(('http://', 'https://')) or urlsplit(self.path).path != '/studio/draft':
                    return super().do_POST()
                try:
                    payload = self.read_draft_payload()
                except (ValueError, UnicodeError, RecursionError):
                    self.close_connection = True
                    return self.reply({'code': 'INVALID_INPUT',
                        'error': '草稿须为有效 JSON 对象，内容不超过 256 KiB。'}, 400)
                try:
                    self.reply(runtime.save_draft(payload))
                except StoreError as error:
                    self.draft_error(error, writing=True)
                except OSError:
                    self.draft_error(StoreError('STORE_IO', 'Draft write failed'), writing=True)

        self.server.RequestHandlerClass = DraftFrontendHandler

    def _read_draft(self, project_id):
        path = self.store._path(self.draft_dir, project_id + '.json')
        if not path.exists():
            return {'projectId': project_id, 'revision': 0, 'inputForm': None, 'updatedAt': None}
        try:
            with path.open('rb') as stream:
                raw = stream.read(MAX_STORED_BYTES + 1)
            if len(raw) > MAX_STORED_BYTES:
                raise ValueError('Stored draft exceeds size limit')
            value = _decode_object(raw)
            if not _payload_valid(value, stored=True) or value['projectId'] != project_id:
                raise ValueError('Invalid stored draft')
            return value
        except (ValueError, UnicodeError, RecursionError) as error:
            raise StoreError('CORRUPT_DATA', 'Stored draft failed validation') from error

    def _validate_draft_references(self, form, project):
        """Validate actual resource locations, preserving opaque native keys."""
        checked = set()
        for item in _walk_dicts(form):
            for key in RESOURCE_FIELDS.intersection(item):
                value = item[key]
                if value in (None, ''):
                    continue
                match = LOCAL_ASSET.fullmatch(value) if isinstance(value, str) else None
                if match is None:
                    raise StoreError('INVALID_ASSOCIATION', 'Unsupported resource URL')
                digest = match.group(1)
                if digest not in checked:
                    try:
                        self._asset_bytes(digest)
                    except StoreError as error:
                        if error.code == 'NOT_FOUND':
                            raise StoreError('INVALID_ASSOCIATION', 'Referenced asset is missing') from error
                        raise
                    checked.add(digest)
        images = self._images(project)
        references = list(form['paramList'])
        for item in _walk_dicts(form.get('lexicalJSONState')):
            if 'param' in item and isinstance(item['param'], dict):
                references.append(item['param'])
        references.extend(item for item in form.get('mentionPreviewList', []) if isinstance(item, dict))
        for param in references:
            data = param.get('data')
            if param.get('type') != 'image' or not isinstance(data, dict):
                raise StoreError('INVALID_ASSOCIATION', 'Only captured local image references are supported')
            match = LOCAL_ASSET.fullmatch(data.get('imageUrl', '')) if isinstance(data.get('imageUrl'), str) else None
            if match is None:
                raise StoreError('INVALID_ASSOCIATION', 'Image reference has no stable local URL')
            digest = match.group(1)
            # Upload identities may be blob:<old origin>/<uuid>; they are never
            # fetched. The inherited registry has no per-project upload owner.
            if any(item.get('markId') is not None for item in (param, data)):
                raise StoreError('INVALID_ASSOCIATION', 'Mark references are not supported by the captured draft subset')
            shape_ids = [item['shapeId'] for item in (param, data) if item.get('shapeId') is not None]
            for item in (param, data):
                for key in ('elementId',):
                    identity = item.get(key)
                    if identity is None:
                        continue
                    # Original module 58933 encodes a known canonical shapeId
                    # by replacing colons with hyphens. Verify this forward
                    # mapping; decoding arbitrary hyphens would be ambiguous.
                    if key == 'elementId' and isinstance(identity, str) and identity.startswith('shape-'):
                        canonical = data.get('shapeId')
                        if not isinstance(canonical, str) or identity != canonical.replace(':', '-'):
                            raise StoreError('INVALID_ASSOCIATION', 'Native image identity and shapeId disagree')
                        identity = canonical
                    shape_ids.append(identity)
            if shape_ids:
                if any(not isinstance(shape_id, str) or shape_id not in images
                    or images[shape_id]['assetSha256'] != digest for shape_id in shape_ids):
                    raise StoreError('INVALID_ASSOCIATION', 'Canvas image belongs to another project or changed')
            elif param.get('source') != 'upload':
                raise StoreError('INVALID_ASSOCIATION', 'Canvas image identity is missing')

    def get_draft(self, project_id):
        project_id = self.store._project_id(project_id)
        with self.store._locked():
            project = self.store._read_project(project_id)
            value = self._read_draft(project_id)
            if value['inputForm'] is not None:
                self._validate_draft_references(value['inputForm'], project)
            return value

    def save_draft(self, payload):
        if not _payload_valid(payload):
            raise StoreError('INVALID_INPUT', 'Invalid bounded input-form draft')
        project_id = self.store._project_id(payload['projectId'])
        if len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_DRAFT_BYTES:
            raise StoreError('INVALID_INPUT', 'Draft exceeds the size limit')
        with self.store._locked():
            project = self.store._read_project(project_id)
            current = self._read_draft(project_id)
            if current['revision'] != payload['revision']:
                raise StoreError('DRAFT_CONFLICT', 'Draft changed since read')
            self._validate_draft_references(payload['inputForm'], project)
            value = {**copy.deepcopy(payload), 'revision': current['revision'] + 1,
                'updatedAt': max(time.time_ns() // 1000000, (current['updatedAt'] or 0) + 1)}
            if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_STORED_BYTES:
                raise StoreError('INVALID_INPUT', 'Stored draft exceeds size limit')
            self.store._check_directory(self.draft_dir)
            self.draft_dir.mkdir(exist_ok=True)
            self.store._write_json(self.store._path(self.draft_dir, project_id + '.json'), value)
            return value
