"""Opt-in draft reference receipts without rewriting native input-form data.

New canvas references require a current project image and verified bytes. A
previously accepted reference may remain in its own draft after its image is
removed or replaced; a read-only receipt explains that condition. Encoded
element identities are compared forward, never decoded by replacing hyphens.
"""
from __future__ import annotations

import copy
import json
import time
from urllib.parse import parse_qs, urlsplit

from local_runtime import ROOT
from local_store import StoreError
from m6_runtime import _shape_id
from m22_runtime import (LOCAL_ASSET, MAX_DRAFT_BYTES, MAX_STORED_BYTES,
    RESOURCE_FIELDS, M22Runtime, _decode_object, _payload_valid, _walk_dicts)
from m21_runtime import LAYOUT_PARAMETERS


ASSET_MIMES = {
    '/m23-studio.css': 'text/css; charset=utf-8',
    '/m23-studio.js': 'application/javascript; charset=utf-8',
    '/m23-canvas.css': 'text/css; charset=utf-8',
    '/m23-canvas.js': 'application/javascript; charset=utf-8',
}
DRAFT_PARAMETERS = {**LAYOUT_PARAMETERS, 'draftUi': 'm23'}
CANVAS_DRAFT_TAGS = (b'<link rel="stylesheet" href="/m23-canvas.css">'
    b'<script defer src="/m23-canvas.js"></script>')
MAX_REFERENCE_HISTORY = 1024
MAX_HISTORY_BYTES = 512 * 1024


def _invalid(message):
    raise StoreError('INVALID_ASSOCIATION', message)


def _encoded_id(value):
    return isinstance(value, str) and value.startswith('shape-') and 6 < len(value) <= 200 and all(
        32 < ord(character) < 127 for character in value)


def _reference(param, *, projection=False):
    data = param.get('data')
    if param.get('type') != 'image' or not isinstance(data, dict):
        _invalid('Only captured local image references are supported')
    if any(item.get('markId') is not None for item in (param, data)):
        _invalid('Mark references are not supported by the captured draft subset')
    url = data.get('imageUrl')
    match = LOCAL_ASSET.fullmatch(url) if isinstance(url, str) else None
    if match is None:
        _invalid('Image reference has no stable local URL')
    keys, shapes, elements = [], [], []
    for item in (param, data):
        if item.get('shapeId') is not None:
            if not _shape_id(item['shapeId']):
                _invalid('Invalid canonical shape identity')
            shapes.append(item['shapeId'])
        if item.get('elementId') is not None:
            value = item['elementId']
            if not _shape_id(value) and not _encoded_id(value):
                _invalid('Invalid encoded canvas identity')
            if value.startswith('shape:'):
                if not _shape_id(value):
                    _invalid('Invalid canonical element identity')
                shapes.append(value)
            else:
                elements.append(value)
    if param.get('key') is not None:
        value = param['key']
        if not isinstance(value, str) or not value or len(value) > 20000:
            _invalid('Invalid native business key')
        keys.append(value)
    if len(set(shapes)) > 1 or len(set(elements)) > 1:
        _invalid('Native image identities disagree')
    canonical = shapes[0] if shapes else None
    encoded = elements[0] if elements else None
    if canonical and encoded and canonical.replace(':', '-') != encoded:
        _invalid('Native image identities disagree')
    identity = ({'kind': 'key', 'value': keys[0]} if keys else
        {'kind': 'elementId', 'value': encoded or canonical} if encoded or canonical else None)
    return {'identity': identity, 'canonical': canonical, 'encoded': encoded,
        'digest': match.group(1), 'label': param.get('label') if isinstance(param.get('label'), str) else '图片引用',
        'source': param.get('source'), 'projection': projection}


