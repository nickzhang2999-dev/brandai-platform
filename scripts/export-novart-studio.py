"""Compile the product's owned shell using an explicit, offline source allowlist.

The editor is built by Next at /studio-editor. This compiler only emits the
workspace shell, its style chain, supplied brand artwork and owned transport
adapters. It neither starts a server nor reads project data.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil

REPO = Path(__file__).resolve().parents[1]
BUILD = REPO / '.novart-build'
OUT = BUILD / 'studio'
SHELL = REPO / 'apps' / 'web' / 'studio-shell'
SHELL_FILES = (
    'studio.html', 'home-start-studio.js', 'home-start-studio.css',
    'responsive-layout.js', 'responsive-layout.css',
    'project-library-studio.css', 'deepflare-logo.svg', 'deepflare-mark.svg',
    'm8-studio.css', 'm9-studio.css', 'm10-studio.css', 'm12-studio.css',
    'm13-studio.css', 'm13-motion.css', 'm14-studio.css', 'm15-studio.css',
    'm16-studio.css', 'm17-studio.css', 'm18-studio.css', 'm21-studio.css',
    'm24-studio.css',
)
PRODUCT_FILES = {
    'home-start-attachments.js': 'novart-owned-home-start.js',
    'novart-product-bootstrap.js': 'novart-product-bootstrap.js',
    'novart-product-task-inbox.js': 'novart-product-task-inbox.js',
}
MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
}
ASSET = re.compile(r'''["'(](\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|css|png|svg|woff2?|ttf|jpg|webp))(?:["')?])''')
FORBIDDEN = re.compile(rb'lovart|lib-tldraw|/originals/|/m12-native/', re.IGNORECASE)


def _checked_output(output: Path) -> Path:
    """Never remove a source directory or follow an output link/junction."""
    requested = Path(output).absolute()
    build = BUILD.resolve()
    resolved = requested.resolve()
    if (resolved == build or not resolved.is_relative_to(build)
        or requested != resolved or requested.is_symlink()):
        raise ValueError('Studio output must be a real subdirectory of .novart-build')
    return resolved


def export_studio(output: Path = OUT) -> dict:
    output = _checked_output(output)
    sources = {name: SHELL / name for name in SHELL_FILES}
    sources.update({name: REPO / 'deploy' / 'novart' / 'studio' / source
                    for name, source in PRODUCT_FILES.items()})
    bodies: dict[str, bytes] = {}
    records: dict[str, dict] = {}
    for name, source in sources.items():
        if source.is_symlink() or source.resolve() != source.absolute():
            raise RuntimeError('Owned shell source must not be a link: ' + name)
        body = source.read_bytes()
        if not body or FORBIDDEN.search(body):
            raise RuntimeError('Invalid owned shell source: ' + name)
        bodies[name] = body
        records['/' + name] = {'file': name, 'mime': MIME[source.suffix],
            'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
    # Catch missing styles/scripts/images before deleting any prior build.
    for name, body in bodies.items():
        for match in ASSET.finditer(body.decode('utf-8')):
            dependency = match.group(1)
            # This former worker URL is only an exact-match retirement target;
            # no worker is generated, fetched or registered by the owned shell.
            if name == 'novart-product-bootstrap.js' and dependency == '/novart-product-worker.js':
                continue
            if dependency not in records:
                raise RuntimeError('Unlisted shell asset: ' + name + ' -> ' + dependency)
    manifest = {'format': 'novart-studio-assets-v1', 'files': records, 'external': {}}
    # Drop stale output from previous releases, including assets omitted by the
    # allowlist. All paths above were validated before this bounded removal.
    if output.exists():
        shutil.rmtree(_checked_output(output))
    output.mkdir(parents=True, exist_ok=True)
    for name, body in bodies.items():
        (output / name).write_bytes(body)
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'files': len(records), 'capturedExternal': 0,
        'bytes': sum(item['bytes'] for item in records.values()), 'output': str(output)}


def main():
    print(json.dumps(export_studio(), ensure_ascii=False))


if __name__ == '__main__':
    main()
