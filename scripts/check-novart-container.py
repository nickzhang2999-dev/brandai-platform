"""CI-only Docker integration check. Uses a disposable volume, never review data.

No browser automation or business providers. All capabilities stay in memory.
This verifies HTTP/storage/container behavior, not the editor's pointer behavior.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import http.client
import json
from pathlib import Path
import subprocess
import struct
import time
import uuid
import zlib

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'previews' / 'novart-workbench'


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def docker(*args, timeout=60):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Do not echo command/stdout: exec may return a review capability.
        raise RuntimeError(f'Docker {args[0]} failed (exit {result.returncode})')
    return result.stdout.strip()


def verify_package():
    raw = (PACKAGE / 'PACKAGE_MANIFEST.json').read_bytes()
    manifest = json.loads(raw)
    for name, expected in manifest['sha256'].items():
        path = (PACKAGE / name).resolve()
        require(path.is_relative_to(PACKAGE.resolve()), 'Manifest path escapes package')
        require(path.is_file(), f'Missing package file: {name}')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == expected, f'Changed package file: {name}')
    print(f'Package checksums: {len(manifest["sha256"])} passed', flush=True)
    return hashlib.sha256(raw).hexdigest()


def check_container(image, expected_sha):
    suffix = uuid.uuid4().hex[:12]
    name = 'novart-ci-' + suffix
    volume = name + '-data'
    docker('volume', 'create', volume)
    checks = []
    port = 0

    def request(path, payload=None, *, cookie=None, headers=None):
        outgoing = dict(headers or {})
        if cookie:
            outgoing['Cookie'] = cookie
        if payload is not None and not isinstance(payload, bytes):
            payload = json.dumps(payload).encode()
            outgoing['Content-Type'] = 'application/json'
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=12)
        try:
            connection.request('POST' if payload is not None else 'GET', path, payload, outgoing)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def api(path, payload, cookie):
        status, _, body = request('/api/canva/project/' + path, payload, cookie=cookie)
        data = json.loads(body)
        require(status == 200 and data.get('code') == 0, 'Project API failed: ' + path)
        return data['data']

    def start():
        nonlocal port
        docker('run', '-d', '--name', name, '-p', '127.0.0.1::8769',
               '--mount', f'type=volume,source={volume},target=/app/sharing', image)
        binding = json.loads(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', name))
        port = int(binding['8769/tcp'][0]['HostPort'])
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                status, _, raw = request('/healthz')
                health = json.loads(raw)
                if status == 200 and health.get('status') == 'ok':
                    require(health.get('service') == 'novart-workbench-preview', 'Wrong service')
                    require(health.get('packageSha256') == expected_sha, 'Wrong running package')
                    return
            except (OSError, ValueError, http.client.HTTPException):
                pass
            time.sleep(0.25)
        raise AssertionError('Container startup exceeded 45 seconds')

    try:
        start()
        require(docker('exec', name, 'id', '-u') == '10001', 'Container must run unprivileged')
        checks.append('Linux startup, non-root UID and package identity')
        require(request('/')[0] == 200, 'Public landing failed')
        require(request('/studio')[0] == 401, 'Studio is not protected')
        require(request('/share/invalid')[0] == 404, 'Invalid capability accepted')
        checks.append('Unauthenticated access denied')

        runtime = json.loads(docker('exec', name, 'cat', '/app/sharing/preview/runtime.json'))
        entry = runtime['entryPath']
        status, headers, _ = request(entry, headers={'X-Forwarded-Proto': 'https'})
        require(status == 302, 'Review entry failed')
        set_cookie = headers['Set-Cookie']
        require(all(value in set_cookie for value in ['HttpOnly', 'SameSite=Strict', 'Secure']), 'Cookie flags missing')
        cookie = set_cookie.split(';', 1)[0]
        checks.append('HTTPS cookie protections')

        for path, mime in [('/studio', 'text/html'), ('/share-worker.js', 'javascript'),
                           ('/responsive-layout.css', 'text/css'), ('/responsive-layout.js', 'javascript')]:
            status, headers, body = request(path, cookie=cookie)
            require(status == 200 and mime in headers.get('Content-Type', '') and len(body) > 100,
                    'Missing or invalid runtime entry: ' + path)
        checks.append('HTML, Service Worker and responsive entry assets')

        def chunk(kind, value):
            return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value))
        png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
               + chunk(b'IDAT', zlib.compress(b'\x00\x7c\x5c\xff')) + chunk(b'IEND', b''))
        status, _, body = request('/studio/start/upload', png, cookie=cookie,
                                 headers={'Content-Type': 'image/png', 'X-File-Name': 'ci.png'})
        require(status == 200, 'Image upload failed')
        upload = json.loads(body)['asset']
        require(upload['sha256'] == hashlib.sha256(png).hexdigest(), 'Upload returned a different image')
        checks.append('Image upload through HTTP')

        project = api('saveProject', {'projectName': 'Container persistence check'}, cookie)
        snapshot = {'tldrawSnapshot': {'document': {'store': {}, 'schema': {}}}}
        # A storage fixture only, not a claim that a user edited the canvas.
        canvas = 'SHAKKERDATA://' + base64.b64encode(gzip.compress(json.dumps(snapshot).encode())).decode()
        saved = api('saveProject', {**project, 'projectName': 'Saved before container recreation', 'canvas': canvas}, cookie)
        require(saved['version'] != project['version'], 'Version did not advance')
        require(request('/api/canva/project/saveProject', {}, cookie=cookie,
                        headers={'Origin': 'https://unrelated.invalid'})[0] == 403, 'Cross-origin write accepted')
        require(request('/api/ci/unavailable-provider', {}, cookie=cookie)[0] == 503, 'Unavailable API did not fail closed')
        checks.append('Project save, revision change and write guards')

        docker('rm', '-f', name)
        start()
        after = json.loads(docker('exec', name, 'cat', '/app/sharing/preview/runtime.json'))
        require(after['entryPath'] == entry, 'Access capability lost on recreation')
        reopened = api('queryProject', {'projectId': project['projectId']}, cookie)
        require(reopened['canvas'] == canvas and reopened['version'] == saved['version'] and
                reopened['projectName'] == 'Saved before container recreation', 'Project lost on recreation')
        status, headers, restored_png = request('/studio/start/image/' + upload['sha256'], cookie=cookie)
        require(status == 200 and restored_png == png and 'image/png' in headers.get('Content-Type', ''),
                'Uploaded image lost or changed on recreation')
        checks.append('New container with same volume restores project, image and access')
        print(json.dumps({'ok': True, 'checks': checks, 'packageSha256': expected_sha}, indent=2), flush=True)
    finally:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=30)
        subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True, timeout=30)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--verify-package-only', action='store_true')
    parser.add_argument('--image')
    args = parser.parse_args()
    package_sha = verify_package()
    if not args.verify_package_only:
        if not args.image:
            parser.error('--image is required for the container check')
        check_container(args.image, package_sha)
