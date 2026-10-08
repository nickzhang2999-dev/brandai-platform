"""M10 studio shell and opt-in early keyboard guard around the preserved M9."""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from m9_runtime import M9Runtime


class M10Runtime(M9Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class KeyboardFrontendHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query, keep_blank_values=True)
                guarded_canvas = (parsed.path in ('/canvas', '/canvas/')
                    and query.get('ui') == ['novart'] and query.get('studio') == ['1']
                    and query.get('inputGuard') == ['m10'])
                if (guarded_canvas and status == 200 and mime.startswith('text/html')
                    and isinstance(data, bytes)):
                    # A synchronous head script registers before the captured
                    # native scripts in body and before deferred sidecar UI.
                    data = data.replace(b'</head>',
                        b'<script src="/m10-input-guard.js"></script></head>', 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m10-studio.html', 'text/html; charset=utf-8')
                if path in ('/m10-studio.css', '/m10-studio.js', '/m10-input-guard.js'):
                    return self.serve_ui(path[1:], 'text/css; charset=utf-8' if path.endswith('.css')
                        else 'application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = KeyboardFrontendHandler
