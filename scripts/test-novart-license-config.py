"""Test owned public-license wiring without keys, paid services or shared data."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

PACKAGE = Path(__file__).resolve().parents[1] / 'previews' / 'novart-workbench'
sys.path.insert(0, str(PACKAGE / 'harness'))

import native_license_config as license_config
from home_start_runtime import HomeStartRuntime
from m26_native_patch import build_native_chunk
from rc3_native_patch import build_native
from rc3_runtime import RC3_PARAMETERS
from share_runtime import ShareRuntime


def owned_temporary(test):
    sharing = (PACKAGE / 'sharing').resolve()
    sharing.mkdir(exist_ok=True)
    # The CLI deliberately accepts only alphanumeric/hyphen room names, while
    # tempfile can generate underscores. Keep its collision-safe allocation.
    for _ in range(20):
        temporary = tempfile.TemporaryDirectory(prefix='license-config-test-', dir=sharing)
        directory = Path(temporary.name).resolve()
        if directory.parent != sharing or not directory.name.startswith('license-config-test-'):
            raise AssertionError('Test directory escaped isolated sharing root')
        if directory.name.replace('-', '').isalnum():
            test.addCleanup(temporary.cleanup)
            return directory
        temporary.cleanup()
    raise RuntimeError('Could not allocate an isolated CLI-compatible test room')


def request(port, path, capability=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
    try:
        headers = {'Cookie': 'novart_review=' + capability} if capability else {}
        connection.request('GET', path, headers=headers)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def config_script(document):
    matches = re.findall(rb'<script data-novart-license-config>(.*?)</script>', document)
    if len(matches) != 1:
        raise AssertionError('Expected exactly one native license configuration')
    return matches[0]


class NativeLicensePatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = PACKAGE / 'originals/static/js'
        cls.original = (directory / '1773.fe2335a6.js').read_bytes()
        cls.native = build_native(build_native_chunk(cls.original, (directory / '283.c3fbcbc3.js').read_bytes()))

    def test_only_owned_getter_changes_and_original_is_preserved(self):
        for source, builder in ((self.native, license_config.build_native_license_chunk),
                (self.original, license_config.build_original_license_chunk)):
            derived = builder(source)
            self.assertEqual(derived.count(license_config.REPLACEMENT), 1)
            self.assertEqual(derived.count(license_config.ANCHOR), 0)
            self.assertTrue(derived.replace(license_config.REPLACEMENT, license_config.ANCHOR, 1) == source)
        self.assertEqual(hashlib.sha256((PACKAGE / 'originals/static/js/1773.fe2335a6.js').read_bytes()).hexdigest(),
            license_config.ORIGINAL_SHA256)

    def test_unknown_drift_and_wrong_chain_stage_are_rejected(self):
        for builder, source, wrong in ((license_config.build_native_license_chunk, self.native, self.original),
                (license_config.build_original_license_chunk, self.original, self.native)):
            for value in (b'changed' + source, source + license_config.ANCHOR, wrong, builder(source)):
                with self.assertRaisesRegex(ValueError, '^Native license source or unique getter anchor changed$'):
                    builder(value)
            with self.assertRaises(TypeError):
                builder('not-bytes')

    def test_runtime_getter_has_no_captured_or_browser_storage_fallback(self):
        # Execute the exact derived getter rather than reimplementing its logic.
        derived = license_config.build_native_license_chunk(self.native)
        replacement = derived[derived.index(license_config.REPLACEMENT):][:len(license_config.REPLACEMENT)]
        expression = replacement.split(b'{$y:()=>', 1)[1].split(b',DE:', 1)[0].decode('ascii')
        program = r'''
const vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const bad = () => { throw Error('Browser-controlled license input was consulted'); };
const base = () => ({r:'captured-fixture', location:{search:'?licenseKey=attacker'},
  localStorage:{getItem:bad}, sessionStorage:{getItem:bad}, process:{env:{NOVART_TLDRAW_LICENSE_KEY:'attacker'}}});
let context=vm.createContext(base());
if(vm.runInContext(input.expression,context)!=='') throw Error('Missing key used a fallback');
context.__NOVART_TLDRAW_LICENSE_KEY=42;
if(vm.runInContext(input.expression,context)!=='') throw Error('Invalid key used a fallback');
context=vm.createContext(base());
vm.runInContext(input.script,context);
if(vm.runInContext(input.expression,context)!==input.expected) throw Error('Explicit configuration was lost');
vm.runInContext('__NOVART_TLDRAW_LICENSE_KEY="attacker"',context);
if(vm.runInContext(input.expression,context)!==input.expected) throw Error('Configuration was mutable');
const descriptor=Object.getOwnPropertyDescriptor(context,'__NOVART_TLDRAW_LICENSE_KEY');
if(descriptor.writable || descriptor.configurable || descriptor.enumerable) throw Error('Wrong descriptor');
'''
        self.run_node(program, {'expression': expression, 'expected': 'owned-test-fixture',
            'script': license_config.build_license_script('owned-test-fixture').decode('ascii')})

    def run_node(self, program, values):
        result = subprocess.run(['node', '-e', program], input=json.dumps(values).encode('utf-8'),
            capture_output=True, timeout=10)
        self.assertTrue(result.returncode == 0, 'License JavaScript contract failed (output intentionally omitted)')

    def test_inline_serialization_is_safe_and_round_trips_exactly(self):
        fixture = '"\\</script><script>throw 1</script>&中文\u2028\u2029'
        script = license_config.build_license_script(fixture)
        self.assertNotIn(b'<', script)
        self.assertNotIn(b'>', script)
        self.assertNotIn(b'&', script)
        program = r'''
const vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0,'utf8'));
const context=vm.createContext({}); vm.runInContext(input.script,context);
if(context.__NOVART_TLDRAW_LICENSE_KEY!==input.expected) throw Error('Serialization changed input');
'''
        self.run_node(program, {'script': script.decode('ascii'), 'expected': fixture})

    def test_missing_configuration_is_explicit_empty_string(self):
        self.assertEqual(license_config.validate_license_key(None), '')
        self.assertEqual(license_config.build_license_script(None), license_config.build_license_script(''))

    def test_invalid_configuration_is_rejected_without_value_in_error(self):
        values = [False, 123, [], {}, b'bytes', 'x' * (license_config.MAX_LICENSE_KEY_LENGTH + 1)]
        values += ['private-fixture-' + chr(value) for value in (*range(32), *range(127, 160))]
        for value in values:
            with self.assertRaises(ValueError) as captured:
                license_config.validate_license_key(value)
            self.assertEqual(str(captured.exception), 'Invalid Novart tldraw license configuration')
        self.assertEqual(len(license_config.validate_license_key('x' * license_config.MAX_LICENSE_KEY_LENGTH)),
            license_config.MAX_LICENSE_KEY_LENGTH)

    def test_html_installs_once_before_native_scripts_and_rejects_drift(self):
        source = b'<html><head><script src="native.js"></script></head><body></body></html>'
        script = license_config.build_license_script('test-fixture')
        derived = license_config.inject_license_script(source, script)
        self.assertLess(derived.index(license_config.SCRIPT_MARKER), derived.index(b'native.js'))
        self.assertEqual(config_script(derived), script)
        for value in (derived, b'<html></html>', source + b'<head>'):
            with self.assertRaises(ValueError):
                license_config.inject_license_script(value, script)


class LicenseRuntimeTests(unittest.TestCase):
    def test_invalid_configuration_has_no_storage_side_effects(self):
        directory = owned_temporary(self)
        for runtime in (HomeStartRuntime, ShareRuntime):
            destination = directory / runtime.__name__
            with self.assertRaises(ValueError):
                runtime(destination, tldraw_license_key='private-fixture\n')
            self.assertFalse(destination.exists())

    def test_native_source_drift_stops_before_storage(self):
        directory = owned_temporary(self) / 'drift'
        with patch('home_start_runtime.build_native_license_chunk', side_effect=ValueError('Source drift')):
            with self.assertRaises(ValueError):
                HomeStartRuntime(directory)
        self.assertFalse(directory.exists())

    def test_authenticated_config_precedes_native_and_preserves_projects(self):
        directory = owned_temporary(self)
        fixture = 'owned-review-fixture'
        runtime = ShareRuntime(directory / 'configured', tldraw_license_key=fixture).start()
        self.addCleanup(runtime.close)
        project = runtime.inner.store.create_project({'projectName': 'License configuration regression'})
        before = runtime.inner.store.get_project(project['projectId'])
        query = {'projectId': project['projectId'], 'v': '1', **RC3_PARAMETERS,
            'licenseKey': 'browser-cannot-configure-license'}
        path = '/canvas?' + urlencode(query)
        status, headers, document = request(runtime.server.server_port, path, runtime.key)
        self.assertEqual(status, 200)
        self.assertEqual(config_script(document), license_config.build_license_script(fixture))
        self.assertLess(document.index(license_config.SCRIPT_MARKER), document.index(b'/m12-native/1773.'))
        self.assertIn("script-src 'self'", headers['Content-Security-Policy'])
        self.assertEqual(headers['Cache-Control'], 'no-store')
        for resource in ('/m12-native/1773.fe2335a6.js', '/originals/static/js/1773.fe2335a6.js',
                '/share-resource?' + urlencode({'url': 'https://web-static3.lovart.ai/lovart_canvas_online/static/js/1773.fe2335a6.js'})):
            status, _, content = request(runtime.server.server_port, resource, runtime.key)
            self.assertEqual(status, 200)
            self.assertTrue(content.count(license_config.REPLACEMENT) == 1)
            self.assertTrue(license_config.ANCHOR not in content)
            # SDK keys configure HTML, never alter the cached derivative bytes.
            self.assertTrue(fixture.encode() not in content)
            status, _, _ = request(runtime.server.server_port, resource)
            self.assertNotEqual(status, 200)
        status, _, document = request(runtime.server.server_port, path)
        self.assertNotEqual(status, 200)
        self.assertNotIn(license_config.SCRIPT_MARKER, document)
        self.assertEqual(runtime.inner.store.get_project(project['projectId']), before)

    def test_omitted_parameter_does_not_implicitly_read_environment(self):
        directory = owned_temporary(self)
        with patch.dict(os.environ, {'NOVART_TLDRAW_LICENSE_KEY': 'ambient-fixture'}):
            runtime = ShareRuntime(directory / 'empty').start()
        self.addCleanup(runtime.close)
        path = '/canvas?' + urlencode({'v': '1', **RC3_PARAMETERS})
        status, _, document = request(runtime.server.server_port, path, runtime.key)
        self.assertEqual(status, 200)
        self.assertEqual(config_script(document), license_config.build_license_script(None))

    def test_cli_passes_environment_explicitly_without_logging_it(self):
        directory = owned_temporary(self)
        fixture = 'owned-cli-test-fixture'
        environment = {**os.environ, 'NOVART_TLDRAW_LICENSE_KEY': fixture}
        environment.pop('NOVART_REVIEW_PUBLIC_ORIGIN', None)
        environment.pop('NOVART_REVIEW_ADDITIONAL_ORIGINS', None)
        process = subprocess.Popen([sys.executable, str(PACKAGE / 'harness/share_runtime.py'),
            '--room', directory.name, '--port', '0'], env=environment,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 15
            runtime_file = directory / 'runtime.json'
            while not runtime_file.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(runtime_file.is_file(), 'CLI did not become ready')
            info = json.loads(runtime_file.read_text(encoding='utf-8'))
            path = '/canvas?' + urlencode({'v': '1', **RC3_PARAMETERS})
            status, _, document = request(info['port'], path, info['entryPath'].removeprefix('/share/'))
            self.assertEqual(status, 200)
            self.assertEqual(config_script(document), license_config.build_license_script(fixture))
        finally:
            process.terminate()
            stdout, stderr = process.communicate(timeout=10)
        self.assertNotIn(fixture.encode(), stdout + stderr)

    def test_cli_invalid_environment_fails_before_room_creation_and_redacts_value(self):
        directory = owned_temporary(self)
        room = directory.name + '-invalid'
        fixture = 'invalid-private-fixture\n'
        environment = {**os.environ, 'NOVART_TLDRAW_LICENSE_KEY': fixture}
        result = subprocess.run([sys.executable, str(PACKAGE / 'harness/share_runtime.py'),
            '--room', room, '--port', '0'], env=environment, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Invalid Novart tldraw license configuration', result.stderr)
        self.assertNotIn(b'invalid-private-fixture', result.stdout + result.stderr)
        self.assertFalse((PACKAGE / 'sharing' / room).exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
