"""Product export checks with a disposable loopback server and no real license.

Assertions never include native source bytes: captured bundles contain a vendor
license that must not appear in test output. Passing is not a licensed deployment.
"""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'previews/novart-workbench/harness'))
from native_license_config import ANCHOR, REPLACEMENT, ORIGINAL_SHA256, SOURCE_SHA256
from m26_native_patch import build_native_chunk
from rc3_native_patch import build_native

spec = importlib.util.spec_from_file_location('novart_product_export', ROOT / 'scripts/export-novart-studio.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ProductLicenseExportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_path = ROOT / 'previews/novart-workbench/originals/static/js/1773.fe2335a6.js'
        cls.original = cls.original_path.read_bytes()
        controls = (ROOT / 'previews/novart-workbench/originals/static/js/283.c3fbcbc3.js').read_bytes()
        cls.native = build_native(build_native_chunk(cls.original, controls))

    def test_both_exact_native_aliases_override_only_the_shared_getter(self):
        cases = [('/m12-native/1773.fe2335a6.js', self.native, SOURCE_SHA256),
                 ('/originals/static/js/1773.fe2335a6.js', self.original, ORIGINAL_SHA256)]
        for path, source, expected in cases:
            self.assertEqual(hashlib.sha256(source).hexdigest(), expected)
            derived = exporter.product_license_patch(path, source)
            self.assertEqual(derived.count(REPLACEMENT), 1)
            self.assertEqual(derived.count(ANCHOR), 0)
            self.assertTrue(derived.replace(REPLACEMENT, ANCHOR, 1) == source, 'Only the shared exported getter may change')
        self.assertTrue(self.original_path.read_bytes() == self.original, 'Frozen vendor source must remain untouched')

    def test_rejects_changed_duplicate_wrong_path_and_repeat_input(self):
        path = '/m12-native/1773.fe2335a6.js'
        for source in [self.native + b' ', self.native + ANCHOR, self.original,
                       exporter.product_license_patch(path, self.native)]:
            with self.assertRaises(ValueError):
                exporter.product_license_patch(path, source)
        with self.assertRaises(RuntimeError):
            exporter.product_license_patch('/unknown/1773.fe2335a6.js', self.native)

    def test_export_passes_sdk_validator_through_unchanged(self):
        path = '/originals/static/js/lib-tldraw.e6518aa1.js'
        sdk = (ROOT / 'previews/novart-workbench' / path.lstrip('/')).read_bytes()
        self.assertTrue(exporter.product_license_patch(path, sdk) == sdk, 'The SDK license validator is not an override target')

    def test_product_compiler_receives_unconfigured_assets_from_preview_runtime(self):
        # Exercise the shared HTTP compiler boundary, where a merge could apply
        # the preview getter twice or freeze an empty license before product boot.
        with tempfile.TemporaryDirectory(prefix='novart-export-license-') as directory:
            runtime = exporter.HomeStartRuntime(directory, configure_native_license=False).start()
            try:
                project = runtime.store.create_project({'projectName': 'Export regression'})
                path = '/canvas?' + urlencode({'projectId': project['projectId'], 'v': '1', **exporter.RC3_PARAMETERS})
                with urlopen(runtime.origin + path, timeout=10) as response:
                    document = response.read()
                self.assertTrue(b'data-novart-license-config' not in document,
                    'Product configuration must remain owned by its authenticated bootstrap')
                for path in ('/m12-native/1773.fe2335a6.js', '/originals/static/js/1773.fe2335a6.js'):
                    with urlopen(runtime.origin + path, timeout=10) as response:
                        source = response.read()
                    derived = exporter.product_license_patch(path, source)
                    self.assertEqual(derived.count(REPLACEMENT), 1)
                    self.assertEqual(derived.count(ANCHOR), 0)
            finally:
                runtime.close()


if __name__ == '__main__':
    unittest.main()
