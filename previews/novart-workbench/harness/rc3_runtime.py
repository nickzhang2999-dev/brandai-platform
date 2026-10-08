"""RC3 preserves native reference metadata and inherits RC2 bounded read retry."""
from urllib.parse import urlsplit, parse_qs
from local_runtime import ROOT
from rc2_runtime import RC2Runtime, RC2_PARAMETERS
from m26_native_patch import build_native_chunk
from rc3_native_patch import build_native

RC3_PARAMETERS = {**RC2_PARAMETERS, 'referenceData': 'rc3'}


class RC3Runtime(RC2Runtime):
    def __init__(self, data_dir, port=0):
        original = (ROOT / 'originals/static/js/1773.fe2335a6.js').read_bytes()
        controls = (ROOT / 'originals/static/js/283.c3fbcbc3.js').read_bytes()
        native = build_native(build_native_chunk(original, controls))
        super().__init__(data_dir, port)
        self.m12_native_chunk = native
        base = self.server.RequestHandlerClass

        class ReferenceDataHandler(base):
            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                if parsed.path in ('/canvas', '/canvas/'):
                    query = parse_qs(parsed.query, keep_blank_values=True)
                    if not all(query.get(k) == [v] for k, v in RC3_PARAMETERS.items()):
                        return self.reply({'error': '请从图片引用体验版工作台重新打开。'}, 503)
                if parsed.path in ('/studio', '/studio/'):
                    return self.serve_ui('rc3-studio.html', 'text/html; charset=utf-8')
                if parsed.path == '/rc3-studio.js':
                    return self.serve_ui('rc3-studio.js', 'application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = ReferenceDataHandler
