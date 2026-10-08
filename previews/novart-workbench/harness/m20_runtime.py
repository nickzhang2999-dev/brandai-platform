"""Opt-in M20 local status wording; older canvas and native bytes stay inherited."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from m19_runtime import M19Runtime


ASSET_MIMES = {
    '/m20-studio.js': 'application/javascript; charset=utf-8',
    '/m20-comparison.js': 'application/javascript; charset=utf-8',
    '/m20-canvas.js': 'application/javascript; charset=utf-8',
    '/m20-canvas.css': 'text/css; charset=utf-8',
}
STATUS_PARAMETERS = {
    'ui': 'novart', 'studio': '1', 'inputGuard': 'm10', 'canvasTools': 'm12',
    'motion': 'm13', 'feedback': 'm14', 'visual': 'm16', 'statusUi': 'm20',
}
ORIGINAL_COMPARISON_TAG = b'<script defer src="/comparison.js"></script>'
STATUS_COMPARISON_TAG = b'<script defer src="/m20-comparison.js"></script>'
CANVAS_STATUS_TAGS = (b'<link rel="stylesheet" href="/m20-canvas.css">'
    b'<script defer src="/m20-canvas.js"></script>')


class M20Runtime(M19Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class SaveStatusFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                status_canvas = (parsed.path in ('/canvas', '/canvas/')
                    and all(query.get(key) == [value] for key, value in STATUS_PARAMETERS.items()))
                if status_canvas and status == 200 and mime.startswith('text/html') and isinstance(data, bytes):
                    if (data.count(ORIGINAL_COMPARISON_TAG) != 1 or data.count(b'</body>') != 1
                        or any(path.encode() in data for path in ('/m20-comparison.js', '/m20-canvas.css', '/m20-canvas.js'))):
                        return super().reply({'error': 'M20 保存提示入口校验失败，请检查本机资源。'}, 503)
                    data = data.replace(ORIGINAL_COMPARISON_TAG, STATUS_COMPARISON_TAG, 1)
                    # Inherited reply layers append their own styles/scripts
                    # after these tags. M20 canvas JS installs on DOMContentLoaded,
                    # after M14's initial receipt observer has been registered.
                    data = data.replace(b'</body>', CANVAS_STATUS_TAGS + b'</body>', 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m20-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_MIMES:
                    return self.serve_ui(path[1:], ASSET_MIMES[path])
                return super().do_GET()

        self.server.RequestHandlerClass = SaveStatusFrontendHandler
