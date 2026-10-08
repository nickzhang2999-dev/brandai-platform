"""Compile the reviewed UI for the authenticated Next runtime, without shipping local data.

The original Python adapter is used only as a build-time asset compiler. Its
project store is disposable and never copied to the result. Nothing is fetched
from a third-party website. Existing native patch builders validate their inputs.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
from pathlib import Path
import re
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import urlopen

REPO = Path(__file__).resolve().parents[1]
PREVIEW = REPO / 'previews' / 'novart-workbench'
OUT = REPO / '.novart-build' / 'studio'
sys.path.insert(0, str(PREVIEW / 'harness'))
from home_start_runtime import HomeStartRuntime  # noqa: E402
from rc3_runtime import RC3_PARAMETERS  # noqa: E402

ASSET = re.compile(r'''["'(](\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|css|png|svg|woff2?|ttf|jpg|webp))(?:["')?])''')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    temp_root = REPO / '.novart-build' / 'temporary'
    temp_root.mkdir(parents=True, exist_ok=True)
    records: dict[str, dict] = {}
    external: dict[str, str] = {}

    def write(url_path: str, body: bytes, mime: str):
        relative = url_path.lstrip('/')
        target = (OUT / relative).resolve()
        if not target.is_relative_to(OUT.resolve()) or not body:
            raise RuntimeError('Invalid compiled asset: ' + url_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        records[url_path] = {'file':relative, 'mime':mime, 'bytes':len(body), 'sha256':hashlib.sha256(body).hexdigest()}

    with tempfile.TemporaryDirectory(prefix='studio-export-', dir=temp_root) as temporary:
        assert Path(temporary).resolve().is_relative_to(temp_root.resolve())
        runtime = HomeStartRuntime(temporary)
        runtime.start()
        try:
            # This ID is solely for the compiler's archive guard; HTML must not contain it.
            project = runtime.store.create_project({'projectName':'Build-time resource validation'})
            project_id = project['projectId']
            canvas_path = '/canvas?' + urlencode({'projectId':project_id, 'v':'1', **RC3_PARAMETERS})
            queue = [('/studio', '/studio.html'), (canvas_path, '/canvas.html')]
            visited = set()
            while queue:
                request_path, output_path = queue.pop(0)
                if output_path in visited:
                    continue
                visited.add(output_path)
                try:
                    with urlopen(runtime.origin + request_path, timeout=15) as response:
                        body = response.read()
                        mime = response.headers.get('Content-Type', 'application/octet-stream')
                except HTTPError as error:
                    raise RuntimeError(f'Asset compilation failed for {request_path}: {error.read(400).decode()}') from error
                if output_path.endswith('.html') and project_id.encode() in body:
                    raise RuntimeError('Build-time project leaked into HTML')
                write(output_path, body, mime)
                if any(kind in mime for kind in ['html', 'javascript', 'css']):
                    for match in ASSET.finditer(body.decode('utf-8')):
                        path = match.group(1)
                        if 'javascript' in mime and not re.match(r'^/(?:m\d+[-/]|rc\d+-|home-start-|project-library-|responsive-|comparison\.|local-mode\.|originals/)', path):
                            continue  # Unexecuted vendor examples are not asset dependencies.
                        if path not in visited and not path.startswith('/api/'):
                            queue.append((path, path))
            # Native lazy chunks and captured fonts are not all referenced in HTML.
            for source in (PREVIEW / 'originals').rglob('*'):
                if source.is_file() and source.relative_to(PREVIEW / 'originals').parts[0] in ('static', 'external'):
                    path = '/originals/' + source.relative_to(PREVIEW / 'originals').as_posix()
                    if path not in records:
                        write(path, source.read_bytes(), mimetypes.guess_type(source.name)[0] or 'application/octet-stream')
            for remote, asset in runtime.external.items():
                source = (PREVIEW / asset['path']).resolve()
                if not source.is_relative_to((PREVIEW / 'originals').resolve()):
                    raise RuntimeError('Captured external asset escaped originals')
                body = source.read_bytes()
                if hashlib.sha256(body).hexdigest() != asset['sha256']:
                    raise RuntimeError('Captured external asset hash mismatch')
                external[remote] = '/' + source.relative_to(PREVIEW).as_posix()
        finally:
            runtime.close()

    manifest = {'format':'novart-studio-assets-v1', 'files':records, 'external':external}
    (OUT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'files':len(records), 'capturedExternal':len(external), 'bytes':sum(v['bytes'] for v in records.values()), 'output':str(OUT)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
