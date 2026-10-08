"""M17 project and asset library shell; all canvas behavior stays with M16."""
from __future__ import annotations

from urllib.parse import urlsplit

from m16_runtime import M16Runtime


ASSET_MIMES = {
    '/m17-studio.css': 'text/css; charset=utf-8',
    '/m17-studio.js': 'application/javascript; charset=utf-8',
}


class M17Runtime(M16Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class LibraryFrontendHandler(base_handler):
            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m17-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_MIMES:
                    return self.serve_ui(path[1:], ASSET_MIMES[path])
                return super().do_GET()

        self.server.RequestHandlerClass = LibraryFrontendHandler
