"""Isolated project-library preview; archive metadata never rewrites editor data.

Only use this runtime with its own data directory. RC3 and earlier runtimes do
not know about the archive sidecars and must not share a live data directory.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import html
import threading
from urllib.parse import parse_qs, urlsplit

from compare_runtime import MAX_REVISION, _error_reply, _integer
from local_store import StoreError
from rc3_runtime import RC3Runtime


ARCHIVE_FIELDS = {'projectId', 'archivedAt', 'archiveRevision'}
ARCHIVE_MESSAGE = '这个项目已归档。请先回到项目库恢复，再继续编辑。'


class ProjectLibraryRuntime(RC3Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        self.archive_dir = self.store.data_dir / 'project-archive'
        try:
            self.store._check_directory(self.archive_dir)
            self.archive_dir.mkdir(exist_ok=True)
        except (StoreError, OSError):
            self.server.server_close()
            raise

        # Mark the project being mutated in this thread. Its existing public
        # save method owns locking/validation; check archive state INSIDE each
        # acquired lock rather than acquiring the same OS file lock twice.
        # This also rechecks context saves which perform two separate reads.
        self._archive_write_scope = threading.local()
        original_lock = self.store._locked
        original_save = self.store.save_project

        @contextmanager
        def archive_checked_lock():
            with original_lock():
                for project_id in getattr(self._archive_write_scope, 'projects', ()):
                    self._assert_writable_locked(project_id)
                yield

        def guarded_native_save(payload):
            with self._project_write(payload):
                return original_save(payload)

        self.store._locked = archive_checked_lock
        self.store.save_project = guarded_native_save
        runtime = self
        base = self.server.RequestHandlerClass

        class ProjectLibraryHandler(base):
            def archive_error(self, error):
                if error.code == 'PROJECT_ARCHIVED':
                    result, status = {'error': ARCHIVE_MESSAGE}, 409
                elif error.code == 'ARCHIVE_CONFLICT':
                    result, status = {'error': '项目归档状态已变化，请刷新项目库后重试。'}, 409
                elif error.code == 'VERSION_CONFLICT':
                    result, status = {'error': '项目内容刚刚有更新，请确认保存完成后重试。'}, 409
                else:
                    result, status = _error_reply(error)
                return self.reply({'code': error.code, **result}, status)

            def compare_error(self, error):
                if error.code == 'PROJECT_ARCHIVED':
                    return self.archive_error(error)
                return super().compare_error(error)

            def draft_error(self, error, *, writing=False):
                if error.code == 'PROJECT_ARCHIVED':
                    return self.archive_error(error)
                return super().draft_error(error, writing=writing)

            def reference_error(self, error):
                if error.code == 'PROJECT_ARCHIVED':
                    return self.archive_error(error)
                return super().reference_error(error)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                if parsed.path in ('/studio', '/studio/'):
                    return self.serve_ui('project-library-studio.html', 'text/html; charset=utf-8')
                if parsed.path in ('/project-library-studio.js', '/project-library-studio.css'):
                    mime = 'application/javascript' if parsed.path.endswith('.js') else 'text/css'
                    return self.serve_ui(parsed.path[1:], mime + '; charset=utf-8')
                try:
                    if parsed.path == '/studio/project-library':
                        if parsed.query:
                            raise StoreError('INVALID_INPUT', 'Project library accepts no query parameters')
                        return self.reply(runtime.get_project_library())
                    if parsed.path in ('/canvas', '/canvas/'):
                        values = parse_qs(parsed.query, keep_blank_values=True).get('projectId')
                        if values is not None:
                            if len(values) != 1:
                                raise StoreError('INVALID_PROJECT_ID', 'Exactly one project ID is required')
                            archive = runtime.get_archive(values[0])
                            if archive['archivedAt'] is not None:
                                # Non-success canvas response also skips the
                                # inherited native-editor HTML injectors.
                                return self.reply(runtime.archived_page(values[0]).encode('utf-8'), 409,
                                    mime='text/html; charset=utf-8')
                except StoreError as error:
                    return self.archive_error(error)
                except OSError:
                    return self.archive_error(StoreError('STORE_IO', 'Project library read failed'))
                return super().do_GET()

            def do_POST(self):
                if self.path.startswith(('http://', 'https://')) or urlsplit(self.path).path != '/studio/project-archive':
                    return super().do_POST()
                try:
                    payload = self.read_comparison_payload()
                except (ValueError, UnicodeError, RecursionError):
                    self.close_connection = True
                    return self.reply({'code': 'INVALID_INPUT', 'error': '归档请求须为有效 JSON 对象。'}, 400)
                try:
                    return self.reply(runtime.save_archive(payload))
                except StoreError as error:
                    return self.archive_error(error)
                except OSError:
                    return self.archive_error(StoreError('STORE_IO', 'Project archive write failed'))

        self.server.RequestHandlerClass = ProjectLibraryHandler

    @contextmanager
    def _project_write(self, payload):
        self.store._payload(payload)
        project_id = self.store._project_id(payload.get('projectId'))
        previous = getattr(self._archive_write_scope, 'projects', ())
        self._archive_write_scope.projects = (*previous, project_id)
        try:
            yield
        finally:
            self._archive_write_scope.projects = previous

    def _assert_writable_locked(self, project_id):
        if self._read_archive(project_id)['archivedAt'] is not None:
            raise StoreError('PROJECT_ARCHIVED', ARCHIVE_MESSAGE)

    def _read_archive(self, project_id):
        path = self.store._path(self.archive_dir, project_id + '.json')
        if not path.exists():
            return {'projectId': project_id, 'archivedAt': None, 'archiveRevision': 0}
        value = self.store._read_json(path, 4096)
        valid = (set(value) == ARCHIVE_FIELDS and value['projectId'] == project_id
            and _integer(value['archiveRevision'], 1, MAX_REVISION))
        timestamp = value.get('archivedAt')
        if timestamp is not None:
            try:
                valid = valid and isinstance(timestamp, str) and len(timestamp) < 64
                parsed = datetime.fromisoformat(timestamp) if valid else None
                valid = valid and parsed.tzinfo is not None and parsed.utcoffset() is not None
            except (ValueError, TypeError):
                valid = False
        if not valid:
            raise StoreError('CORRUPT_DATA', 'Invalid project archive metadata')
        return value

    def get_archive(self, project_id):
        project_id = self.store._project_id(project_id)
        with self.store._locked():
            project = self.store._read_project(project_id)
            return {**self._read_archive(project_id), 'projectVersion': project['version']}

    def get_project_library(self):
        with self.store._locked():
            self.store._check_directory(self.store.projects_dir)
            projects = []
            for path in self.store.projects_dir.glob('*.json'):
                project_id = self.store._project_id(path.stem)
                project = self.store._read_project(project_id)
                projects.append({**{key: value for key, value in project.items() if key != 'canvas'},
                    'hasCanvas': bool(project['canvas']), **self._read_archive(project_id)})
            projects.sort(key=lambda value: (value['updatedAt'], value['projectId']), reverse=True)
            return {'projects': projects}

    def save_archive(self, payload):
        if (not isinstance(payload, dict)
            or set(payload) != {'projectId', 'archived', 'revision', 'projectVersion'}
            or not isinstance(payload['archived'], bool)
            or not _integer(payload['revision'], 0, MAX_REVISION - 1)
            or not isinstance(payload['projectVersion'], str)
            or not 0 < len(payload['projectVersion']) <= 128):
            raise StoreError('INVALID_INPUT', 'Invalid project archive request')
        project_id = self.store._project_id(payload['projectId'])
        with self.store._locked():
            project = self.store._read_project(project_id)
            current = self._read_archive(project_id)
            if project['version'] != payload['projectVersion']:
                raise StoreError('VERSION_CONFLICT', 'Project changed since archive confirmation')
            if current['archiveRevision'] != payload['revision']:
                raise StoreError('ARCHIVE_CONFLICT', 'Project archive state changed since read')
            if (current['archivedAt'] is not None) == payload['archived']:
                return {**current, 'projectVersion': project['version']}
            value = {'projectId': project_id,
                'archivedAt': datetime.now(timezone.utc).isoformat() if payload['archived'] else None,
                'archiveRevision': current['archiveRevision'] + 1}
            self.store._write_json(self.store._path(self.archive_dir, project_id + '.json'), value)
            return {**value, 'projectVersion': project['version']}

    def save_context(self, payload):
        with self._project_write(payload):
            return super().save_context(payload)

    def save_workflow(self, payload):
        with self._project_write(payload):
            return super().save_workflow(payload)

    def save_draft(self, payload):
        with self._project_write(payload):
            return super().save_draft(payload)

    def bind_reference_image(self, payload):
        with self._project_write(payload):
            return super().bind_reference_image(payload)

    def api(self, path, payload, token):
        try:
            return super().api(path, payload, token)
        except StoreError as error:
            if error.code != 'PROJECT_ARCHIVED':
                raise
            return {'code': 100423, 'errorCode': error.code, 'msg': ARCHIVE_MESSAGE, 'data': None}, 409

    def archived_page(self, project_id):
        project = self.store.get_project(project_id)
        name = html.escape(project['projectName'])
        return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>项目已归档</title>
<style>body{margin:0;background:#f7f6f3;color:#292826;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}
main{max-width:520px;margin:15vh auto;padding:40px}h1{font-size:28px}p{color:#696761}
a{display:inline-block;margin-top:16px;padding:10px 18px;border-radius:10px;background:#292826;color:white;text-decoration:none}
a:focus-visible{outline:3px solid #977548;outline-offset:4px}</style>
<main data-project-archived="true"><h1>''' + name + '''</h1><p>这个项目已归档，当前仅供保留。
画布、创作要求、草稿和素材都还在。回到项目库恢复后，就能继续编辑。</p>
<a href="/studio#/workspace/''' + html.escape(project_id, quote=True) + '''" target="_top">回到项目库恢复</a></main></html>'''
