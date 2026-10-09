"""Local HTTP regression checks for the review gateway's Origin boundary.

Uses real runtime handlers and a new disposable directory under sharing/.
No Docker, browser, business providers or existing review rooms are used.
Run: python scripts/test-novart-share-origin.py
"""
from __future__ import annotations

from email.message import Message
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

PACKAGE = Path(__file__).resolve().parents[1] / 'previews' / 'novart-workbench'
sys.path.insert(0, str(PACKAGE / 'harness'))

from share_runtime import ShareRuntime, _parse_additional_origins, _parse_origin, _write_origin_allowed


PUBLIC_ORIGIN = 'https://review.example.test'
ADDITIONAL_ORIGIN = 'https://review-alias.example.test'


class OriginParsingTests(unittest.TestCase):
    def test_normalized_origin_and_default_port(self):
        self.assertEqual(_parse_origin('https://REVIEW.example.test:443'), _parse_origin(PUBLIC_ORIGIN))
        self.assertEqual(_parse_origin('http://localhost:80'), ('http', 'localhost', 80))
        self.assertEqual(_parse_origin('http://[::1]:8769'), ('http', '::1', 8769))

    def test_opaque_malformed_and_multiple_origins_are_invalid(self):
        values = ['', 'null', '*', 'https://*.example.test', 'https://review.example.test/',
                  'https://review.example.test/path', 'https://review.example.test?',
                  'https://review.example.test#', 'https://user@review.example.test',
                  'https://review.example.test:0', 'https://review.example.test:65536',
                  'https://review.example.test:', 'https://review.example.test:wrong',
                  'https://[invalid', 'http://[::1]evil.test', 'http://[::1]evil.test:8769',
                  'file://review.example.test', '//review.example.test',
                  'https://review.example.test,https://evil.test',
                  'https://review.example.test https://evil.test',
                  'https://review.example.test\n', 'https://review.example.test\\@evil.test']
        for value in values:
            with self.subTest(origin=value):
                self.assertIsNone(_parse_origin(value))

    def test_direct_default_ports_are_equivalent(self):
        headers = Message()
        headers['Host'] = 'LOCALHOST:80'
        headers['Origin'] = 'http://localhost'
        self.assertTrue(_write_origin_allowed(headers, None))

    def test_additional_origins_default_empty_and_allow_bounded_explicit_list(self):
        self.assertEqual(_parse_additional_origins(None, None), frozenset())
        self.assertEqual(_parse_additional_origins('[]', None), frozenset())
        values = [f'https://alias-{n}.example.test' for n in range(8)]
        self.assertEqual(_parse_additional_origins(json.dumps(values), _parse_origin(PUBLIC_ORIGIN)),
            frozenset(_parse_origin(value) for value in values))


class ShareOriginHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sharing = (PACKAGE / 'sharing').resolve()
        sharing.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='origin-check-', dir=sharing)
        cls.data = Path(temporary.name).resolve()
        # Check the exact owned path before registering recursive cleanup.
        if cls.data.parent != sharing or not cls.data.name.startswith('origin-check-'):
            raise AssertionError('Test directory escaped isolated sharing root')
        cls.addClassCleanup(temporary.cleanup)
        cls.proxy = ShareRuntime(cls.data / 'proxy', public_origin=PUBLIC_ORIGIN,
            additional_origins=json.dumps([ADDITIONAL_ORIGIN])).start()
        cls.addClassCleanup(cls.proxy.close)
        cls.primary_only = ShareRuntime(cls.data / 'primary-only', public_origin=PUBLIC_ORIGIN).start()
        cls.addClassCleanup(cls.primary_only.close)
        cls.direct = ShareRuntime(cls.data / 'direct').start()
        cls.addClassCleanup(cls.direct.close)

    def request(self, path, payload, *, runtime=None, origin=None, host=None, extra=(), authenticated=True):
        runtime = runtime or self.proxy
        host = host or ('frontend-review:8769' if runtime is self.proxy else f'127.0.0.1:{runtime.server.server_port}')
        # Rejected requests use an empty body: Windows may reset a socket when
        # a server rejects headers before consuming already-sent body bytes.
        body = json.dumps(payload).encode() if payload is not None else b''
        connection = http.client.HTTPConnection('127.0.0.1', runtime.server.server_port, timeout=10)
        try:
            connection.putrequest('POST', path, skip_host=True)
            connection.putheader('Host', host)
            connection.putheader('Content-Type', 'application/json')
            connection.putheader('Content-Length', str(len(body)))
            if authenticated:
                connection.putheader('Cookie', 'novart_review=' + runtime.key)
            if origin is not None:
                connection.putheader('Origin', origin)
            for name, value in extra:
                connection.putheader(name, value)
            connection.endheaders(body)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_real_homepage_create_behind_rewritten_host(self):
        status, result = self.request('/compare/api/create',
            {'projectName': 'Origin regression', 'brief': 'Create from the review homepage'}, origin=PUBLIC_ORIGIN)
        self.assertEqual(status, 200)
        project_id = result['projectId']
        status, reopened = self.request('/api/canva/project/queryProject', {'projectId': project_id},
            origin='https://REVIEW.example.test:443')
        self.assertEqual(status, 200)
        self.assertEqual(reopened['data']['projectName'], 'Origin regression')
        self.assertEqual(self.proxy.inner.store.get_project(project_id)['projectName'], 'Origin regression')

    def test_attachment_creation_uses_the_same_boundary(self):
        payload = {'requestId': str(uuid.uuid4()), 'brief': 'Recoverable origin regression', 'assets': []}
        status, result = self.request('/studio/start/create', payload, origin=PUBLIC_ORIGIN)
        self.assertEqual(status, 200)
        self.assertEqual(result['creationStatus'], 'ready')
        status, retried = self.request('/studio/start/create', payload, origin=PUBLIC_ORIGIN)
        self.assertEqual(status, 200)
        self.assertEqual(retried['projectId'], result['projectId'])

    def test_configured_alias_can_create_and_native_query_from_both_origins(self):
        status, result = self.request('/studio/start/create',
            {'requestId': str(uuid.uuid4()), 'brief': 'Alias origin regression', 'assets': []},
            origin=ADDITIONAL_ORIGIN)
        self.assertEqual(status, 200)
        self.assertEqual(result['creationStatus'], 'ready')
        project_id = result['projectId']
        for origin in [PUBLIC_ORIGIN, ADDITIONAL_ORIGIN, 'https://REVIEW-ALIAS.example.test:443']:
            with self.subTest(origin=origin):
                status, reopened = self.request('/api/canva/project/queryProject',
                    {'projectId': project_id}, origin=origin)
                self.assertEqual(status, 200)
                self.assertEqual(reopened['data']['projectId'], project_id)

    def test_alias_is_rejected_without_explicit_configuration(self):
        status, result = self.request('/api/canva/project/queryProject', None,
            runtime=self.primary_only, origin=ADDITIONAL_ORIGIN,
            host='review-alias.example.test', extra=[('X-Forwarded-Host', 'review-alias.example.test')])
        self.assertEqual(status, 403)
        self.assertEqual(result['error'], 'Cross-origin write rejected')

    def test_cross_origin_and_spoofed_proxy_headers_do_not_write(self):
        before = set(self.proxy.inner.store.projects_dir.iterdir())
        for origin in ['https://evil.test', 'http://review.example.test',
                       'https://review.example.test:444', 'https://review.example.test.evil.test',
                       'https://frontend-review:8769', 'null', '', PUBLIC_ORIGIN + '/path',
                       PUBLIC_ORIGIN + ',https://evil.test', 'http://review-alias.example.test',
                       ADDITIONAL_ORIGIN + ':444', ADDITIONAL_ORIGIN + '.evil.test',
                       ADDITIONAL_ORIGIN + '/studio', ADDITIONAL_ORIGIN + ',https://evil.test',
                       ADDITIONAL_ORIGIN + '?', ADDITIONAL_ORIGIN + '#',
                       'https://user@review-alias.example.test', 'https://*.example.test']:
            with self.subTest(origin=origin):
                status, result = self.request('/compare/api/create', None,
                    origin=origin, extra=[('X-Forwarded-Host', 'evil.test'), ('X-Forwarded-Proto', 'https'),
                                          ('Forwarded', 'host=evil.test;proto=https')])
                self.assertEqual(status, 403)
                self.assertEqual(result['error'], 'Cross-origin write rejected')
        self.assertEqual(set(self.proxy.inner.store.projects_dir.iterdir()), before)

    def test_configured_origin_overrides_even_an_attacker_matching_host(self):
        status, _ = self.request('/compare/api/create', None, origin='https://evil.test', host='evil.test')
        self.assertEqual(status, 403)

    def test_duplicate_origins_and_hosts_are_rejected(self):
        for extra in [[('Origin', PUBLIC_ORIGIN)], [('Origin', ADDITIONAL_ORIGIN)],
                      [('Origin', 'https://evil.test')], [('Host', 'evil.test')]]:
            with self.subTest(extra=extra):
                status, _ = self.request('/compare/api/create', None, origin=PUBLIC_ORIGIN, extra=extra)
                self.assertEqual(status, 403)

    def test_origin_does_not_bypass_the_review_capability(self):
        for origin in [PUBLIC_ORIGIN, ADDITIONAL_ORIGIN]:
            with self.subTest(origin=origin):
                status, _ = self.request('/compare/api/create', None, origin=origin, authenticated=False)
                self.assertEqual(status, 401)

    def test_no_origin_client_is_preserved(self):
        status, result = self.request('/compare/api/create', {'projectName': 'CLI compatibility', 'brief': ''})
        self.assertEqual(status, 200)
        self.assertEqual(self.proxy.inner.store.get_project(result['projectId'])['projectName'], 'CLI compatibility')

    def test_direct_origin_is_preserved_and_proxy_headers_cannot_grant_access(self):
        status, _ = self.request('/api/canva/project/saveProject', {'projectName': 'Direct origin'},
            runtime=self.direct, origin=self.direct.origin)
        self.assertEqual(status, 200)
        status, _ = self.request('/compare/api/create', None, runtime=self.direct, origin=PUBLIC_ORIGIN,
            extra=[('X-Forwarded-Host', 'review.example.test'), ('X-Forwarded-Proto', 'https'),
                   ('Forwarded', 'host=review.example.test;proto=https')])
        self.assertEqual(status, 403)

    def test_invalid_public_origin_fails_before_creating_data(self):
        path = self.data / 'invalid-config'
        for origin in ['', 'null', '*', PUBLIC_ORIGIN + '/studio']:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                ShareRuntime(path, public_origin=origin)
        self.assertFalse(path.exists())

    def test_invalid_additional_origins_fail_before_creating_data(self):
        path = self.data / 'invalid-additional-config'
        values = ['', 'null', '{}', '"https://review-alias.example.test"', '[',
                  ' ' * 4097, '[' * 1000, json.dumps([f'https://alias-{n}.example.test' for n in range(9)])]
        values += [json.dumps([value]) for value in [None, False, 1, {}, [], '', 'null', '*',
            ADDITIONAL_ORIGIN + '/studio', ADDITIONAL_ORIGIN + '?', ADDITIONAL_ORIGIN + '#',
            ADDITIONAL_ORIGIN + ',https://evil.test', ADDITIONAL_ORIGIN + ' https://evil.test',
            'https://user@review-alias.example.test', 'https://*.example.test',
            'https://review-alias.example.test:65536', PUBLIC_ORIGIN, 'https://REVIEW.example.test:443']]
        values += [json.dumps([ADDITIONAL_ORIGIN, ADDITIONAL_ORIGIN]),
                   json.dumps([ADDITIONAL_ORIGIN, 'https://REVIEW-ALIAS.example.test:443']),
                   json.dumps([ADDITIONAL_ORIGIN, 'null'])]
        for value in values:
            with self.subTest(configuration=value), self.assertRaises(ValueError):
                ShareRuntime(path, public_origin=PUBLIC_ORIGIN, additional_origins=value)
        self.assertFalse(path.exists())

    def test_additional_origins_require_a_primary(self):
        path = self.data / 'missing-primary-config'
        with self.assertRaises(ValueError):
            ShareRuntime(path, additional_origins=json.dumps([ADDITIONAL_ORIGIN]))
        self.assertFalse(path.exists())

    def test_invalid_environment_configuration_prevents_cli_startup(self):
        room = 'origin-invalid-env-' + uuid.uuid4().hex
        path = PACKAGE / 'sharing' / room
        environment = dict(os.environ, NOVART_REVIEW_PUBLIC_ORIGIN=PUBLIC_ORIGIN,
            NOVART_REVIEW_ADDITIONAL_ORIGINS='["https://review-alias.example.test/path"]')
        result = subprocess.run([sys.executable, str(PACKAGE / 'harness' / 'share_runtime.py'),
            '--room', room, '--port', '0'], env=environment, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Additional origins must be distinct', result.stderr)
        self.assertNotIn(b'Review gateway ready', result.stdout)
        self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
