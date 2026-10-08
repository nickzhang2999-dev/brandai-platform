"""Opt-in M15 visual shell around preserved M14 feedback and native editing."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from m14_runtime import M14Runtime


ASSET_PATHS = ('/m15-studio.css', '/m15-studio.js', '/m15-canvas.css')
CANVAS_STYLE_TAG = b'<link rel="stylesheet" href="/m15-canvas.css">'
ORIGINAL_HTML_TAG = b'<html lang="zh-CN">'
VISUAL_HTML_TAG = b'<html lang="zh-CN" data-nv-visual="m15">'


class M15Runtime(M14Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class VisualFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                visual_canvas = (parsed.path in ('/canvas', '/canvas/')
                    and query.get('ui') == ['novart'] and query.get('studio') == ['1']
                    and query.get('inputGuard') == ['m10'] and query.get('canvasTools') == ['m12']
                    and query.get('motion') == ['m13'] and query.get('feedback') == ['m14']
                    and query.get('visual') == ['m15'])
                if (visual_canvas and status == 200 and mime.startswith('text/html')
                    and isinstance(data, bytes)):
                    if (data.count(ORIGINAL_HTML_TAG) != 1 or data.count(b'</body>') != 1
                        or b'data-nv-visual=' in data or b'/m15-canvas.css' in data):
                        return super().reply({'error': 'M15 视觉入口校验失败，请检查本机资源。'}, 503)
                    data = data.replace(ORIGINAL_HTML_TAG, VISUAL_HTML_TAG, 1)
                    # Older handlers append their feedback/motion assets after
                    # this link. The visual stylesheet uses the explicit html
                    # attribute scope; no old asset or native script is changed.
                    data = data.replace(b'</body>', CANVAS_STYLE_TAG + b'</body>', 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m15-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_PATHS:
                    return self.serve_ui(path[1:], 'text/css; charset=utf-8' if path.endswith('.css')
                        else 'application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = VisualFrontendHandler
