"""Explicit resource use / edit targets beside the unmodified native document.

This sidecar records preparation only. It does not call generation, create
versions, mutate canvas records, or turn editor selection into an edit target.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import json
import re
import time
from urllib.parse import parse_qs, urlsplit

from compare_runtime import CompareRuntime, MAX_BODY_BYTES, MAX_REVISION, _integer, _text
from local_runtime import ROOT
from local_store import CANVAS_PREFIX, StoreError

DIGEST = re.compile(r'[a-f0-9]{64}\Z')
PURPOSES = (None, 'EXACT', 'ADAPTIVE', 'REFERENCE')
MAX_REFERENCES = 8
WRITE_FIELDS = {'projectId', 'revision', 'mode', 'target', 'references'}
STORED_FIELDS = WRITE_FIELDS | {'updatedAt'}


def _shape_id(value):
    return (isinstance(value, str) and value.startswith('shape:') and 6 < len(value) <= 200
            and all(32 < ord(character) < 127 for character in value))


def _digest(value):
    return isinstance(value, str) and DIGEST.fullmatch(value) is not None


def _resource(value, reference=False):
    fields = {'assetSha256', 'shapeId'} | ({'purpose', 'participates'} if reference else set())
    if not isinstance(value, dict) or set(value) != fields or not _digest(value['assetSha256']):
        return False
    if not _shape_id(value['shapeId']) and not (reference and value['shapeId'] is None):
        return False
    return not reference or (value['purpose'] in PURPOSES and isinstance(value['participates'], bool)
        and (not value['participates'] or value['purpose'] is not None))


def _payload(value, stored=False):
    if not isinstance(value, dict) or set(value) != (STORED_FIELDS if stored else WRITE_FIELDS):
        return False
    if (not _integer(value['revision'], 1 if stored else 0, MAX_REVISION if stored else MAX_REVISION - 1)
        or value['mode'] not in ('generate', 'modify')
        or not isinstance(value['references'], list) or len(value['references']) > MAX_REFERENCES
        or any(not _resource(reference, True) for reference in value['references'])):
        return False
    pairs = [(reference['shapeId'], reference['assetSha256']) for reference in value['references']]
    if len(set(pairs)) != len(pairs):
        return False
    if value['mode'] == 'generate' and value['target'] is not None:
        return False
    if value['mode'] == 'modify' and not _resource(value['target']):
        return False
    return not stored or _integer(value['updatedAt'])


def _url_digest(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if (parsed.scheme != 'https' or parsed.netloc != 'local-assets.invalid'
            or parsed.query or parsed.fragment or not _digest(parsed.path[1:])):
            return None
        return parsed.path[1:]
    except ValueError:
        return None


class M6Runtime(CompareRuntime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        self.workflow_dir = self.store.data_dir / 'workflow-context'
        try:
            self.store._check_directory(self.workflow_dir)
            self.workflow_dir.mkdir(exist_ok=True)
        except (StoreError, OSError):
            self.server.server_close()
            raise
        runtime = self
        base_handler = self.server.RequestHandlerClass

        class WorkflowHandler(base_handler):
            def workflow_error(self, error):
                if error.code == 'WORKFLOW_CONFLICT':
                    self.reply({'code': error.code,
                        'error': '这份素材设置已在其他页面更新，请重新读取后再保存。'}, 409)
                elif error.code == 'INVALID_ASSOCIATION':
                    self.reply({'code': error.code,
                        'error': '素材或改图目标已不属于当前画布，请刷新素材并明确重新选择。'}, 400)
                else:
                    self.compare_error(error)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                path = parsed.path
                if path in ('/m6-workflow.css', '/m6-workflow.js'):
                    return self.serve_ui(path[1:], 'text/css; charset=utf-8' if path.endswith('.css')
                        else 'application/javascript; charset=utf-8')
                if path in ('/compare', '/compare/') or (path in ('/canvas', '/canvas/')
                    and parse_qs(parsed.query).get('ui') == ['novart']):
                    try:
                        source = 'comparison.html' if path.startswith('/compare') else 'index.html'
                        body = (ROOT / 'harness' / source).read_text(encoding='utf-8')
                        if source == 'index.html':
                            body = body.replace('</head>', '<link rel="stylesheet" href="/comparison.css">'
                                '<script defer src="/comparison.js"></script></head>')
                        body = body.replace('</head>', '<link rel="stylesheet" href="/m6-workflow.css">'
                            '<script defer src="/m6-workflow.js"></script></head>')
                        return self.reply(body.encode('utf-8'), mime='text/html; charset=utf-8')
                    except OSError:
                        return self.reply({'error': '素材比较版入口暂不可读。'}, 404)
                if path not in ('/workflow', '/workflow/assets') and not path.startswith('/workflow/image/'):
                    return super().do_GET()
                try:
                    project_id = self.project_id()
                    if path == '/workflow':
                        self.reply(runtime.get_workflow(project_id))
                    elif path == '/workflow/assets':
                        self.reply(runtime.get_workflow_assets(project_id))
                    else:
                        digest = path.removeprefix('/workflow/image/')
                        data, mime = runtime.get_workflow_image(project_id, digest)
                        self.reply(data, mime=mime)
                except StoreError as error:
                    self.workflow_error(error)
                except OSError:
                    self.workflow_error(StoreError('STORE_IO', 'Local read failed'))

            def do_POST(self):
                if self.path.startswith(('http://', 'https://')) or urlsplit(self.path).path != '/workflow':
                    return super().do_POST()
                try:
                    payload = self.read_comparison_payload()
                except (ValueError, UnicodeError, RecursionError):
                    self.close_connection = True
                    return self.reply({'error': '请求须为有效 JSON 对象，内容不超过 64 KiB。'}, 400)
                try:
                    self.reply(runtime.save_workflow(payload))
                except StoreError as error:
                    self.workflow_error(error)
                except OSError:
                    self.workflow_error(StoreError('STORE_IO', 'Local write failed'))

        self.server.RequestHandlerClass = WorkflowHandler

    @staticmethod
    def _empty_workflow(project_id):
        return {'projectId': project_id, 'revision': 0, 'mode': 'generate', 'target': None,
            'references': [], 'updatedAt': None}

    def _read_workflow(self, project_id):
        path = self.store._path(self.workflow_dir, project_id + '.json')
        if not path.exists():
            return self._empty_workflow(project_id)
        value = self.store._read_json(path, MAX_BODY_BYTES)
        if not _payload(value, True) or value['projectId'] != project_id:
            raise StoreError('CORRUPT_DATA', 'Invalid workflow context')
        return value

    def _asset_bytes(self, digest):
        """Digest check under the caller's store lock; never nest public locks."""
        if not _digest(digest):
            raise StoreError('INVALID_ASSET_ID', 'Invalid asset digest')
        path = self.store._path(self.store.assets_dir, digest)
        metadata = self.store._read_json(self.store._path(self.store.assets_dir, digest + '.json'), 16384)
        if not path.is_file():
            raise StoreError('NOT_FOUND', 'Asset bytes do not exist')
        if path.stat().st_size > self.store.max_asset_bytes:
            raise StoreError('CORRUPT_DATA', 'Asset exceeds the size limit')
        data = path.read_bytes()
        if (metadata.get('assetId') != digest or metadata.get('sha256') != digest
            or metadata.get('size') != len(data) or hashlib.sha256(data).hexdigest() != digest):
            raise StoreError('CORRUPT_DATA', 'Asset digest verification failed')
        try:
            mime = self.store._asset_mime(data)
        except StoreError as error:
            raise StoreError('CORRUPT_DATA', 'Asset type verification failed') from error
        if metadata.get('mime') != mime:
            raise StoreError('CORRUPT_DATA', 'Asset MIME verification failed')
        return data, mime

    @staticmethod
    def _images(project):
        if not project['canvas']:
            return {}
        document = json.loads(gzip.decompress(base64.b64decode(project['canvas'][len(CANVAS_PREFIX):])))
        records = document['tldrawSnapshot']['document']['store']
        images = {}
        for key, shape in records.items():
            if not isinstance(shape, dict) or shape.get('typeName') != 'shape' or shape.get('type') != 'c-image':
                continue
            if shape.get('id') != key or not _shape_id(key) or not isinstance(shape.get('props'), dict):
                continue
            props = shape['props']
            # Native local uploads have explicit stable URLs. Arbitrary foreign
            # URLs are never authorized by matching a path suffix or originalUrl.
            digest = _url_digest(props.get('url'))
            images[key] = {'shapeId': key, 'assetSha256': digest,
                'name': props.get('name') if _text(props.get('name'), 255) else '画布图片',
                'width': props.get('w') if isinstance(props.get('w'), (int, float))
                    and not isinstance(props.get('w'), bool) and props['w'] > 0 else None,
                'height': props.get('h') if isinstance(props.get('h'), (int, float))
                    and not isinstance(props.get('h'), bool) and props['h'] > 0 else None}
        return images

    def _association_issue(self, resource, images, *, scope, index=None, blocking=False):
        shape_id, digest = resource['shapeId'], resource['assetSha256']
        code = None
        if shape_id is not None:
            if shape_id not in images:
                code, message = 'SHAPE_MISSING', '原图片对象已被删除或不是图片，请明确移除或重新选择。'
            elif images[shape_id]['assetSha256'] != digest:
                code, message = 'SHAPE_ASSET_CHANGED', '图片对象的素材已变化，原引用仍保留，请明确重新选择。'
        elif not any(image['assetSha256'] == digest for image in images.values()):
            code, message = 'ASSET_NOT_IN_CANVAS', '这份素材已不在当前画布中，原引用仍保留。'
        if code is None:
            try:
                self._asset_bytes(digest)
            except StoreError as error:
                code = 'ASSET_MISSING' if error.code == 'NOT_FOUND' else 'ASSET_UNAVAILABLE'
                message = '素材文件缺失或校验失败，请保留引用并检查本地文件。'
        if code is None:
            return None
        return {'code': code, 'scope': scope, **({'index': index} if index is not None else {}),
            'shapeId': shape_id, 'assetSha256': digest, 'message': message, 'blocking': blocking}

    def _issues(self, value, images):
        issues = []
        for index, reference in enumerate(value['references']):
            issue = self._association_issue(reference, images, scope='reference', index=index,
                blocking=reference['participates'])
            if issue:
                issues.append(issue)
        if value['target'] is not None:
            issue = self._association_issue(value['target'], images, scope='target', blocking=True)
            if issue:
                issues.append(issue)
        return issues

    def get_workflow(self, project_id):
        project_id = self.store._project_id(project_id)
        with self.store._locked():
            project = self.store._read_project(project_id)
            value = self._read_workflow(project_id)
            return {**value, 'issues': self._issues(value, self._images(project))}

    def save_workflow(self, payload):
        if not _payload(payload):
            raise StoreError('INVALID_INPUT', 'Invalid workflow payload')
        project_id = self.store._project_id(payload['projectId'])
        with self.store._locked():
            project = self.store._read_project(project_id)
            current = self._read_workflow(project_id)
            if current['revision'] != payload['revision']:
                raise StoreError('WORKFLOW_CONFLICT', 'Workflow changed since read')
            images = self._images(project)
            old_references = {(r['shapeId'], r['assetSha256']): r for r in current['references']}
            for reference in payload['references']:
                if self._association_issue(reference, images, scope='reference'):
                    old = old_references.get((reference['shapeId'], reference['assetSha256']))
                    if old is None or (reference['participates'] and not old['participates']):
                        raise StoreError('INVALID_ASSOCIATION', 'New or activated reference is not valid')
            target = payload['target']
            if target is not None and self._association_issue(target, images, scope='target'):
                if current['mode'] != 'modify' or current['target'] != target:
                    raise StoreError('INVALID_ASSOCIATION', 'New edit target is not valid')
            value = {**payload, 'revision': current['revision'] + 1,
                'updatedAt': max(time.time_ns() // 1000000, (current['updatedAt'] or 0) + 1)}
            self.store._write_json(self.store._path(self.workflow_dir, project_id + '.json'), value)
            return {**value, 'issues': self._issues(value, images)}

    def get_workflow_assets(self, project_id):
        project_id = self.store._project_id(project_id)
        with self.store._locked():
            images = self._images(self.store._read_project(project_id))
            assets, issues = [], []
            for image in images.values():
                digest = image['assetSha256']
                if digest is None:
                    issues.append({'code': 'NONLOCAL_ASSET', 'scope': 'asset', **image,
                        'message': '这张图片尚未有可验证的本地素材文件。', 'blocking': True})
                    continue
                issue = self._association_issue(image, images, scope='asset', blocking=True)
                row = {**image, 'valid': issue is None}
                if issue:
                    issues.append(issue)
                else:
                    _, row['mime'] = self._asset_bytes(digest)
                assets.append(row)
            return {'projectId': project_id, 'assets': assets, 'issues': issues}

    def get_workflow_image(self, project_id, digest):
        project_id = self.store._project_id(project_id)
        if not _digest(digest):
            raise StoreError('INVALID_ASSET_ID', 'Invalid asset digest')
        with self.store._locked():
            images = self._images(self.store._read_project(project_id))
            value = self._read_workflow(project_id)
            owned = {image['assetSha256'] for image in images.values()}
            owned.update(reference['assetSha256'] for reference in value['references'])
            if value['target']:
                owned.add(value['target']['assetSha256'])
            if digest not in owned:
                raise StoreError('NOT_FOUND', 'Asset does not belong to this project')
            return self._asset_bytes(digest)
