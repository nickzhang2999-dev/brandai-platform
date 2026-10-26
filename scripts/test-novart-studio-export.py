"""Exercise the owned shell exporter without browser, backend or provider access."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / '.novart-build'
spec = importlib.util.spec_from_file_location('owned_studio_export', ROOT / 'scripts/export-novart-studio.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class OwnedStudioExportTests(unittest.TestCase):
    def setUp(self):
        BUILD.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='studio-export-test-', dir=BUILD)
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / 'studio'

    def export(self):
        exporter.export_studio(self.output)
        return json.loads((self.output / 'manifest.json').read_text(encoding='utf-8'))

    def test_manifest_contains_only_self_contained_owned_assets_with_checked_hashes(self):
        manifest = self.export()
        self.assertEqual(manifest['format'], 'novart-studio-assets-v1')
        self.assertEqual(manifest['external'], {})
        self.assertIn('/studio.html', manifest['files'])
        self.assertIn('/novart-product-bootstrap.js', manifest['files'])
        self.assertIn('/home-start-attachments.js', manifest['files'])
        self.assertNotIn('/canvas.html', manifest['files'])
        self.assertNotIn('/novart-product-worker.js', manifest['files'])
        actual = {p.relative_to(self.output).as_posix() for p in self.output.rglob('*') if p.is_file()}
        self.assertEqual(actual, {'manifest.json'} | {entry['file'] for entry in manifest['files'].values()})
        for route, entry in manifest['files'].items():
            self.assertTrue(route.startswith('/'))
            self.assertNotRegex(route, r'originals|m12-native|lib-tldraw|canvas\.html')
            content = (self.output / entry['file']).read_bytes()
            self.assertEqual(entry['bytes'], len(content), route)
            self.assertEqual(entry['sha256'], hashlib.sha256(content).hexdigest(), route)
            self.assertNotRegex(content.lower(), rb'lovart|lib-tldraw|webpackchunk|__novart_tldraw_license_key')
            if entry['mime'].startswith('text/html') or 'css' in entry['mime']:
                for reference in re.findall(rb'(?:src|href)=["\'](/[^"\'?#]+)', content):
                    self.assertIn(reference.decode('utf-8'), manifest['files'], route)
                for reference in re.findall(rb'url\(["\']?(/[^)"\'?#]+)', content):
                    self.assertIn(reference.decode('utf-8'), manifest['files'], route)

    def test_reexport_removes_old_captured_files_and_is_deterministic(self):
        first = self.export()
        stale = ['canvas.html', 'originals/static/js/legacy.js', 'm12-native/legacy.js', 'unexpected-cache.txt']
        for name in stale:
            target = self.output / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('synthetic stale build artifact', encoding='utf-8')
        second = self.export()
        self.assertEqual(first, second)
        for name in stale:
            self.assertFalse((self.output / name).exists(), name)

    def test_export_rejects_build_root_and_paths_outside_build_without_mutation(self):
        sentinel = Path(self.temporary.name) / 'preserve.txt'
        sentinel.write_text('keep', encoding='utf-8')
        for output in (BUILD, ROOT / 'apps', ROOT):
            with self.subTest(output=output.name), self.assertRaises((ValueError, RuntimeError)):
                exporter.export_studio(output)
        self.assertEqual(sentinel.read_text(encoding='utf-8'), 'keep')

    def test_export_versions_the_real_style_chain_and_scripts_without_changing_sources(self):
        paths = [exporter.SHELL / name for name in exporter.SHELL_FILES]
        paths += [ROOT / 'deploy/novart/studio' / name for name in exporter.PRODUCT_FILES.values()]
        before = {path: path.read_bytes() for path in paths}
        manifest = self.export()
        page = (self.output / 'studio.html').read_text(encoding='utf-8')
        for name in ('m24-studio.css', 'home-start-studio.css', 'home-start-attachments.js', 'responsive-layout.js'):
            digest = manifest['files']['/' + name]['sha256']
            self.assertIn('/' + name + '?novart_sha256=' + digest, page)
        for parent, child in (('m24-studio.css', 'm21-studio.css'), ('m21-studio.css', 'm18-studio.css'),
                              ('m9-studio.css', 'm8-studio.css')):
            self.assertIn('/' + child + '?novart_sha256=' + manifest['files']['/' + child]['sha256'],
                          (self.output / parent).read_text(encoding='utf-8'))
        self.assertEqual(before, {path: path.read_bytes() for path in paths})

    def test_leaf_change_updates_every_parent_version_and_only_the_affected_chain(self):
        source = {
            'studio.html': b'<link rel="stylesheet" href="/entry.css"><script src="/app.js"></script>',
            'entry.css': b'@import /* local sheet */ "./nested/leaf.css"; .logo { background: url(/logo.svg#mark) }',
            'nested/leaf.css': b'.mode { display: flex; }',
            'logo.svg': b'<svg></svg>',
            'app.js': b'window.owned = true;',
        }
        before = dict(source)
        first = exporter._version_assets(source)
        leaf_digest = hashlib.sha256(first['nested/leaf.css']).hexdigest()
        self.assertIn(('./nested/leaf.css?novart_sha256=' + leaf_digest).encode(), first['entry.css'])
        entry_digest = hashlib.sha256(first['entry.css']).hexdigest()
        self.assertIn(('/entry.css?novart_sha256=' + entry_digest).encode(), first['studio.html'])
        self.assertEqual(source, before)
        self.assertEqual(first, exporter._version_assets(source))
        self.assertEqual(first, exporter._version_assets(first))
        changed = dict(source, **{'nested/leaf.css': b'.mode { display: grid; }'})
        second = exporter._version_assets(changed)
        for name in ('nested/leaf.css', 'entry.css', 'studio.html'):
            self.assertNotEqual(first[name], second[name], name)
        for name in ('logo.svg', 'app.js'):
            self.assertEqual(first[name], second[name], name)

    def test_versions_preserve_query_fragment_html_entities_and_relative_paths(self):
        source = {
            'studio.html': b'<link REL="alternate stylesheet" href="./entry.css?theme=dark&amp;v=old#layer">'
                           b'<script src=/app.js?debug=1></script><link rel="icon" href="/logo.svg">',
            'entry.css': b'@import url("leaf.css?theme=dark&v=old#layer") screen;'
                         b'.logo { background: url(/logo.svg?color=%23fff#mark) }',
            'leaf.css': b'.mode { display: flex; }',
            'logo.svg': b'<svg></svg>',
            'app.js': b'window.owned = true;',
        }
        result = exporter._version_assets(source)
        digest = hashlib.sha256(result['entry.css']).hexdigest()
        self.assertIn(('./entry.css?theme=dark&amp;v=old&amp;novart_sha256=' + digest + '#layer').encode(), result['studio.html'])
        self.assertIn(b'src=/app.js?debug=1&amp;novart_sha256=', result['studio.html'])
        self.assertIn(b'<link rel="icon" href="/logo.svg">', result['studio.html'])
        css = result['entry.css'].decode()
        imported = re.search(r'url\("([^"]+)"\)', css).group(1)
        self.assertEqual(urlsplit(imported).path, 'leaf.css')
        self.assertEqual(urlsplit(imported).fragment, 'layer')
        self.assertEqual(parse_qs(urlsplit(imported).query), {
            'theme': ['dark'], 'v': ['old'],
            'novart_sha256': [hashlib.sha256(result['leaf.css']).hexdigest()],
        })
        self.assertIn(b'/logo.svg?color=%23fff&novart_sha256=', result['entry.css'])
        self.assertIn(b'#mark)', result['entry.css'])

    def test_ignores_external_unlisted_navigation_and_literal_references(self):
        source = {
            'studio.html': b'<!-- <link rel="stylesheet" href="/leaf.css"> -->'
                           b'<script>const example = \'<link rel="stylesheet" href="/leaf.css">\';</script>'
                           b'<link rel="stylesheet" href="https://cdn.example/leaf.css">'
                           b'<script src="//cdn.example/app.js"></script>'
                           b'<script src="/api/runtime"></script><a href="/leaf.css">Read CSS</a>'
                           b'<link rel="stylesheet" href="/missing.css">',
            'entry.css': b'/* @import "/leaf.css"; url(/logo.svg) */'
                         b'.example::after { content: "url(/logo.svg)"; }'
                         b'@import "https://cdn.example/leaf.css";'
                         b'.a { background: url(//cdn.example/logo.svg) }'
                         b'.b { background: url(data:image/svg+xml;base64,PHN2Zz4=) }'
                         b'.c { background: url(/api/image) }'
                         b'.d { background: url(/studio.html) }'
                         b'.e { background: url(#mask) }'
                         b'.f { --example: noturl(/logo.svg) }',
            'leaf.css': b'.mode { display: flex; }',
            'logo.svg': b'<svg></svg>',
        }
        self.assertEqual(exporter._version_assets(source), source)

    def test_cycle_is_rejected_before_removing_the_previous_build(self):
        fixture = Path(self.temporary.name) / 'source'
        fixture.mkdir()
        sources = {'studio.html': '<link rel="stylesheet" href="/entry.css">',
                   'entry.css': '@import "/leaf.css";', 'leaf.css': '@import "/entry.css";'}
        for name, content in sources.items():
            (fixture / name).write_text(content, encoding='utf-8')
        self.output.mkdir()
        sentinel = self.output / 'previous-valid-build.txt'
        sentinel.write_text('preserve', encoding='utf-8')
        with patch.object(exporter, 'SHELL', fixture), patch.object(exporter, 'SHELL_FILES', tuple(sources)), \
                patch.object(exporter, 'PRODUCT_FILES', {}):
            with self.assertRaisesRegex(RuntimeError, 'Circular shell asset dependency: .*entry.css -> leaf.css -> entry.css'):
                self.export()
        self.assertEqual(sentinel.read_text(encoding='utf-8'), 'preserve')
        for name, content in sources.items():
            self.assertEqual((fixture / name).read_text(encoding='utf-8'), content)


if __name__ == '__main__':
    unittest.main(verbosity=2)
