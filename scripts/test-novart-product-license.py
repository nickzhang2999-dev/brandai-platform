"""Static product export checks. No server, browser, database or real license.

Assertions never include native source bytes: captured bundles contain a vendor
license that must not appear in test output. Passing is not a licensed deployment.
"""
from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import sys
import unittest

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


if __name__ == '__main__':
    unittest.main()
