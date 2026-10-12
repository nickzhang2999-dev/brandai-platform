"""Loopback HTTP routing checks for the optional old-review product bridge.

Only ShareRuntime's real gateway handler is exercised. The isolated inner server
is a route stub, not business/model acceptance; no HomeStartRuntime, browser,
Docker, provider, existing review room or remote product endpoint is used.
Run: python scripts/test-novart-product-entry.py
"""
from __future__ import annotations

from contextlib import redirect_stdout
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

PACKAGE = Path(__file__).resolve().parents[1] / 'previews' / 'novart-workbench'
sys.path.insert(0, str(PACKAGE / 'harness'))

import share_runtime
from share_runtime import ShareRuntime, _validate_product_entry

PRODUCT = 'https://product.example.test/studio'
PUBLIC_ORIGIN = 'https://review.example.test'
ALIAS_ORIGIN = 'https://review-alias.example.test'


class InnerRouteStub:
    """A loopback-only route recorder; never presents business data as real."""
    instances = []

    def __init__(self, data_dir, *, tldraw_license_key=None):
        self.requests = []
        self.closed = False
        self.license = tldraw_license_key
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self):
                length = int(self.headers.get('Content-Length', '0'))
                if length:
                    self.rfile.read(length)
                owner.requests.append((self.command, self.path, dict(self.headers)))
                body = json.dumps({'routeStub': True}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(body)

            do_GET = respond
            do_HEAD = respond
            do_POST = respond

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.instances.append(self)

    def start(self):
        self.thread.start()
        return self

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.closed = True


class ProductEntryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sharing = (PACKAGE / 'sharing').resolve()
        sharing.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='product-entry-check-', dir=sharing)
        cls.data = Path(temporary.name).resolve()
        if cls.data.parent != sharing or not cls.data.name.startswith('product-entry-check-'):
            raise AssertionError('Test directory escaped isolated sharing root')
        cls.addClassCleanup(temporary.cleanup)
        stub = patch.object(share_runtime, 'HomeStartRuntime', InnerRouteStub)
        stub.start()
        cls.addClassCleanup(stub.stop)
        cls.enabled = ShareRuntime(cls.data / 'enabled', public_origin=PUBLIC_ORIGIN,
            additional_origins=json.dumps([ALIAS_ORIGIN]), product_entry=PRODUCT).start()
        cls.addClassCleanup(cls.enabled.close)
        cls.disabled = ShareRuntime(cls.data / 'disabled', public_origin=PUBLIC_ORIGIN).start()
        cls.addClassCleanup(cls.disabled.close)

    def request(self, path, *, method='GET', runtime=None, cookie=None, extra=()):
        runtime = runtime or self.enabled
        connection = http.client.HTTPConnection('127.0.0.1', runtime.server.server_port, timeout=5)
        try:
            connection.putrequest(method, path)
            connection.putheader('Content-Length', '0')
            if cookie is not None:
                connection.putheader('Cookie', cookie)
            for name, value in extra:
                connection.putheader(name, value)
            connection.endheaders()
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def assert_redirect(self, result, target=PRODUCT):
        status, headers, body = result
        self.assertEqual(status, 302)
        self.assertEqual(headers['Location'], target)
        self.assertEqual(body, b'')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(headers['X-Frame-Options'], 'SAMEORIGIN')
        self.assertIn('noindex', headers['X-Robots-Tag'])
        self.assertIn("frame-ancestors 'self'", headers['Content-Security-Policy'])

    def test_valid_explicit_https_targets_and_default_disabled(self):
        self.assertIsNone(_validate_product_entry(None))
        for value in (PRODUCT, 'https://PRODUCT.example.test:443/studio',
                      'https://127.0.0.1:8769/studio', 'https://[::1]/studio'):
            with self.subTest(target=value):
                self.assertEqual(_validate_product_entry(value), value)

    def test_invalid_targets_fail_before_data_or_inner_start(self):
        values = [False, 3, [], '', '/studio', '//product.example.test/studio',
            'http://product.example.test/studio', 'file://product.example.test/studio',
            'https://product.example.test', PRODUCT + '/', PRODUCT + '?', PRODUCT + '#',
            PRODUCT + '?next=https://evil.test', PRODUCT + '#cap',
            'https://user:password@product.example.test/studio',
            'https://@product.example.test/studio', 'https://product.example.test/other',
            'https://product.example.test//studio', 'https://product.example.test/%73tudio',
            'https://product.example.test/a/../studio', 'https://product.example.test:0/studio',
            'https://product.example.test:65536/studio', 'https://product.example.test:/studio',
            'https://product.example.test:wrong/studio', 'https://*.example.test/studio',
            'https://bad_host.example.test/studio', 'https://-bad.example.test/studio',
            'https://bad-.example.test/studio', 'https://bad..example.test/studio',
            'https://999.999.999.999/studio', 'https://[::1]evil.test/studio',
            'https://[fe80::1%25eth0]/studio', 'https://product.example.test\\@evil.test/studio',
            'https://product.example.test,evil.test/studio', ' ' + PRODUCT,
            PRODUCT + '\n', 'https://pro\tduct.example.test/studio',
            'https://pro\x00duct.example.test/studio', 'https://' + 'a' * 254 + '/studio']
        path = self.data / 'invalid-target'
        before = len(InnerRouteStub.instances)
        for value in values:
            with self.subTest(target=value), self.assertRaisesRegex(ValueError, '^Product entry must'):
                ShareRuntime(path, product_entry=value)
        self.assertFalse(path.exists())
        self.assertEqual(len(InnerRouteStub.instances), before)

    def test_public_root_and_product_ignore_incoming_state(self):
        before = len(self.enabled.inner.requests)
        for method in ('GET', 'HEAD'):
            for path in ('/', '/product'):
                for cookie in (None, 'novart_review=wrong', 'novart_review=' + self.enabled.key):
                    with self.subTest(method=method, path=path, cookiePresent=cookie is not None):
                        result = self.request(path + '?next=https://evil.test&cap=private#ignored',
                            method=method, cookie=cookie, extra=(('Authorization', 'Bearer route-fixture'),
                            ('Referer', 'https://evil.test/?private=fixture'),
                            ('X-Forwarded-Host', 'evil.test'), ('X-Forwarded-Proto', 'http')))
                        self.assert_redirect(result)
                        headers = result[1]
                        for name in ('Set-Cookie', 'Authorization', 'Cookie', 'Referer', 'X-Forwarded-Host'):
                            self.assertNotIn(name, headers)
        self.assertEqual(len(self.enabled.inner.requests), before)

    def test_valid_share_cookie_chain_and_protected_entries(self):
        before = len(self.enabled.inner.requests)
        result = self.request('/share/' + self.enabled.key + '?next=https://evil.test&fixture=private',
            extra=(('X-Forwarded-Proto', 'https'),))
        self.assert_redirect(result, '/share-start')
        cookie = SimpleCookie()
        cookie.load(result[1]['Set-Cookie'])
        self.assertEqual(cookie['novart_review'].value, self.enabled.key)
        for attribute, expected in (('path', '/'), ('httponly', True), ('samesite', 'Strict'), ('secure', True)):
            self.assertEqual(cookie['novart_review'][attribute], expected)
        request_cookie = 'novart_review=' + cookie['novart_review'].value
        for method in ('GET', 'HEAD'):
            for path in ('/share-start', '/studio'):
                self.assert_redirect(self.request(path + '?next=https://evil.test#fixture',
                    method=method, cookie=request_cookie))
                for bad_cookie in (None, 'novart_review=wrong'):
                    status, headers, _ = self.request(path, method=method, cookie=bad_cookie)
                    self.assertEqual(status, 401)
                    self.assertNotIn('Location', headers)
        self.assertEqual(self.request('/share/not-the-capability')[0], 404)
        self.assertEqual(self.request('/share/' + self.enabled.key, method='HEAD')[0], 401)
        self.assertEqual(len(self.enabled.inner.requests), before)

    def test_non_get_keeps_auth_origin_and_upload_guards(self):
        cookie = 'novart_review=' + self.enabled.key
        for method in ('POST', 'PUT'):
            for path in ('/', '/product', '/studio', '/share-start'):
                with self.subTest(method=method, path=path):
                    self.assertEqual(self.request(path, method=method)[0], 401)
                    status, headers, _ = self.request(path, method=method, cookie=cookie,
                        extra=(('Origin', 'https://evil.test'), ('X-Forwarded-Host', 'review.example.test')))
                    self.assertEqual(status, 403)
                    self.assertNotIn('Location', headers)
        for origin in (PUBLIC_ORIGIN, ALIAS_ORIGIN):
            result = self.request('/product', method='POST', cookie=cookie, extra=(('Origin', origin),))
            self.assertEqual(result[0], 200)
            self.assertNotIn('Location', result[1])
            self.assertEqual(json.loads(result[2]), {'routeStub': True})
        self.assertEqual(self.request('/product', method='PUT', cookie=cookie,
            extra=(('Origin', PUBLIC_ORIGIN),))[0], 404)
        self.assertEqual(self.request('/studio/start/upload', method='POST', cookie=cookie,
            extra=(('Origin', PUBLIC_ORIGIN),))[0], 400)

    def test_health_and_unrelated_paths_keep_existing_behavior(self):
        for runtime in (self.enabled, self.disabled):
            for method in ('GET', 'HEAD'):
                result = self.request('/healthz?next=https://evil.test', method=method, runtime=runtime)
                self.assertEqual(result[0], 200)
                self.assertNotIn('Location', result[1])
                if method == 'GET':
                    payload = json.loads(result[2])
                    self.assertEqual(payload['status'], 'ok')
                    self.assertEqual(payload['service'], 'novart-workbench-preview')
                else:
                    self.assertEqual(result[2], b'')
        self.assertEqual(self.request('/studio/')[0], 401)
        self.assertEqual(self.request('/product/')[0], 401)
        self.assertEqual(self.request('/share-worker.js')[0], 401)
        cookie = 'novart_review=' + self.enabled.key
        self.assertEqual(self.request('/review/startup-diagnostics', cookie=cookie)[0], 200)
        self.assertEqual(self.request('/share-worker.js', cookie=cookie)[0], 200)
        self.assertEqual(self.request('https://evil.test/product')[0], 400)

    def test_disabled_preserves_original_landing_and_share_chain(self):
        runtime = self.disabled
        self.assertIsNone(runtime.product_entry)
        status, headers, body = self.request('/', runtime=runtime)
        self.assertEqual(status, 200)
        self.assertIn('完整评审链接'.encode(), body)
        self.assertNotIn('Location', headers)
        for method in ('GET', 'HEAD'):
            self.assertEqual(self.request('/product', runtime=runtime, method=method)[0], 401)
            cookie = 'novart_review=' + runtime.key
            self.assert_redirect(self.request('/', runtime=runtime, method=method, cookie=cookie), '/studio#/home')
        result = self.request('/share/' + runtime.key, runtime=runtime)
        self.assert_redirect(result, '/share-start')
        cookie = 'novart_review=' + runtime.key
        status, headers, body = self.request('/share-start', runtime=runtime, cookie=cookie)
        self.assertEqual(status, 200)
        self.assertIn(b'navigator.serviceWorker.register', body)
        self.assertNotIn('Location', headers)
        before = len(runtime.inner.requests)
        self.assertEqual(self.request('/studio', runtime=runtime, cookie=cookie)[0], 200)
        self.assertEqual(runtime.inner.requests[before][1], '/studio')

    def test_invalid_environment_prevents_cli_data_or_startup(self):
        room = 'product-entry-invalid-env-' + uuid.uuid4().hex
        environment = dict(os.environ, NOVART_REVIEW_PRODUCT_ENTRY=PRODUCT + '?cap=fixture')
        result = subprocess.run([sys.executable, str(PACKAGE / 'harness/share_runtime.py'),
            '--room', room, '--port', '0'], env=environment, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'Product entry must', result.stderr)
        self.assertNotIn(b'Review gateway ready', result.stdout)
        self.assertNotIn(b'?cap=fixture', result.stderr)
        self.assertFalse((PACKAGE / 'sharing' / room).exists())

    def test_cli_environment_and_explicit_argument_wiring(self):
        # Run the actual CLI body with only its inner runtime substituted and an
        # immediate orderly stop; never launch a product/model runtime.
        for explicit in (False, True):
            room = self.data / ('cli-explicit' if explicit else 'cli-env')
            argv = [str(PACKAGE / 'harness/share_runtime.py'), '--room', room.name, '--port', '0']
            # CLI rooms are direct children of sharing/; substitute only its
            # isolated ROOT, retaining the real command-line/configuration flow.
            with tempfile.TemporaryDirectory(prefix='product-entry-cli-root-') as directory:
                root = Path(directory)
                argv[argv.index('--room') + 1] = 'isolated-room'
                if explicit:
                    argv += ['--product-entry', PRODUCT]
                env_value = 'http://invalid.test/studio' if explicit else PRODUCT
                with patch.object(sys, 'argv', argv), patch.dict(os.environ,
                    {'NOVART_REVIEW_PRODUCT_ENTRY': env_value}), \
                    patch('local_runtime.ROOT', root), \
                    patch('home_start_runtime.HomeStartRuntime', InnerRouteStub), \
                    patch('time.sleep', side_effect=KeyboardInterrupt), redirect_stdout(io.StringIO()):
                    result = runpy.run_path(str(PACKAGE / 'harness/share_runtime.py'), run_name='__main__')
                self.assertEqual(result['runtime'].product_entry, PRODUCT)
                self.assertTrue(result['runtime'].inner.closed)


if __name__ == '__main__':
    unittest.main(verbosity=2)
