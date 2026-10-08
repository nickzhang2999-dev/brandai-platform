"""Isolated image gesture fixes over the frozen M24 local project runtime.

This runtime owns its derived native chunk cache. Earlier runtimes and captured
bundles are untouched; canvas, assets and drafts keep the inherited formats.
The M12 chunk route is retained because the unchanged bootstrap loads it, but
only the complete M25 canvas entry may reach that bootstrap on this server.
"""
from __future__ import annotations

import hashlib
from urllib.parse import parse_qs, urlsplit

from local_runtime import ROOT
from m24_runtime import DRAFT_PARAMETERS, M24Runtime
from m25_native_patch import build_native_chunk, patch_manifest


IMAGE_PARAMETERS = {**DRAFT_PARAMETERS, 'imageHistory': 'm25'}
BRIDGE_SOURCE_SHA256 = '194dc859e0307989fbca108da34f583938fb4bfdc4201746dbcba40ebb7b1cfa'
BRIDGE_ANCHOR = b'renderFields.filter(key => Object.hasOwn(shape.props,key))'
BRIDGE_REPLACEMENT = b'renderFields.filter(key => Object.hasOwn(shape.props,key) && shape.props[key] !== undefined)'


def build_draft_bridge(original):
    """Match the native JSON serializer's omission of own undefined values.

    Explicit null, false and zero remain in the exact renderer context. The
    frozen M24 source and server-side fingerprints are never changed.
    """
    if not isinstance(original, bytes):
        raise TypeError('Expected the exact frozen M24 bridge bytes')
    if hashlib.sha256(original).hexdigest() != BRIDGE_SOURCE_SHA256 or original.count(BRIDGE_ANCHOR) != 1:
        raise ValueError('Frozen M24 bridge or unique render-context anchor changed')
    derived = original.replace(BRIDGE_ANCHOR, BRIDGE_REPLACEMENT, 1)
    if derived.count(BRIDGE_REPLACEMENT) != 1 or derived.replace(BRIDGE_REPLACEMENT, BRIDGE_ANCHOR, 1) != original:
        raise ValueError('M25 render-context bridge inverse check failed')
    return derived


def bridge_manifest(original):
    derived = build_draft_bridge(original)
    return {'sourceSha256': BRIDGE_SOURCE_SHA256,
        'derivedSha256': hashlib.sha256(derived).hexdigest(),
        'sourceBytes': len(original), 'derivedBytes': len(derived),
        'anchors': [{'count': 1, 'byteOffset': original.index(BRIDGE_ANCHOR),
            'anchorSha256': hashlib.sha256(BRIDGE_ANCHOR).hexdigest(),
            'replacementSha256': hashlib.sha256(BRIDGE_REPLACEMENT).hexdigest()}],
        'inverseToSourceExact': True, 'undefinedOnly': True,
        'serverContextModified': False, 'nativeDocumentModified': False}


class M25Runtime(M24Runtime):
    def __init__(self, data_dir, port=0):
        # Verify source and every unique anchor before opening the data store.
        original = (ROOT / 'originals/static/js/1773.fe2335a6.js').read_bytes()
        controls = (ROOT / 'originals/static/js/283.c3fbcbc3.js').read_bytes()
        native = build_native_chunk(original, controls)
        manifest = patch_manifest(original, controls)
        bridge_source = (ROOT / 'harness/m24-canvas.js').read_bytes()
        bridge = build_draft_bridge(bridge_source)
        bridge_info = bridge_manifest(bridge_source)
        super().__init__(data_dir, port)
        self.m12_native_chunk = native
        self.m25_native_manifest = manifest
        self.m25_canvas_bridge = bridge
        self.m25_bridge_manifest = bridge_info
        runtime = self
        base_handler = self.server.RequestHandlerClass

        class ImageHistoryHandler(base_handler):
            def do_GET(self):
                if self.path.startswith(('http://', 'https://')):
                    return super().do_GET()
                parsed = urlsplit(self.path)
                if parsed.path in ('/canvas', '/canvas/'):
                    query = parse_qs(parsed.query, keep_blank_values=True)
                    if not all(query.get(key) == [value] for key, value in IMAGE_PARAMETERS.items()):
                        return self.reply({'error': '图片编辑入口校验失败，请从本机工作台重新打开。'}, 503)
                if parsed.path in ('/studio', '/studio/'):
                    return self.serve_ui('m25-studio.html', 'text/html; charset=utf-8')
                if parsed.path == '/m25-studio.js':
                    return self.serve_ui('m25-studio.js', 'application/javascript; charset=utf-8')
                if parsed.path == '/m24-canvas.js':
                    return self.reply(runtime.m25_canvas_bridge, 200, 'application/javascript; charset=utf-8')
                return super().do_GET()

        self.server.RequestHandlerClass = ImageHistoryHandler
