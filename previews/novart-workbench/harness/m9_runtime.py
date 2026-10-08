"""Optional M9 frontend shell with all M8 storage and canvas contracts retained."""
from __future__ import annotations

from urllib.parse import urlsplit

from m8_runtime import M8Runtime


class M9Runtime(M8Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class FrontendHandler(base_handler):
            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m9-studio.html', 'text/html; charset=utf-8')
                if path in ('/m9-studio.css', '/m9-studio.js'):
                    return self.serve_ui(path[1:], 'text/css; charset=utf-8' if path.endswith('.css')
                        else 'application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = FrontendHandler
