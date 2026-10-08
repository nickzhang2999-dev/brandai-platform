"""Isolated M12 studio and derived chunks around the preserved M11 runtime.

New canvas entry tags and byte caches are independent of the M11 endpoints.
Native stores, upload adapters, clipboard permissions and schemas stay inherited.
"""
from __future__ import annotations

import hashlib
from urllib.parse import parse_qs, urlsplit

from local_runtime import ROOT
from m11_runtime import M11Runtime
from m12_native_patch import (NativePatchError, ORIGINAL_CHUNK_SHA256,
    ORIGINAL_EDITOR_CHUNK_SHA256, build_editor_chunk, build_native_chunk)


INDEX_SHA256 = 'f3433da4e4716e42eacc3442b3efd928b9a8e86fe8daaeddb1d2d8bb45eef764'
RUNTIME_TAG = b'<script src="/originals/static/js/runtime.dc1a2d6c.js"></script>'
EDITOR_PATH = '/m12-native/lib-tldraw.e6518aa1.js'
EDITOR_TAG = ('<script src="' + EDITOR_PATH + '"></script>').encode('ascii')
NATIVE_PATH = '/m12-native/1773.fe2335a6.js'
NATIVE_TAG = ('<script src="' + NATIVE_PATH + '"></script>').encode('ascii')


def _prepare_m12_chunks():
    """Validate both native inputs and builders before any store or server opens."""
    try:
        index = (ROOT / 'harness/index.html').read_bytes()
        original = (ROOT / 'originals/static/js/1773.fe2335a6.js').read_bytes()
        editor_original = (ROOT / 'originals/static/js/lib-tldraw.e6518aa1.js').read_bytes()
    except OSError as error:
        raise RuntimeError('M12 cannot start: captured native sources are unavailable') from error
    if hashlib.sha256(index).hexdigest() != INDEX_SHA256:
        raise RuntimeError('M12 cannot start: captured bootstrap hash mismatch')
    if index.count(RUNTIME_TAG) != 1:
        raise RuntimeError('M12 cannot start: native runtime anchor must occur exactly once')
    if hashlib.sha256(original).hexdigest() != ORIGINAL_CHUNK_SHA256:
        raise RuntimeError('M12 cannot start: captured chunk 1773 hash mismatch')
    if hashlib.sha256(editor_original).hexdigest() != ORIGINAL_EDITOR_CHUNK_SHA256:
        raise RuntimeError('M12 cannot start: captured editor library hash mismatch')
    try:
        native = build_native_chunk(original)
        editor = build_editor_chunk(editor_original)
    except NativePatchError as error:
        raise RuntimeError('M12 cannot start: derived native patch validation failed') from error
    for name, derived, captured in (('native', native, original), ('editor', editor, editor_original)):
        if not isinstance(derived, bytes) or not derived or derived == captured:
            raise RuntimeError('M12 cannot start: derived ' + name + ' chunk was not produced')
    return native, editor


class M12Runtime(M11Runtime):
    def __init__(self, data_dir, port=0):
        self.m12_native_chunk, self.m12_editor_chunk = _prepare_m12_chunks()
        super().__init__(data_dir, port)
        runtime = self
        base_handler = self.server.RequestHandlerClass

        class ImageToolsFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                tools_canvas = (parsed.path in ('/canvas', '/canvas/')
                    and query.get('ui') == ['novart'] and query.get('studio') == ['1']
                    and query.get('inputGuard') == ['m10'] and query.get('canvasTools') == ['m12'])
                if (tools_canvas and status == 200 and mime.startswith('text/html')
                    and isinstance(data, bytes)):
                    if data.count(RUNTIME_TAG) != 1 or EDITOR_TAG in data or NATIVE_TAG in data:
                        return super().reply({'error': 'M12 图片工具入口校验失败，请停止并检查本机资源。'}, 503)
                    data = data.replace(RUNTIME_TAG, RUNTIME_TAG + EDITOR_TAG + NATIVE_TAG, 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m12-studio.html', 'text/html; charset=utf-8')
                if path in ('/m12-studio.css', '/m12-studio.js'):
                    return self.serve_ui(path[1:], 'text/css; charset=utf-8' if path.endswith('.css')
                        else 'application/javascript; charset=utf-8')
                if path == NATIVE_PATH:
                    return self.reply(runtime.m12_native_chunk, mime='application/javascript; charset=utf-8')
                if path == EDITOR_PATH:
                    return self.reply(runtime.m12_editor_chunk, mime='application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = ImageToolsFrontendHandler
