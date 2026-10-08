"""Opt-in M21 window layout; original status and native canvas stay inherited."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from m20_runtime import M20Runtime, STATUS_PARAMETERS


ASSET_MIMES = {
    '/m21-studio.css': 'text/css; charset=utf-8',
    '/m21-studio.js': 'application/javascript; charset=utf-8',
    '/m21-canvas.css': 'text/css; charset=utf-8',
    '/m21-canvas.js': 'application/javascript; charset=utf-8',
}
LAYOUT_PARAMETERS = {**STATUS_PARAMETERS, 'layoutUi': 'm21'}
CANVAS_LAYOUT_TAGS = (b'<link rel="stylesheet" href="/m21-canvas.css">'
    b'<script defer src="/m21-canvas.js"></script>')


class M21Runtime(M20Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class WindowLayoutFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                layout_canvas = (parsed.path in ('/canvas', '/canvas/')
                    and all(query.get(key) == [value] for key, value in LAYOUT_PARAMETERS.items()))
                if layout_canvas and status == 200 and mime.startswith('text/html') and isinstance(data, bytes):
                    if (data.count(b'</body>') != 1 or b'/m21-canvas.css' in data or b'/m21-canvas.js' in data):
                        return super().reply({'error': 'M21 窗口适配入口校验失败，请检查本机资源。'}, 503)
                    # Inherited M20 status tags follow this addition. The layout
                    # script installs on DOMContentLoaded and observes status
                    # aria changes; it does not replace M20's receipt observer.
                    data = data.replace(b'</body>', CANVAS_LAYOUT_TAGS + b'</body>', 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m21-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_MIMES:
                    return self.serve_ui(path[1:], ASSET_MIMES[path])
                return super().do_GET()

        self.server.RequestHandlerClass = WindowLayoutFrontendHandler
