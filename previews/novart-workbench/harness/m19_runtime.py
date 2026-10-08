"""M19 navigation fixes shell; styles and native canvas stay inherited."""
from __future__ import annotations

from urllib.parse import urlsplit

from m18_runtime import M18Runtime


ASSET_MIMES = {
    '/m19-studio.js': 'application/javascript; charset=utf-8',
}


class M19Runtime(M18Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class NavigationFrontendHandler(base_handler):
            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m19-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_MIMES:
                    return self.serve_ui(path[1:], ASSET_MIMES[path])
                return super().do_GET()

        self.server.RequestHandlerClass = NavigationFrontendHandler
