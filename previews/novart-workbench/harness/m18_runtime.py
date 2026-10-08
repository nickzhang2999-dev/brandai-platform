"""M18 brand settings and preferences shell; all canvas behavior stays with M16."""
from __future__ import annotations

from urllib.parse import urlsplit

from m17_runtime import M17Runtime


ASSET_MIMES = {
    '/m18-studio.css': 'text/css; charset=utf-8',
    '/m18-studio.js': 'application/javascript; charset=utf-8',
}


class M18Runtime(M17Runtime):
    def __init__(self, data_dir, port=0):
        super().__init__(data_dir, port)
        base_handler = self.server.RequestHandlerClass

        class PreferencesFrontendHandler(base_handler):
            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                path = urlsplit(self.path).path
                if path in ('/studio', '/studio/'):
                    return self.serve_ui('m18-studio.html', 'text/html; charset=utf-8')
                if path in ASSET_MIMES:
                    return self.serve_ui(path[1:], ASSET_MIMES[path])
                return super().do_GET()

        self.server.RequestHandlerClass = PreferencesFrontendHandler