def _references(form):
    references = [_reference(param) for param in form['paramList']]
    for node in _walk_dicts(form.get('lexicalJSONState')):
        if 'param' in node and isinstance(node['param'], dict):
            references.append(_reference(node['param']))
    projections = []
    for param in form.get('mentionPreviewList', []):
        if not isinstance(param, dict):
            continue
        reference = _reference(param, projection=True)
        # Preview entries can be derived display projections without a key or
        # shape identity. Their URL is still checked and must correspond to an
        # actual captured primary reference (or a global upload).
        if reference['canonical'] or reference['encoded'] or reference['identity'] or reference['source'] == 'upload':
            references.append(reference)
        else:
            projections.append(reference)
    return references, projections


def _same_canvas(left, right):
    if left['digest'] != right['digest']:
        return False
    if left['canonical'] and right['canonical']:
        return left['canonical'] == right['canonical']
    left_encoded = left['encoded'] or (left['canonical'].replace(':', '-') if left['canonical'] else None)
    right_encoded = right['encoded'] or (right['canonical'].replace(':', '-') if right['canonical'] else None)
    return bool(left_encoded and left_encoded == right_encoded)


class M23Runtime(M22Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        self.reference_history_dir = self.store.data_dir / 'conversation-reference-history'
        try:
            self.store._check_directory(self.reference_history_dir)
        except (StoreError, OSError):
            self.server.server_close()
            raise
        base_handler = self.server.RequestHandlerClass

        class ReferenceDraftFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                opted_in = (parsed.path in ('/canvas', '/canvas/') and
                    all(query.get(key) == [value] for key, value in DRAFT_PARAMETERS.items()))
                if opted_in and status == 200 and mime.startswith('text/html') and isinstance(data, bytes):
                    if data.count(b'</body>') != 1 or b'/m23-canvas.css' in data or b'/m23-canvas.js' in data:
                        return super().reply({'error': 'M23 引用入口校验失败，请检查本机资源。'}, 503)
                    data = data.replace(b'</body>', CANVAS_DRAFT_TAGS + b'</body>', 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m23-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_MIMES:
                    return self.serve_ui(path[1:], ASSET_MIMES[path])
                return super().do_GET()

        self.server.RequestHandlerClass = ReferenceDraftFrontendHandler

    @staticmethod
    def _resolve(reference, images, previous):
        canonical = reference['canonical']
        if canonical:
            return canonical
        encoded = reference['encoded']
        if not encoded:
            return None
        candidates = {shape_id for shape_id in images if shape_id.replace(':', '-') == encoded}
        candidates.update(item['canonical'] for item in previous if item['canonical']
            and item['canonical'].replace(':', '-') == encoded and item['digest'] == reference['digest'])
        if len(candidates) > 1:
            _invalid('Ambiguous native encoded image identity')
        return next(iter(candidates), None)

    def _reference_receipt(self, form, project, *, previous_form=None, history=(), stored=False):
        references, projections = _references(form)
        previous = _references(previous_form)[0] if previous_form is not None else []
        previous.extend(self._history_references(history))
        images = self._images(project)
        assets, issues, seen = {}, [], set()

        def asset_status(digest):
            if digest not in assets:
                try:
                    self._asset_bytes(digest)
                    assets[digest] = None
                except StoreError as error:
                    if error.code == 'NOT_FOUND':
                        assets[digest] = 'ASSET_MISSING'
                    elif error.code in ('CORRUPT_DATA', 'INVALID_ASSET'):
                        assets[digest] = 'ASSET_UNAVAILABLE'
                    else:
                        # An actual IO error is still a 507, not a successful
                        # receipt claiming that the asset merely disappeared.
                        raise
            return assets[digest]

        retained_digests = set()
        for reference in references:
            canvas = bool(reference['canonical'] or reference['encoded'])
            canonical = self._resolve(reference, images, previous)
            known = (stored or any(_same_canvas(reference, old) for old in previous)) if canvas else (
                stored or any(old['source'] == 'upload' and not old['canonical'] and not old['encoded']
                    and old['digest'] == reference['digest'] for old in previous))
            shape_code = None
            if canvas:
                if canonical is None or canonical not in images:
                    shape_code = 'SHAPE_MISSING'
                elif images[canonical]['assetSha256'] != reference['digest']:
                    shape_code = 'SHAPE_ASSET_CHANGED'
                if shape_code and not known:
                    _invalid('New canvas image belongs to another project or changed')
            elif reference['source'] != 'upload':
                _invalid('Canvas image identity is missing')
            asset_code = asset_status(reference['digest'])
            if asset_code and not known:
                _invalid('New image asset is missing or unavailable')
            if known:
                retained_digests.add(reference['digest'])
            code = asset_code or shape_code
            if not code:
                continue
            if reference['projection'] and any(not item['projection'] and
                item['digest'] == reference['digest'] and (_same_canvas(reference, item) or
                (not canvas and item['source'] == 'upload' and not item['canonical'] and not item['encoded']))
                for item in references):
                continue
            identity = reference['identity']
            identity_token = (identity['kind'], identity['value']) if identity else (
                'elementId', reference['encoded'] or canonical) if reference['encoded'] or canonical else ('asset', reference['digest'])
            token = (identity_token, reference['digest'])
            if token in seen:
                continue
            seen.add(token)
            message = {
                'SHAPE_MISSING': '图片已从画布删除，原图片引用仍保留。',
                'SHAPE_ASSET_CHANGED': '画布图片已更换，输入框仍引用原图片。',
                'ASSET_MISSING': '原图片文件缺失，文字和引用仍保留。',
                'ASSET_UNAVAILABLE': '原图片文件校验失败，文字和引用仍保留。',
            }[code]
            issues.append({'code': code, 'identity': copy.deepcopy(identity), 'shapeId': canonical,
                'assetSha256': reference['digest'], 'label': reference['label'], 'message': message})

        for reference in projections:
            if reference['source'] != 'upload' and not any(item['digest'] == reference['digest'] for item in references):
                _invalid('Preview has no captured canvas reference')
            missing = asset_status(reference['digest'])
            if missing and reference['digest'] not in retained_digests:
                _invalid('Preview image asset is missing or unavailable')

        # Check every actual location, including preview thumbnails; opaque
        # business keys containing an old blob origin are deliberately ignored.
        for item in _walk_dicts(form):
            for key in RESOURCE_FIELDS.intersection(item):
                value = item[key]
                if value in (None, ''):
                    continue
                match = LOCAL_ASSET.fullmatch(value) if isinstance(value, str) else None
                if match is None:
                    _invalid('Unsupported resource URL')
                digest = match.group(1)
                if asset_status(digest) and digest not in retained_digests:
                    _invalid('Resource has no previously captured image reference')
        return issues

    def _read_reference_history(self, project_id):
        path = self.store._path(self.reference_history_dir, project_id + '.json')
        if not path.exists():
            return []
        try:
            with path.open('rb') as stream:
                raw = stream.read(MAX_HISTORY_BYTES + 1)
            if len(raw) > MAX_HISTORY_BYTES:
                raise ValueError('Reference history exceeds size limit')
            value = _decode_object(raw)
            if set(value) != {'projectId', 'records'} or value['projectId'] != project_id:
                raise ValueError('Reference history belongs to another project')
            records = value['records']
            if not isinstance(records, list) or len(records) > MAX_REFERENCE_HISTORY:
                raise ValueError('Invalid reference history size')
            tokens = set()
            for record in records:
                if not isinstance(record, dict) or record.get('kind') not in ('canvas', 'upload'):
                    raise ValueError('Invalid history record kind')
                fields = {'kind', 'assetSha256'} | ({'shapeId', 'elementId'} if record['kind'] == 'canvas' else set())
                if set(record) != fields or not isinstance(record['assetSha256'], str) or not LOCAL_ASSET.fullmatch(
                    'https://local-assets.invalid/' + record['assetSha256']):
                    raise ValueError('Invalid reference history fields')
                if record['kind'] == 'canvas':
                    shape, encoded = record['shapeId'], record['elementId']
                    if shape is not None and not _shape_id(shape):
                        raise ValueError('Invalid historical canonical shape')
                    if not _encoded_id(encoded):
                        raise ValueError('Invalid historical encoded shape')
                    if shape and encoded != shape.replace(':', '-'):
                        raise ValueError('Historical identities disagree')
                token = json.dumps(record, sort_keys=True, separators=(',', ':'))
                if token in tokens:
                    raise ValueError('Duplicate reference history record')
                tokens.add(token)
            return records
        except (ValueError, UnicodeError, RecursionError) as error:
            raise StoreError('CORRUPT_DATA', 'Reference history failed validation') from error

    @staticmethod
    def _history_references(records):
        return [{'identity': None, 'canonical': record.get('shapeId'), 'encoded': record.get('elementId'),
            'digest': record['assetSha256'], 'label': '', 'source': record['kind'], 'projection': False}
            for record in records]

    def _next_reference_history(self, history, project, forms):
        images = self._images(project)
        previous = self._history_references(history)
        current = [reference for form in forms if form is not None for reference in _references(form)[0]]
        previous.extend(current)
        records = list(history)
        for reference in current:
            if reference['canonical'] or reference['encoded']:
                canonical = self._resolve(reference, images, previous)
                record = {'kind': 'canvas', 'shapeId': canonical,
                    'elementId': reference['encoded'] or canonical.replace(':', '-'), 'assetSha256': reference['digest']}
            else:
                record = {'kind': 'upload', 'assetSha256': reference['digest']}
            if record in records:
                records.remove(record)
            records.append(record)
        # Current-form proofs are most recent and survive pruning. Older undo
        # identities beyond this bound require selecting their image again.
        records = records[-MAX_REFERENCE_HISTORY:]
        while len(json.dumps({'projectId': project['projectId'], 'records': records},
            ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_HISTORY_BYTES:
            records.pop(0)
        return records

    def _write_reference_history(self, project_id, records):
        value = {'projectId': project_id, 'records': records}
        if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_HISTORY_BYTES:
            raise StoreError('INVALID_INPUT', 'Reference history exceeds size limit')
        self.store._check_directory(self.reference_history_dir)
        self.reference_history_dir.mkdir(exist_ok=True)
        self.store._write_json(self.store._path(self.reference_history_dir, project_id + '.json'), value)

    def get_draft(self, project_id):
        project_id = self.store._project_id(project_id)
        with self.store._locked():
            project = self.store._read_project(project_id)
            value = self._read_draft(project_id)
            issues = self._reference_receipt(value['inputForm'], project, stored=True) if value['inputForm'] is not None else []
            return {**value, 'referenceIssues': issues}

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
            # Parse the old form too; unsupported/corrupt reference structure
            # never turns into an authorization pool for a subsequent save.
            if current['inputForm'] is not None:
                self._reference_receipt(current['inputForm'], project, stored=True)
            history = self._read_reference_history(project_id)
            issues = self._reference_receipt(payload['inputForm'], project, previous_form=current['inputForm'], history=history)
            value = {**copy.deepcopy(payload), 'revision': current['revision'] + 1,
                'updatedAt': max(time.time_ns() // 1000000, (current['updatedAt'] or 0) + 1)}
            if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_STORED_BYTES:
                raise StoreError('INVALID_INPUT', 'Stored draft exceeds size limit')
            next_history = self._next_reference_history(history, project, (current['inputForm'], payload['inputForm']))
            if next_history != history:
                # These are two atomic writes, not one transaction. The proof
                # records authorization already positively established above,
                # not a successful draft receipt. If the following main write
                # fails, old draft bytes remain and a valid proof may remain;
                # it still cannot authorize another project's unknown image.
                self._write_reference_history(project_id, next_history)
            self.store._check_directory(self.draft_dir)
            self.draft_dir.mkdir(exist_ok=True)
            self.store._write_json(self.store._path(self.draft_dir, project_id + '.json'), value)
            return {**value, 'referenceIssues': issues}
