"""Exercise the owned shell exporter without browser, backend or provider access."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

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


if __name__ == '__main__':
    unittest.main(verbosity=2)
