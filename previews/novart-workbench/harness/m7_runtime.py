"""Optional motion assets around the preserved M6 comparison runtime.

Only successful comparison HTML responses receive an extra stylesheet/script.
The original canvas entry and all inherited API, storage and network behaviour
stay with M6Runtime. No native editor state or document mutation is added here.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from m6_runtime import M6Runtime


class M7Runtime(M6Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class MotionHandler(base_handler):
            def reply(self, data, status=200, mime='application/json; charset=utf-8'):
                parsed = urlsplit(self.path)
                comparison = parsed.path in ('/compare', '/compare/') or (
                    parsed.path in ('/canvas', '/canvas/')
                    and parse_qs(parsed.query).get('ui') == ['novart'])
                if (comparison and status == 200 and mime.startswith('text/html')
                    and isinstance(data, bytes)):
                    additions = (b'<link rel="stylesheet" href="/m7-motion.css">'
                        b'<script defer src="/m7-motion.js"></script>')
                    data = data.replace(b'</head>', additions + b'</head>', 1)
                return super().reply(data, status, mime)

            def do_GET(self):
                if not self.path.startswith(('http://', 'https://')):
                    path = urlsplit(self.path).path
                    if path in ('/m7-motion.css', '/m7-motion.js'):
                        return self.serve_ui(path[1:], 'text/css; charset=utf-8' if path.endswith('.css')
                            else 'application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = MotionHandler
