"""Independent automatic-chat-transition fix over the frozen M26 editor."""
from urllib.parse import parse_qs, urlsplit
from local_runtime import ROOT
from m26_runtime import M26Runtime, FLOATING_PARAMETERS
from m27_layout_patch import build_layout, manifest

FOCUS_PARAMETERS = {**FLOATING_PARAMETERS, 'focusUi': 'm27'}

class M27Runtime(M26Runtime):
    def __init__(self, data_dir, port=0):
        source = (ROOT / 'harness/m21-canvas.js').read_bytes()
        layout = build_layout(source)
        layout_manifest = manifest(source)
        super().__init__(data_dir, port)
        self.m27_layout = layout
        self.m27_manifest = layout_manifest
        base_handler = self.server.RequestHandlerClass
        class FocusLayoutHandler(base_handler):
            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                if parsed.path in ('/canvas', '/canvas/'):
                    query = parse_qs(parsed.query, keep_blank_values=True)
                    if not all(query.get(key) == [value] for key, value in FOCUS_PARAMETERS.items()):
                        return self.reply({'error': '焦点适配入口校验失败，请从本机工作台重新打开。'}, 503)
                if parsed.path in ('/studio', '/studio/'):
                    return self.serve_ui('m27-studio.html', 'text/html; charset=utf-8')
                if parsed.path == '/m27-studio.js':
                    return self.serve_ui('m27-studio.js', 'application/javascript; charset=utf-8')
                if parsed.path == '/m21-canvas.js':
                    return self.reply(layout, mime='application/javascript; charset=utf-8')
                return super().do_GET()
        self.server.RequestHandlerClass = FocusLayoutHandler
