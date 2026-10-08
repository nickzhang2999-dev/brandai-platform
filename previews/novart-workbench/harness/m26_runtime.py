"""Independent native attachment layout over the frozen M25 editor runtime."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from local_runtime import ROOT
from m25_runtime import IMAGE_PARAMETERS, M25Runtime
from m26_native_patch import build_native_chunk, patch_manifest


FLOATING_PARAMETERS = {**IMAGE_PARAMETERS, 'floatingUi': 'm26'}


class M26Runtime(M25Runtime):
    def __init__(self, data_dir, port=0):
        # Reject changed captured input before opening any project data.
        original = (ROOT / 'originals/static/js/1773.fe2335a6.js').read_bytes()
        controls = (ROOT / 'originals/static/js/283.c3fbcbc3.js').read_bytes()
        native = build_native_chunk(original, controls)
        manifest = patch_manifest(original, controls)
        super().__init__(data_dir, port)
        self.m12_native_chunk = native
        self.m26_native_manifest = manifest
        base_handler = self.server.RequestHandlerClass

        class FloatingLayoutHandler(base_handler):
            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                if parsed.path in ('/canvas', '/canvas/'):
                    query = parse_qs(parsed.query, keep_blank_values=True)
                    if not all(query.get(key) == [value] for key, value in FLOATING_PARAMETERS.items()):
                        return self.reply({'error': '工具栏适配入口校验失败，请从本机工作台重新打开。'}, 503)
                if parsed.path in ('/studio', '/studio/'):
                    return self.serve_ui('m26-studio.html', 'text/html; charset=utf-8')
                if parsed.path == '/m26-studio.js':
                    return self.serve_ui('m26-studio.js', 'application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = FloatingLayoutHandler
