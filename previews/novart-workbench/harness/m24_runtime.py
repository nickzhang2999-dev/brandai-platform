"""Persist captured native rendered reference images beside unchanged canvas data.

Image pixels still come from the original browser renderer and its original
upload helper. This adapter checks uploaded bytes and their current local shape
snapshot, then records a bounded project proof. It does not render a crop, fetch
foreign URLs, change a canvas image, or imply that the conversation draft saved.
"""
from __future__ import annotations

import base64
import copy
import gzip
import hashlib
import io
import json
import math
import time
from urllib.parse import parse_qs, urlsplit

from PIL import Image, UnidentifiedImageError

from compare_runtime import _error_reply, _integer
from local_runtime import ROOT
from local_store import CANVAS_PREFIX, StoreError
from m6_runtime import _digest, _shape_id, _url_digest
from m21_runtime import LAYOUT_PARAMETERS
from m22_runtime import (LOCAL_ASSET, MAX_DRAFT_BYTES, MAX_STORED_BYTES,
    RESOURCE_FIELDS, _bounded_json, _decode_object, _payload_valid, _walk_dicts)
from m23_runtime import (MAX_HISTORY_BYTES, MAX_REFERENCE_HISTORY,
    M23Runtime, _encoded_id, _invalid, _references, _same_canvas)


ASSET_MIMES = {
    '/m24-studio.css': 'text/css; charset=utf-8',
    '/m24-studio.js': 'application/javascript; charset=utf-8',
    '/m24-canvas.css': 'text/css; charset=utf-8',
    '/m24-canvas.js': 'application/javascript; charset=utf-8',
}
DRAFT_PARAMETERS = {**LAYOUT_PARAMETERS, 'draftUi': 'm24'}
CANVAS_DRAFT_TAGS = (b'<link rel="stylesheet" href="/m24-canvas.css">'
    b'<script defer src="/m24-canvas.js"></script>')
MAX_CONTEXT_BYTES = 64 * 1024
MAX_DERIVED_RECORDS = 1024
MAX_DERIVED_BYTES = 1024 * 1024
MAX_UPLOAD_ALIAS_BYTES = 4 * 1024 * 1024
MAX_IMAGE_EDGE = 16384
MAX_IMAGE_PIXELS = 32 * 1024 * 1024
CONTEXT_FIELDS = {'shapeId', 'elementId', 'sourceAssetSha256', 'shapeProps',
    'rotation', 'contextFingerprint'}
PROOF_FIELDS = {'shapeId', 'elementId', 'sourceAssetSha256', 'contextFingerprint',
    'assetSha256', 'mime', 'width', 'height', 'size', 'createdAt'}
RENDER_PROP_FIELDS = {'url', 'originalUrl', 'w', 'h', 'adjust', 'flipX',
    'flipY', 'cropRegion'}


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
        separators=(',', ':')).encode('utf-8')


