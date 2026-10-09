"""Real loopback HTTP checks for private, memory-only editor startup diagnostics."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
from pathlib import Path
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1] / 'previews' / 'novart-workbench'
sys.path.insert(0, str(PACKAGE / 'harness'))
from share_runtime import ShareRuntime

ORIGIN = 'https://review.example.test'
ALIAS = 'https://review-alias.example.test'
PATH = '/review/startup-diagnostics'


def state(**changes):
    return dict(kind='state', role='canvas', controlled=True, canvas=False, toolbar=False,
        boundary=False, width=1280, height=720, **changes)


class StartupDiagnosticHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sharing = (PACKAGE / 'sharing').resolve()
        sharing.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='startup-diagnostic-check-', dir=sharing)
        cls.data = Path(temporary.name).resolve()
        if cls.data.parent != sharing or not cls.data.name.startswith('startup-diagnostic-check-'):
            raise AssertionError('Test directory escaped isolated sharing root')
        cls.addClassCleanup(temporary.cleanup)
        cls.runtime = ShareRuntime(cls.data, public_origin=ORIGIN, additional_origins=json.dumps([ALIAS])).start()
        cls.addClassCleanup(cls.runtime.close)

    def setUp(self):
        with self.runtime.startup_diagnostics_lock:
            self.runtime.startup_diagnostics.clear()

    def request(self, method='GET', payload=None, *, origin=ORIGIN, authenticated=True,
                body=None, declared_length=None, extra=(), content_type='application/json', path=PATH):
        body = json.dumps(payload).encode() if payload is not None else body or b''
        connection = http.client.HTTPConnection('127.0.0.1', self.runtime.server.server_port, timeout=10)
        try:
            connection.putrequest(method, path, skip_host=True)
            connection.putheader('Host', 'preview-internal:8769')
            connection.putheader('Content-Type', content_type)
            connection.putheader('Content-Length', str(declared_length if declared_length is not None else len(body)))
            if authenticated:
                connection.putheader('Cookie', 'novart_review=' + self.runtime.key)
            if origin is not None:
                connection.putheader('Origin', origin)
            for name, value in extra:
                connection.putheader(name, value)
            connection.endheaders(body)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_requires_capability_for_reads_and_writes(self):
        for method in ('GET', 'POST'):
            with self.subTest(method=method):
                self.assertEqual(self.request(method, authenticated=False)[0], 401)
        self.assertEqual(self.request()[1], {'events': []})

    def test_post_origin_guard_precedes_body_and_rejects_spoofing(self):
        for origin in ('https://evil.test', 'null', ORIGIN + '/path', ALIAS + '.evil.test'):
            with self.subTest(origin=origin):
                self.assertEqual(self.request('POST', origin=origin,
                    extra=[('X-Forwarded-Host', 'review.example.test')])[0], 403)
        self.assertEqual(self.request('POST', extra=[('Origin', ORIGIN)])[0], 403)
        self.assertEqual(self.request()[1], {'events': []})

    def test_valid_snapshot_and_error_are_accepted_without_disk_writes(self):
        files_before = {str(p.relative_to(self.data)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in self.data.rglob('*') if p.is_file()}
        snapshot = state(stage='opened', embedded=True, framePath='/canvas')
        self.assertEqual(self.request('POST', snapshot), (202, {'ok': True}))
        failure = {**snapshot, 'kind': 'error', 'stage': 'error', 'boundary': True,
            'errorName': 'ChunkLoadError', 'frames': ['1773.fe2335a6.js:1:231', 'lib-tldraw.e6518aa1.js:4:51'],
            'resource': 'missing-chunk.js'}
        self.assertEqual(self.request('POST', failure, origin=ALIAS), (202, {'ok': True}))
        status, result = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(len(result['events']), 2)
        for event, expected in zip(result['events'], (snapshot, failure)):
            self.assertIsInstance(event['timestamp'], float)
            self.assertGreater(event['timestamp'], 0)
            self.assertEqual({key: value for key, value in event.items() if key != 'timestamp'}, expected)
        self.assertEqual(files_before, {str(p.relative_to(self.data)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in self.data.rglob('*') if p.is_file()})

    def test_over_limit_rejected_before_reading_body(self):
        self.assertEqual(self.request('POST', declared_length=4097)[0], 413)
        body = json.dumps(state()).encode().ljust(4096, b' ')
        self.assertEqual(self.request('POST', body=body), (202, {'ok': True}))

    def test_unknown_fields_and_sensitive_fields_rejected(self):
        for field in ('message', 'stack', 'projectId', 'document', 'image', 'userText', 'timestamp', 'unknown'):
            with self.subTest(field=field):
                self.assertEqual(self.request('POST', {**state(), field: 'must-not-be-stored'})[0], 400)
        self.assertEqual(self.request()[1], {'events': []})

    def test_invalid_enums_flags_and_dimensions_rejected(self):
        bad = [('kind', 'other'), ('role', 'worker'), ('stage', 'loading'), ('errorName', 'SecretError'),
            ('errorName', []), ('controlled', 1), ('canvas', 'true'), ('toolbar', None), ('boundary', {}),
            ('embedded', 0), ('framePath', '/canvas?projectId=private'), ('framePath', 'https://review.test/canvas'),
            ('width', -1), ('width', True), ('width', 10001), ('height', float('nan')),
            ('height', float('inf')), ('height', '720')]
        for key, value in bad:
            with self.subTest(key=key, value=value):
                self.assertEqual(self.request('POST', {**state(), key: value})[0], 400)
        self.assertEqual(self.request()[1], {'events': []})

    def test_only_bounded_basename_resources_and_frames_are_accepted(self):
        resources = ['https://secret.test/a.js', '/a.js', 'a.js?token=secret', 'a.js#secret',
            '../a.js', 'a\\b.js', 'a.png', 'a' * 118 + '.js', '中文.js', 'a.js\n']
        for resource in resources:
            with self.subTest(resource=resource):
                self.assertEqual(self.request('POST', {**state(), 'resource': resource})[0], 400)
        frames = [['https://secret.test/a.js:1:2'], ['/a.js:1:2'], ['a.js?token=secret:1:2'],
            ['a.js:1:2\n'], ['a' * 114 + '.js:1:2'], ['a.js:1:2'] * 5, 'a.js:1:2', [None]]
        for value in frames:
            with self.subTest(frames=value):
                self.assertEqual(self.request('POST', {**state(), 'frames': value})[0], 400)
        self.assertEqual(self.request('POST', {**state(), 'resource': 'native.123.css', 'frames': []})[0], 202)

    def test_malformed_missing_duplicate_and_non_json_bodies_rejected(self):
        for body in (b'', b'{', b'[]', b'null', b'{}', b'{"kind":"state","kind":"error"}', b'\xff'):
            with self.subTest(body=body):
                self.assertEqual(self.request('POST', body=body)[0], 400)
        missing = state(); del missing['canvas']
        self.assertEqual(self.request('POST', missing)[0], 400)
        self.assertEqual(self.request('POST', content_type='text/plain')[0], 400)
        self.assertEqual(self.request('POST', extra=[('Content-Length', '0')])[0], 400)
        self.assertEqual(self.request('POST', extra=[('Transfer-Encoding', 'chunked')])[0], 400)
        self.assertEqual(self.request('PUT')[0], 405)
        self.assertEqual(self.request(path=PATH + '?projectId=private')[0], 400)

    def test_memory_queue_is_bounded_and_thread_safe(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.request('POST', {**state(), 'width': i}), range(64)))
        self.assertTrue(all(result == (202, {'ok': True}) for result in results))
        events = self.request()[1]['events']
        self.assertEqual(len(events), 32)
        self.assertEqual(len({event['width'] for event in events}), 32)


if __name__ == '__main__':
    unittest.main(verbosity=2)
