"""RC2 trial runtime: inherited M27 UI, one bounded draft read retry."""
from urllib.parse import urlsplit, parse_qs
from local_runtime import ROOT
from m27_runtime import M27Runtime, FOCUS_PARAMETERS
from m25_runtime import build_draft_bridge
from rc2_draft_patch import build_bridge

RC2_PARAMETERS = {**FOCUS_PARAMETERS, 'draftRead': 'rc2'}


class RC2Runtime(M27Runtime):
    def __init__(self, data_dir, port=0):
        bridge = build_bridge(build_draft_bridge((ROOT / 'harness/m24-canvas.js').read_bytes()))
        super().__init__(data_dir, port)
        self.rc2_bridge = bridge
        base = self.server.RequestHandlerClass

        class RetryHandler(base):
            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                if parsed.path in ('/canvas', '/canvas/'):
                    query = parse_qs(parsed.query, keep_blank_values=True)
                    if not all(query.get(k) == [v] for k, v in RC2_PARAMETERS.items()):
                        return self.reply({'error': '请从本机体验版工作台重新打开。'}, 503)
                if parsed.path in ('/studio', '/studio/'):
                    return self.serve_ui('rc2-studio.html', 'text/html; charset=utf-8')
                if parsed.path == '/rc2-studio.js':
                    return self.serve_ui('rc2-studio.js', 'application/javascript; charset=utf-8')
                if parsed.path == '/m24-canvas.js':
                    return self.reply(bridge, mime='application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = RetryHandler
