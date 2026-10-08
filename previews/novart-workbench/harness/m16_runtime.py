"""Opt-in M16 brand shell while preserving M15 and older canvas entry points."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from m15_runtime import M15Runtime


ASSET_MIMES = {
    '/m16-studio.css': 'text/css; charset=utf-8',
    '/m16-studio.js': 'application/javascript; charset=utf-8',
    '/m16-canvas.css': 'text/css; charset=utf-8',
    '/m16-logo.png': 'image/png',
}
CANVAS_STYLE_TAG = b'<link rel="stylesheet" href="/m16-canvas.css">'
ORIGINAL_HTML_TAG = b'<html lang="zh-CN">'
VISUAL_HTML_TAG = b'<html lang="zh-CN" data-nv-visual="m16">'


class M16Runtime(M15Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class BrandFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                brand_canvas = (parsed.path in ('/canvas', '/canvas/')
                    and query.get('ui') == ['novart'] and query.get('studio') == ['1']
                    and query.get('inputGuard') == ['m10'] and query.get('canvasTools') == ['m12']
                    and query.get('motion') == ['m13'] and query.get('feedback') == ['m14']
                    and query.get('visual') == ['m16'])
                if (brand_canvas and status == 200 and mime.startswith('text/html')
                    and isinstance(data, bytes)):
                    if (data.count(ORIGINAL_HTML_TAG) != 1 or data.count(b'</body>') != 1
                        or b'data-nv-visual=' in data or b'/m16-canvas.css' in data):
                        return super().reply({'error': 'M16 品牌入口校验失败，请检查本机资源。'}, 503)
                    data = data.replace(ORIGINAL_HTML_TAG, VISUAL_HTML_TAG, 1)
                    # M15's own gate does not match visual=m16. Its valid m15
                    # requests still pass through unchanged; older feedback and
                    # motion assets remain in their inherited loading order.
                    data = data.replace(b'</body>', CANVAS_STYLE_TAG + b'</body>', 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m16-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_MIMES:
                    return self.serve_ui(path[1:], ASSET_MIMES[path])
                return super().do_GET()

        self.server.RequestHandlerClass = BrandFrontendHandler