def _fingerprint_numbers(value):
    """Normalize only hash input to the semantic browser JSON number form.

    Native canvas props and returned context keep their original representation.
    JavaScript serializes integral floats and negative zero as integers, so the
    same numeric context must retain its fingerprint after a browser round trip.
    """
    if isinstance(value, dict):
        return {key: _fingerprint_numbers(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_fingerprint_numbers(item) for item in value]
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return value


def _fingerprint(shape_id, props, rotation):
    return hashlib.sha256(_canonical(_fingerprint_numbers({'shapeId': shape_id,
        'shapeProps': props, 'rotation': rotation}))).hexdigest()


def _render_props(props):
    # Exactly the native renderer's dependencies. Cosmetic label, canvas
    # position and selection changes do not invalidate captured image pixels.
    return {key: copy.deepcopy(value) for key, value in props.items()
        if key in RENDER_PROP_FIELDS}


def _rotation(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
        and abs(value) <= 2**53 - 1 and math.isfinite(value))


def _context_valid(value):
    return (isinstance(value, dict) and set(value) == CONTEXT_FIELDS
        and _shape_id(value['shapeId']) and _encoded_id(value['elementId'])
        and value['elementId'] == value['shapeId'].replace(':', '-')
        and _digest(value['sourceAssetSha256']) and isinstance(value['shapeProps'], dict)
        and set(value['shapeProps']) <= RENDER_PROP_FIELDS
        and _bounded_json(value['shapeProps']) and _rotation(value['rotation'])
        and _url_digest(value['shapeProps'].get('url')) == value['sourceAssetSha256']
        and _digest(value['contextFingerprint'])
        and len(_canonical(value)) <= MAX_CONTEXT_BYTES
        and value['contextFingerprint'] == _fingerprint(value['shapeId'],
            value['shapeProps'], value['rotation']))


class M24Runtime(M23Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        self.derived_reference_dir = self.store.data_dir / 'conversation-derived-images'
        try:
            self.store._check_directory(self.derived_reference_dir)
        except (StoreError, OSError):
            self.server.server_close()
            raise
        runtime = self
        base_handler = self.server.RequestHandlerClass

        class RenderedReferenceHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                opted_in = (parsed.path in ('/canvas', '/canvas/') and
                    all(query.get(key) == [value] for key, value in DRAFT_PARAMETERS.items()))
                if opted_in and status == 200 and mime.startswith('text/html') and isinstance(data, bytes):
                    if data.count(b'</body>') != 1 or b'/m24-canvas.css' in data or b'/m24-canvas.js' in data:
                        return super().reply({'error': 'M24 裁切引用入口校验失败，请检查本机资源。'}, 503)
                    data = data.replace(b'</body>', CANVAS_DRAFT_TAGS + b'</body>', 1)
                return super().reply(data, status, mime)

            def reference_error(self, error):
                if error.code == 'REFERENCE_CONFLICT':
                    result, status = {'error': '画布图片已改变或尚未保存，当前裁切引用还没有暂存。'}, 409
                elif error.code == 'REFERENCE_LIMIT':
                    result, status = {'error': '本机裁切引用记录已达到上限，当前引用尚未暂存。'}, 400
                elif error.code == 'STORE_IO':
                    result, status = {'error': '裁切引用写入失败，当前图片和之前草稿仍保留；请重试。'}, 507
                elif error.code == 'INVALID_ASSOCIATION':
                    result, status = {'error': '无法核对这张裁切引用的本地图片和画布来源。'}, 400
                else:
                    result, status = _error_reply(error)
                self.reply({'code': error.code, **result}, status)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                path = parsed.path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m24-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_MIMES:
                    return self.serve_ui(path[1:], ASSET_MIMES[path])
                if path != '/studio/reference-image/context':
                    return super().do_GET()
                try:
                    query = parse_qs(parsed.query, keep_blank_values=True)
                    if set(query) != {'projectId', 'elementId'} or any(len(values) != 1 for values in query.values()):
                        raise StoreError('INVALID_INPUT', 'Expected one project and one native element')
                    self.reply(runtime.get_reference_context(query['projectId'][0], query['elementId'][0]))
                except StoreError as error:
                    self.reference_error(error)
                except OSError:
                    self.reference_error(StoreError('STORE_IO', 'Reference context read failed'))

            def read_reference_payload(self):
                lengths = self.headers.get_all('Content-Length', [])
                if self.headers.get('Transfer-Encoding') or len(lengths) != 1 or not lengths[0].isdigit():
                    raise ValueError('Invalid request framing')
                length = int(lengths[0])
                if not 0 < length <= MAX_CONTEXT_BYTES or self.headers.get_content_type() != 'application/json':
                    raise ValueError('Invalid JSON request length or content type')
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Incomplete request')
                return _decode_object(raw)

            def do_POST(self):
                if self.path.startswith(('http://', 'https://')) or urlsplit(self.path).path != '/studio/reference-image':
                    return super().do_POST()
                try:
                    payload = self.read_reference_payload()
                except (ValueError, UnicodeError, RecursionError):
                    self.close_connection = True
                    return self.reply({'code': 'INVALID_INPUT', 'error': '裁切引用请求须为有效、有限的 JSON 对象。'}, 400)
                try:
                    self.reply(runtime.bind_reference_image(payload))
                except StoreError as error:
                    self.reference_error(error)
                except OSError:
                    self.reference_error(StoreError('STORE_IO', 'Rendered reference write failed'))

        self.server.RequestHandlerClass = RenderedReferenceHandler

    @staticmethod
    def _image_shapes(project):
        if not project['canvas']:
            return {}
        document = json.loads(gzip.decompress(base64.b64decode(project['canvas'][len(CANVAS_PREFIX):])))
        return {key: shape for key, shape in document['tldrawSnapshot']['document']['store'].items()
            if isinstance(shape, dict) and shape.get('id') == key and _shape_id(key)
            and shape.get('typeName') == 'shape' and shape.get('type') == 'c-image'
            and isinstance(shape.get('props'), dict)}

    def _shape_context(self, shape):
        props = _render_props(shape['props'])
        source = _url_digest(props.get('url'))
        rotation = shape.get('rotation', 0)
        if source is None or not _bounded_json(props) or not _rotation(rotation):
            _invalid('Rendered reference source is not a bounded local image')
        original = props.get('originalUrl')
        if original not in (None, ''):
            original_digest = _url_digest(original)
            if original_digest is None:
                _invalid('Original image is not local')
            self._asset_bytes(original_digest)
        self._asset_bytes(source)
        shape_id = shape['id']
        value = {'shapeId': shape_id, 'elementId': shape_id.replace(':', '-'),
            'sourceAssetSha256': source, 'shapeProps': copy.deepcopy(props),
            'rotation': rotation, 'contextFingerprint': _fingerprint(shape_id, props, rotation)}
        if not _context_valid(value):
            _invalid('Rendered reference context is invalid or exceeds its size limit')
        return value

    def get_reference_context(self, project_id, element_id):
        project_id = self.store._project_id(project_id)
        if not _encoded_id(element_id):
            raise StoreError('INVALID_INPUT', 'Invalid native encoded element identity')
        with self.store._locked():
            project = self.store._read_project(project_id)
            candidates = [shape for shape_id, shape in self._image_shapes(project).items()
                if shape_id.replace(':', '-') == element_id]
            if len(candidates) != 1:
                raise StoreError('REFERENCE_CONFLICT', 'Native image is absent or ambiguous')
            return {'projectId': project_id, 'context': self._shape_context(candidates[0])}

    def _read_derived_history(self, project_id):
        path = self.store._path(self.derived_reference_dir, project_id + '.json')
        if not path.exists():
            return []
        try:
            with path.open('rb') as stream:
                raw = stream.read(MAX_DERIVED_BYTES + 1)
            if len(raw) > MAX_DERIVED_BYTES:
                raise ValueError('Derived reference history exceeds its size limit')
            value = _decode_object(raw)
            if set(value) != {'projectId', 'records'} or value['projectId'] != project_id:
                raise ValueError('Derived history belongs to another project')
            records = value['records']
            if not isinstance(records, list) or len(records) > MAX_DERIVED_RECORDS:
                raise ValueError('Invalid derived history length')
            tokens = set()
            for record in records:
                if (not isinstance(record, dict) or set(record) != PROOF_FIELDS
                    or not _shape_id(record['shapeId']) or not _encoded_id(record['elementId'])
                    or record['elementId'] != record['shapeId'].replace(':', '-')
                    or any(not _digest(record[field]) for field in ('sourceAssetSha256', 'contextFingerprint', 'assetSha256'))
                    or record['mime'] not in ('image/png', 'image/jpeg', 'image/webp')
                    or not _integer(record['width'], 1, MAX_IMAGE_EDGE)
                    or not _integer(record['height'], 1, MAX_IMAGE_EDGE)
                    or record['width'] * record['height'] > MAX_IMAGE_PIXELS
                    or not _integer(record['size'], 1, self.store.max_asset_bytes)
                    or not _integer(record['createdAt'], 1, 2**53 - 1)):
                    raise ValueError('Invalid derived reference proof')
                token = (record['shapeId'], record['assetSha256'], record['contextFingerprint'])
                if token in tokens:
                    raise ValueError('Duplicate derived reference proof')
                tokens.add(token)
            return records
        except (ValueError, UnicodeError, RecursionError) as error:
            raise StoreError('CORRUPT_DATA', 'Derived reference history failed validation') from error

    def _asset_url(self, value, digest):
        if not isinstance(value, str) or not _digest(digest):
            _invalid('Invalid rendered reference URL or digest')
        if any(character.isspace() or ord(character) < 33 or ord(character) == 127 for character in value):
            _invalid('Rendered reference URL contains whitespace or controls')
        local = LOCAL_ASSET.fullmatch(value)
        if local:
            if local.group(1) != digest:
                _invalid('Rendered reference URL digest disagrees')
            return 'https://local-assets.invalid/' + digest
        try:
            parsed = urlsplit(value)
        except ValueError:
            _invalid('Rendered reference URL is malformed')
        if (parsed.scheme != 'https' or parsed.netloc != 'assets-persist.lovart.ai'
            or parsed.query or parsed.fragment or not parsed.path.startswith('/') or not parsed.path):
            _invalid('Rendered reference URL is not a recognized local upload alias')
        with self.alias_lock:
            alias = self.aliases.get(parsed.path)
        if not isinstance(alias, dict) or alias.get('sha256') != digest:
            # A second local runtime may have completed the original helper's
            # upload since this instance started. Read only the bounded atomic
            # alias file; do not mutate another runtime's in-memory registry.
            if self.alias_path.is_symlink() or self.alias_path.resolve().parent != self.store.data_dir:
                raise StoreError('INVALID_PATH', 'Upload alias path escaped local data')
            if self.alias_path.exists():
                try:
                    with self.alias_path.open('rb') as stream:
                        raw = stream.read(MAX_UPLOAD_ALIAS_BYTES + 1)
                    if len(raw) > MAX_UPLOAD_ALIAS_BYTES:
                        raise ValueError('Upload alias registry exceeds lookup limit')
                    alias = _decode_object(raw).get(parsed.path)
                except (ValueError, UnicodeError, RecursionError) as error:
                    raise StoreError('CORRUPT_DATA', 'Upload alias registry failed validation') from error
        if not isinstance(alias, dict) or alias.get('sha256') != digest:
            _invalid('Rendered reference upload alias is unknown or disagrees')
        return 'https://local-assets.invalid/' + digest

    @staticmethod
    def _image_dimensions(data, mime):
        try:
            with Image.open(io.BytesIO(data)) as image:
                width, height = image.size
                if (image.format not in ('PNG', 'JPEG', 'WEBP') or getattr(image, 'is_animated', False)
                    or not 0 < width <= MAX_IMAGE_EDGE or not 0 < height <= MAX_IMAGE_EDGE
                    or width * height > MAX_IMAGE_PIXELS
                    or Image.MIME.get(image.format) != mime):
                    _invalid('Rendered image dimensions, animation or type exceed captured subset')
                image.load()
                return width, height
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
            raise StoreError('INVALID_ASSOCIATION', 'Rendered image bytes do not decode correctly') from error

    def bind_reference_image(self, payload):
        if (not isinstance(payload, dict) or set(payload) != {'projectId', 'context', 'assetUrl', 'sha256', 'width', 'height'}
            or not _context_valid(payload['context']) or not _digest(payload['sha256'])
            or not _integer(payload['width'], 1, MAX_IMAGE_EDGE)
            or not _integer(payload['height'], 1, MAX_IMAGE_EDGE)
            or payload['width'] * payload['height'] > MAX_IMAGE_PIXELS
            or len(_canonical(payload)) > MAX_CONTEXT_BYTES):
            raise StoreError('INVALID_INPUT', 'Invalid bounded rendered reference binding')
        project_id = self.store._project_id(payload['projectId'])
        captured = payload['context']
        with self.store._locked():
            project = self.store._read_project(project_id)
            shape = self._image_shapes(project).get(captured['shapeId'])
            if shape is None:
                raise StoreError('REFERENCE_CONFLICT', 'Captured image is no longer current')
            current = self._shape_context(shape)
            if current != captured:
                raise StoreError('REFERENCE_CONFLICT', 'Captured render context changed before binding')
            asset_url = self._asset_url(payload['assetUrl'], payload['sha256'])
            data, mime = self._asset_bytes(payload['sha256'])
            width, height = self._image_dimensions(data, mime)
            if (width, height) != (payload['width'], payload['height']):
                _invalid('Captured pixel dimensions disagree with decoded image')
            history = self._read_derived_history(project_id)
            fields = {'shapeId': captured['shapeId'], 'elementId': captured['elementId'],
                'sourceAssetSha256': captured['sourceAssetSha256'],
                'contextFingerprint': captured['contextFingerprint'],
                'assetSha256': payload['sha256'], 'mime': mime,
                'width': width, 'height': height, 'size': len(data)}
            found = next((record for record in history if all(record[key] == fields[key]
                for key in ('shapeId', 'assetSha256', 'contextFingerprint'))), None)
            if found is not None:
                if any(found[key] != value for key, value in fields.items()):
                    raise StoreError('CORRUPT_DATA', 'Existing captured image proof disagrees')
            else:
                record = {**fields, 'createdAt': time.time_ns() // 1000000}
                draft = self._read_draft(project_id)
                reference_history = self._read_reference_history(project_id)
                pinned = {(item.get('shapeId'), item['assetSha256']) for item in reference_history if item['kind'] == 'canvas'}
                if draft['inputForm'] is not None:
                    refs = _references(draft['inputForm'])[0]
                    previous = self._history_references(reference_history)
                    previous.extend({'canonical': item['shapeId'], 'encoded': item['elementId'],
                        'digest': item['assetSha256']} for item in history)
                    images = self._images(project)
                    pinned.update((self._resolve(reference, images, previous), reference['digest']) for reference in refs)
                records = [*history, record]
                def encoded_size():
                    return len(_canonical({'projectId': project_id, 'records': records}))
                while len(records) > MAX_DERIVED_RECORDS or encoded_size() > MAX_DERIVED_BYTES:
                    removable = next((index for index, item in enumerate(records[:-1])
                        if (item['shapeId'], item['assetSha256']) not in pinned), None)
                    if removable is None:
                        raise StoreError('REFERENCE_LIMIT', 'Pinned derived reference history exceeds limit')
                    records.pop(removable)
                self.store._check_directory(self.derived_reference_dir)
                self.derived_reference_dir.mkdir(exist_ok=True)
                self.store._write_json(self.store._path(self.derived_reference_dir, project_id + '.json'),
                    {'projectId': project_id, 'records': records})
            return {'projectId': project_id, 'assetUrl': asset_url, 'sha256': payload['sha256'],
                'width': width, 'height': height, 'mime': mime, 'size': len(data),
                'contextFingerprint': captured['contextFingerprint'],
                'shapeId': captured['shapeId'], 'elementId': captured['elementId']}

    def _reference_receipt(self, form, project, *, previous_form=None, history=(), stored=False):
        references, projections = _references(form)
        previous = _references(previous_form)[0] if previous_form is not None else []
        previous.extend(self._history_references(history))
        images = self._images(project)
        shapes = self._image_shapes(project)
        proofs = self._read_derived_history(project['projectId'])
        # These proofs are accepted only by the project-specific binding above.
        # They resolve captured encoded IDs even if their shape was later deleted.
        previous.extend({'canonical': item['shapeId'], 'encoded': item['elementId'],
            'digest': item['assetSha256']} for item in proofs)
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
                        raise
            return assets[digest]

        retained_digests = set()
        for reference in references:
            canvas = bool(reference['canonical'] or reference['encoded'])
            canonical = self._resolve(reference, images, previous)
            matching_proofs = [item for item in proofs if item['shapeId'] == canonical and item['assetSha256'] == reference['digest']]
            proof = matching_proofs[-1] if matching_proofs else None
            known = (stored or bool(proof) or any(_same_canvas(reference, old) for old in previous)) if canvas else (
                stored or any(old.get('source') == 'upload' and not old['canonical'] and not old['encoded']
                    and old['digest'] == reference['digest'] for old in previous))
            shape_code = None
            if canvas:
                if canonical is None or canonical not in images:
                    shape_code = 'SHAPE_MISSING'
                elif proof is not None:
                    native = shapes[canonical]
                    fingerprint = _fingerprint(canonical, _render_props(native['props']), native.get('rotation', 0))
                    current_proofs = [item for item in matching_proofs
                        if item['contextFingerprint'] == fingerprint
                        and images[canonical]['assetSha256'] == item['sourceAssetSha256']]
                    if current_proofs:
                        proof = current_proofs[-1]
                    elif images[canonical]['assetSha256'] != proof['sourceAssetSha256']:
                        shape_code = 'SHAPE_ASSET_CHANGED'
                    else:
                        shape_code = 'CROP_CONTEXT_CHANGED'
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
                'CROP_CONTEXT_CHANGED': '画布图片已调整，输入框保留之前的裁切引用。',
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

    def _next_reference_history(self, history, project, forms):
        images = self._images(project)
        previous = self._history_references(history)
        previous.extend({'canonical': item['shapeId'], 'encoded': item['elementId'],
            'digest': item['assetSha256']} for item in self._read_derived_history(project['projectId']))
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
        records = records[-MAX_REFERENCE_HISTORY:]
        while len(_canonical({'projectId': project['projectId'], 'records': records})) > MAX_HISTORY_BYTES:
            records.pop(0)
        return records

    # M23's get/save methods dispatch this class's receipt and history methods,
    # preserving its draft CAS and atomic main write behavior.
