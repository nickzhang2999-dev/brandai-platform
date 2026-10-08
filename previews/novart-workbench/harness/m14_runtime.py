"""M14 feedback shell around the unchanged M13 motion and M12 native canvas."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from m13_runtime import M13Runtime


ASSET_PATHS = ('/m14-studio.css', '/m14-studio.js', '/m14-canvas.css', '/m14-canvas.js')
CANVAS_FEEDBACK_TAGS = (b'<link rel="stylesheet" href="/m14-canvas.css">'
    b'<script defer src="/m14-canvas.js"></script>')


class M14Runtime(M13Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class FeedbackFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                feedback_canvas = (parsed.path in ('/canvas', '/canvas/')
                    and query.get('ui') == ['novart'] and query.get('studio') == ['1']
                    and query.get('inputGuard') == ['m10'] and query.get('canvasTools') == ['m12']
                    and query.get('motion') == ['m13'] and query.get('feedback') == ['m14'])
                if (feedback_canvas and status == 200 and mime.startswith('text/html')
                    and isinstance(data, bytes)):
                    if (data.count(b'</body>') != 1 or b'/m14-canvas.css' in data
                        or b'/m14-canvas.js' in data):
                        return super().reply({'error': 'M14 状态反馈入口校验失败，请检查本机资源。'}, 503)
                    # M13 appends its motion stylesheet after this addition.
                    # Feedback uses its own scoped controls; native resources,
                    # their ordering and the M13 motion rules stay inherited.
                    data = data.replace(b'</body>', CANVAS_FEEDBACK_TAGS + b'</body>', 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m14-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_PATHS:
                    return self.serve_ui(path[1:], 'text/css; charset=utf-8' if path.endswith('.css')
                        else 'application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = FeedbackFrontendHandler
