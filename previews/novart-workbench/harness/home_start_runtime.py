"""Isolated homepage input staging and recoverable project creation.

The native document remains empty until the original editor saves it. A durable
intent precedes the context/project writes; retrying its request ID resumes the
same project. GET only reports durable state and never acknowledges imports.
"""
from __future__ import annotations

import io
import re
import time
import uuid
import warnings
from urllib.parse import parse_qs, unquote_to_bytes, urlsplit

from PIL import Image, UnidentifiedImageError

from compare_runtime import MAX_BODY_BYTES, _error_reply, _integer, _text
from local_store import StoreError
from m6_runtime import _digest, _shape_id
from project_library_runtime import ProjectLibraryRuntime


MAX_UPLOAD_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
REQUEST_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{31,63}\Z')
IMAGE_FORMATS = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}
ASSET_FIELDS = {'sha256', 'name', 'uploadName', 'mime', 'width', 'height', 'size'}
MANIFEST_FIELDS = {'schema', 'requestId', 'projectId', 'brief', 'assets', 'createdAt',
    'creationStatus', 'initialProject', 'initialContext', 'receipts'}


class HomeStartRuntime(ProjectLibraryRuntime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        self.start_assets_dir = self.store.data_dir / 'home-start-assets'
        self.start_jobs_dir = self.store.data_dir / 'home-start-jobs'
        try:
            for directory in (self.start_assets_dir, self.start_jobs_dir):
                self.store._check_directory(directory)
                directory.mkdir(exist_ok=True)
        except (StoreError, OSError):
            self.server.server_close()
            raise
        runtime = self
        base = self.server.RequestHandlerClass

        class HomeStartHandler(base):
            def start_error(self, error):
                messages = {
                    'REQUEST_CONFLICT': ('这次创建请求的内容已变化，请保留原请求重试，或明确开始新项目。', 409),
                    'PROJECT_EXISTS': ('该创建请求对应的项目标识已存在，请保留数据并重新开始新项目。', 409),
                    'ASSET_TOO_LARGE': ('图片不能超过 10 MiB，请换一张较小的图片。', 413),
                    'IMAGE_TOO_LARGE': ('图片解码后不能超过 4000 万像素，请先缩小图片。', 413),
                    'INVALID_ASSET': ('请选择可正常打开的 PNG、JPEG 或 WebP 图片。', 400),
                }
                if error.code == 'PROJECT_ARCHIVED':
                    return self.archive_error(error)
                if error.code in messages:
                    message, status = messages[error.code]
                    return self.reply({'code': error.code, 'error': message}, status)
                result, status = _error_reply(error)
                return self.reply({'code': error.code, **result}, status)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                if parsed.path in ('/studio', '/studio/'):
                    return self.serve_ui('home-start-studio.html', 'text/html; charset=utf-8')
                if parsed.path in ('/home-start-studio.js', '/home-start-studio.css', '/home-start-attachments.js'):
                    mime = 'text/css' if parsed.path.endswith('.css') else 'application/javascript'
                    return self.serve_ui(parsed.path[1:], mime + '; charset=utf-8')
                if parsed.path != '/studio/start/job' and not parsed.path.startswith('/studio/start/image/'):
                    return super().do_GET()
                try:
                    if parsed.path == '/studio/start/job':
                        query = parse_qs(parsed.query, keep_blank_values=True)
                        if (len(query) != 1 or not set(query) <= {'requestId', 'projectId'}
                            or len(next(iter(query.values()))) != 1):
                            raise StoreError('INVALID_INPUT', 'Exactly one requestId or projectId is required')
                        return self.reply(runtime.get_start_job(**{key: value[0] for key, value in query.items()}))
                    if parsed.query:
                        raise StoreError('INVALID_INPUT', 'Staged images accept no query parameters')
                    data, mime = runtime.get_start_image(parsed.path[len('/studio/start/image/'):])
                    return self.reply(data, mime=mime)
                except StoreError as error:
                    return self.start_error(error)
                except OSError:
                    return self.start_error(StoreError('STORE_IO', 'Homepage input read failed'))

            def do_POST(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_POST()
                parsed = urlsplit(self.path)
                if parsed.path not in ('/studio/start/upload', '/studio/start/create', '/studio/start/confirm'):
                    return super().do_POST()
                try:
                    if parsed.query:
                        raise StoreError('INVALID_INPUT', 'Homepage writes accept no query parameters')
                    if parsed.path == '/studio/start/create':
                        return self.reply(runtime.create_start_job(self.read_comparison_payload()))
                    if parsed.path == '/studio/start/confirm':
                        return self.reply(runtime.confirm_start_job(self.read_comparison_payload()))
                    lengths = self.headers.get_all('Content-Length', [])
                    names = self.headers.get_all('X-File-Name', [])
                    content_types = self.headers.get_all('Content-Type', [])
                    if (self.headers.get('Transfer-Encoding') or len(lengths) != 1
                        or not lengths[0].isdigit() or len(names) != 1 or len(content_types) != 1):
                        raise ValueError('Invalid upload framing')
                    length = int(lengths[0])
                    if length > MAX_UPLOAD_BYTES:
                        raise StoreError('ASSET_TOO_LARGE', 'Upload exceeds limit')
                    if length < 1:
                        raise StoreError('INVALID_ASSET', 'Empty image')
                    # Consume a bounded framed upload before returning a
                    # validation error. Closing with unread bytes can reset the
                    # connection on Windows and hide the useful error response.
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise ValueError('Incomplete image')
                    mime = self.headers.get_content_type()
                    if mime not in IMAGE_FORMATS.values():
                        raise StoreError('INVALID_ASSET', 'Unsupported MIME type')
                    encoded_name = names[0]
                    if len(encoded_name) > 3060 or re.search(r'%(?![0-9a-fA-F]{2})', encoded_name):
                        raise ValueError('Invalid encoded filename')
                    name = unquote_to_bytes(encoded_name).decode('utf-8')
                    return self.reply({'asset': runtime.stage_start_image(raw, mime, name)})
                except (ValueError, UnicodeError, RecursionError):
                    self.close_connection = True
                    return self.reply({'code': 'INVALID_INPUT', 'error': '请求格式不正确，请检查文件或重新提交。'}, 400)
                except StoreError as error:
                    self.close_connection = True
                    return self.start_error(error)
                except OSError:
                    self.close_connection = True
                    return self.start_error(StoreError('STORE_IO', 'Homepage input write failed'))

        self.server.RequestHandlerClass = HomeStartHandler

    @staticmethod
    def _request_id(value):
        if not isinstance(value, str) or not REQUEST_ID.fullmatch(value):
            raise StoreError('INVALID_INPUT', 'Invalid homepage request ID')
        return value

    @staticmethod
    def _asset_metadata(value):
        return (isinstance(value, dict) and set(value) == ASSET_FIELDS
            and _digest(value['sha256']) and _text(value['name'], 255) and bool(value['name'])
            and not any(ord(character) < 32 for character in value['name'])
            and isinstance(value['mime'], str) and value['mime'] in IMAGE_FORMATS.values()
            and value['uploadName'] == HomeStartRuntime._upload_name(value['name'], value['sha256'], value['mime'])
            and _integer(value['size'], 1, MAX_UPLOAD_BYTES)
            and _integer(value['width'], 1, MAX_IMAGE_PIXELS)
            and _integer(value['height'], 1, MAX_IMAGE_PIXELS)
            and value['width'] * value['height'] <= MAX_IMAGE_PIXELS)

    @staticmethod
    def _upload_name(name, digest, mime):
        stem = (name.rsplit('.', 1)[0] if '.' in name else name)[:50] or '图片'
        extension = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}.get(mime, 'invalid')
        return stem + ' · ' + digest[:16] + '.' + extension

    @staticmethod
    def _decode_image(data, mime):
        if not isinstance(data, bytes) or not data or mime not in IMAGE_FORMATS.values():
            raise StoreError('INVALID_ASSET', 'Unsupported or empty image')
        if len(data) > MAX_UPLOAD_BYTES:
            raise StoreError('ASSET_TOO_LARGE', 'Upload exceeds limit')
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as image:
                    if IMAGE_FORMATS.get(image.format) != mime:
                        raise StoreError('INVALID_ASSET', 'Image format does not match MIME')
                    width, height = image.size
                    if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                        raise StoreError('IMAGE_TOO_LARGE', 'Decoded image exceeds pixel limit')
                    image.verify()
                with Image.open(io.BytesIO(data)) as image:
                    # Force decoding pixels: valid headers alone are insufficient.
                    image.load()
            return width, height
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
            raise StoreError('IMAGE_TOO_LARGE', 'Decoded image exceeds pixel limit') from error
        except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as error:
            raise StoreError('INVALID_ASSET', 'Image cannot be decoded') from error

    def stage_start_image(self, data, mime, name):
        if (not _text(name, 255) or not name or any(ord(character) < 32 for character in name)):
            raise StoreError('INVALID_INPUT', 'Invalid image display name')
        name = name.replace('\\', '/').rsplit('/', 1)[-1]
        if not name:
            raise StoreError('INVALID_INPUT', 'Empty image display name')
        width, height = self._decode_image(data, mime)
        asset = self.store.put_asset(data, mime, name)
        value = {'sha256': asset['sha256'], 'name': name, 'mime': mime,
            'uploadName': self._upload_name(name, asset['sha256'], mime),
            'width': width, 'height': height, 'size': len(data)}
        with self.store._locked():
            path = self.store._path(self.start_assets_dir, asset['sha256'] + '.json')
            if path.exists():
                return self._read_staged_asset(asset['sha256'])
            self.store._write_json(path, value)
            return value

    def _read_staged_asset(self, digest):
        if not _digest(digest):
            raise StoreError('INVALID_ASSET_ID', 'Invalid staged image digest')
        value = self.store._read_json(self.store._path(self.start_assets_dir, digest + '.json'), 4096)
        if not self._asset_metadata(value) or value['sha256'] != digest:
            raise StoreError('CORRUPT_DATA', 'Invalid staged image metadata')
        data, mime = self._asset_bytes(digest)
        if value['mime'] != mime or value['size'] != len(data):
            raise StoreError('CORRUPT_DATA', 'Staged image does not match asset storage')
        return value

    def get_start_image(self, digest):
        with self.store._locked():
            self._read_staged_asset(digest)
            return self._asset_bytes(digest)

    def _validate_start_payload(self, payload):
        if (not isinstance(payload, dict) or set(payload) != {'requestId', 'brief', 'assets'}
            or not _text(payload['brief'], 6000) or not isinstance(payload['assets'], list)
            or len(payload['assets']) > 4 or any(not _digest(item) for item in payload['assets'])
            or len({item[:16] for item in payload['assets']}) != len(payload['assets'])):
            raise StoreError('INVALID_INPUT', 'Invalid homepage creation request')
        self._request_id(payload['requestId'])

    def _read_start_manifest(self, request_id):
        value = self.store._read_json(self.store._path(self.start_jobs_dir, request_id + '.json'), MAX_BODY_BYTES)
        try:
            valid = (set(value) == MANIFEST_FIELDS and value['schema'] == 1
                and value['requestId'] == request_id and value['projectId'] == 'home-' + request_id
                and _text(value['brief'], 6000) and isinstance(value['assets'], list)
                and len(value['assets']) <= 4 and all(self._asset_metadata(item) for item in value['assets'])
                and len({item['sha256'][:16] for item in value['assets']}) == len(value['assets'])
                and _integer(value['createdAt'], 0, 10**16)
                and value['creationStatus'] in ('pending', 'ready')
                and isinstance(value['receipts'], list) and len(value['receipts']) <= len(value['assets'])
                and all(isinstance(row, dict) and set(row) == {'sha256', 'assetSha256', 'shapeId'}
                    and row['sha256'] in {asset['sha256'] for asset in value['assets']}
                    and _digest(row['assetSha256']) and _shape_id(row['shapeId']) for row in value['receipts'])
                and len({row['sha256'] for row in value['receipts']}) == len(value['receipts']))
            project, context = value['initialProject'], value['initialContext']
            valid = (valid and isinstance(project, dict) and isinstance(context, dict)
                and project['projectId'] == value['projectId'] and project['canvas'] == ''
                and project['createdAt'] == value['createdAt'] and project['updatedAt'] == value['createdAt']
                and isinstance(project['version'], str) and bool(project['version'])
                and context == {'projectId': value['projectId'], 'brief': value['brief'], 'notes': '',
                    'revision': 1, 'updatedAt': value['createdAt']})
            self.store._metadata(project, creating=True)
        except (KeyError, TypeError, StoreError):
            valid = False
        if not valid:
            raise StoreError('CORRUPT_DATA', 'Invalid homepage creation manifest')
        return value

    def _complete_start_locked(self, manifest):
        project_id = manifest['projectId']
        self._assert_writable_locked(project_id)
        for asset in manifest['assets']:
            if self._read_staged_asset(asset['sha256']) != asset:
                raise StoreError('CORRUPT_DATA', 'Staged image metadata changed')
        project_path = self.store._path(self.store.projects_dir, project_id + '.json')
        context_path = self.store._path(self.context_dir, project_id + '.json')
        # Preserve a context edited after a partial creation; the original brief
        # also remains in the manifest, so retries can never silently discard it.
        if context_path.exists():
            self._read_context(project_id)
        else:
            self.store._write_json(context_path, manifest['initialContext'])
        if project_path.exists():
            project = self.store._read_project(project_id)
            if project['createdAt'] != manifest['createdAt']:
                raise StoreError('PROJECT_EXISTS', 'Project identity was replaced')
        else:
            self.store._write_json(project_path, manifest['initialProject'])
        completed = {**manifest, 'creationStatus': 'ready'}
        self.store._write_json(self.store._path(self.start_jobs_dir, manifest['requestId'] + '.json'), completed)
        return completed

    def create_start_job(self, payload):
        self._validate_start_payload(payload)
        request_id = payload['requestId']
        project_id = 'home-' + request_id
        with self.store._locked():
            manifest_path = self.store._path(self.start_jobs_dir, request_id + '.json')
            if manifest_path.exists():
                manifest = self._read_start_manifest(request_id)
                if (manifest['brief'] != payload['brief']
                    or [asset['sha256'] for asset in manifest['assets']] != payload['assets']):
                    raise StoreError('REQUEST_CONFLICT', 'Request ID belongs to different inputs')
                self._assert_writable_locked(project_id)
            else:
                self._assert_writable_locked(project_id)
                if (self.store._path(self.store.projects_dir, project_id + '.json').exists()
                    or self.store._path(self.context_dir, project_id + '.json').exists()):
                    raise StoreError('PROJECT_EXISTS', 'Project exists without homepage manifest')
                assets = [self._read_staged_asset(digest) for digest in payload['assets']]
                now = time.time_ns() // 1000000
                words = ' '.join(''.join(character for character in payload['brief'] if ord(character) >= 32).split())
                name = words[:40] or (assets[0]['name'][:40] if assets else '未命名项目')
                project = {**self.store._metadata({'projectName': name}, creating=True),
                    'projectId': project_id, 'canvas': '', 'version': 'local-' + uuid.uuid4().hex,
                    'createdAt': now, 'updatedAt': now, 'validProjectId': True, 'isTitleChanged': False}
                context = {'projectId': project_id, 'brief': payload['brief'], 'notes': '',
                    'revision': 1, 'updatedAt': now}
                manifest = {'schema': 1, 'requestId': request_id, 'projectId': project_id,
                    'brief': payload['brief'], 'assets': assets, 'createdAt': now, 'creationStatus': 'pending',
                    'initialProject': project, 'initialContext': context, 'receipts': []}
                # This atomic, durable intent is always written before either
                # project or context, including the exact original input.
                self.store._write_json(manifest_path, manifest)
            if manifest['creationStatus'] == 'pending':
                manifest = self._complete_start_locked(manifest)
            return self._start_job_locked(manifest)

    def _start_job_locked(self, manifest):
        project_id = manifest['projectId']
        result = {key: manifest[key] for key in ('requestId', 'projectId', 'brief', 'assets', 'createdAt', 'creationStatus')}
        imported = []
        if manifest['creationStatus'] == 'ready':
            # Same saved native document and verified digest membership used by
            # /workflow/assets. No client acknowledgement can mark an import done.
            project = self.store._read_project(project_id)
            if not self.store._path(self.context_dir, project_id + '.json').is_file():
                raise StoreError('CORRUPT_DATA', 'Created project context is missing')
            self._read_context(project_id)
            images = self._images(project)
            valid_images = []
            for image in images.values():
                if image['assetSha256'] is not None and not self._association_issue(image, images, scope='asset'):
                    valid_images.append(image)
            for asset in manifest['assets']:
                exact = [image for image in valid_images if image['assetSha256'] == asset['sha256']]
                by_name = [image for image in valid_images if image['name'] == asset['uploadName'].rsplit('.', 1)[0]]
                matches = exact if exact else by_name
                # Ambiguous names cannot prove which transformed upload landed.
                # Raw digest membership is already definitive; pick one shape.
                if exact or len(matches) == 1:
                    image = sorted(matches, key=lambda row: row['shapeId'])[0]
                    imported.append({'sha256': asset['sha256'], 'assetSha256': image['assetSha256'],
                        'shapeId': image['shapeId']})
            duplicate_shapes = {row['shapeId'] for row in imported
                if sum(other['shapeId'] == row['shapeId'] for other in imported) > 1}
            imported = [row for row in imported if row['shapeId'] not in duplicate_shapes]
        # Confirmed receipts describe a completed one-time handoff. Subsequent
        # deliberate removal/renaming in the editor must never re-import it.
        imported_by_digest = {row['sha256']: row for row in imported}
        imported_by_digest.update({row['sha256']: row for row in manifest['receipts']})
        imported = list(imported_by_digest.values())
        completed = set(imported_by_digest)
        digests = [asset['sha256'] for asset in manifest['assets']]
        result['completedAssets'] = [digest for digest in digests if digest in completed]
        result['importedAssets'] = imported
        result['confirmedAssets'] = [row['sha256'] for row in manifest['receipts']]
        result['pendingAssets'] = [digest for digest in digests if digest not in completed]
        result['status'] = 'complete' if manifest['creationStatus'] == 'ready' and not result['pendingAssets'] else 'pending'
        result['archived'] = self._read_archive(project_id)['archivedAt'] is not None
        return result

    def confirm_start_job(self, payload):
        if not isinstance(payload, dict) or set(payload) != {'projectId'}:
            raise StoreError('INVALID_INPUT', 'Confirmation only accepts projectId')
        project_id = self.store._project_id(payload['projectId'])
        if not project_id.startswith('home-'):
            raise StoreError('NOT_FOUND', 'Project has no homepage input task')
        request_id = self._request_id(project_id[5:])
        with self.store._locked():
            self._assert_writable_locked(project_id)
            manifest = self._read_start_manifest(request_id)
            if manifest['creationStatus'] != 'ready':
                raise StoreError('INVALID_INPUT', 'Creation must finish before confirmation')
            current = self._start_job_locked(manifest)
            receipts = sorted(current['importedAssets'], key=lambda row: row['sha256'])
            if receipts != manifest['receipts']:
                manifest = {**manifest, 'receipts': receipts}
                self.store._write_json(self.store._path(self.start_jobs_dir, request_id + '.json'), manifest)
            return self._start_job_locked(manifest)

    def get_start_job(self, *, requestId=None, projectId=None):
        if (requestId is None) == (projectId is None):
            raise StoreError('INVALID_INPUT', 'Exactly one lookup key is required')
        if projectId is not None:
            self.store._project_id(projectId)
            if not projectId.startswith('home-'):
                raise StoreError('NOT_FOUND', 'Project has no homepage input task')
            requestId = projectId[5:]
        self._request_id(requestId)
        with self.store._locked():
            return self._start_job_locked(self._read_start_manifest(requestId))
