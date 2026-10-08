"""Opt-in M13 motion shell around the unchanged M12 canvas and storage."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from m12_runtime import M12Runtime


CANVAS_STYLE_TAG = b'<link rel="stylesheet" href="/m13-canvas.css">'
ASSET_PATHS = ('/m13-studio.css', '/m13-studio.js', '/m13-motion.css', '/m13-canvas.css')


class M13Runtime(M12Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class MotionFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                motion_canvas = (parsed.path in ('/canvas', '/canvas/')
                    and query.get('ui') == ['novart'] and query.get('studio') == ['1']
                    and query.get('inputGuard') == ['m10'] and query.get('canvasTools') == ['m12']
                    and query.get('motion') == ['m13'])
                if (motion_canvas and status == 200 and mime.startswith('text/html')
                    and isinstance(data, bytes)):
                    if data.count(b'</body>') != 1 or CANVAS_STYLE_TAG in data:
                        return super().reply({'error': 'M13 交互一致入口校验失败，请检查本机资源。'}, 503)
                    # Inherited handlers append their UI styles to head. Keeping
                    # this final stylesheet in body preserves cascade order
                    # without rewriting any captured or earlier-version asset.
                    data = data.replace(b'</body>', CANVAS_STYLE_TAG + b'</body>', 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m13-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_PATHS:
                    return self.serve_ui(path[1:], 'text/css; charset=utf-8' if path.endswith('.css')
                        else 'application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = MotionFrontendHandler
