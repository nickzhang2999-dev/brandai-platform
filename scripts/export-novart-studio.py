"""Compile the product's owned shell using an explicit, offline source allowlist.

The editor is built by Next at /studio-editor. This compiler only emits the
workspace shell, its style chain, supplied brand artwork and owned transport
adapters. It neither starts a server nor reads project data.
"""
from __future__ import annotations

import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import posixpath
import re
import shutil
from urllib.parse import urlsplit, urlunsplit

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
VERSION_PARAMETER = 'novart_sha256'
# Match complete comments and ordinary strings as well, so example URLs inside
# them are not mistaken for dependencies. Escaped URLs are deliberately left
# alone; the explicit owned asset names do not use CSS escapes.
CSS_REFERENCE = re.compile(r'''/\*[\s\S]*?\*/
    |@import(?:\s|/\*[\s\S]*?\*/)+(?P<import_quote>["'])(?P<import_url>(?:\\.|[^\\])*?)(?P=import_quote)
    |(?<![\w-])url\(\s*(?:(?P<url_quote>["'])(?P<quoted_url>(?:\\.|[^\\])*?)(?P=url_quote)|(?P<bare_url>[^\s'"()]*))\s*\)
    |"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'
    ''', re.IGNORECASE | re.VERBOSE)
HTML_ATTRIBUTE = re.compile(r'''(?P<name>[^\s=<>/]+)\s*=\s*(?:"(?P<double>[^"]*)"|'(?P<single>[^']*)'|(?P<bare>[^\s>]+))''')
CSS_ASSET_SUFFIXES = {'.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.ttf'}


def _version_assets(original: dict[str, bytes]) -> dict[str, bytes]:
    """Version final bytes, from CSS leaves up to the HTML entrypoint.

    Only manifest-owned assets participate. The source tree stays untouched;
    query versions do not require another server route or filename mapping.
    """
    finished: dict[str, bytes] = {}
    visiting: list[str] = []

    def reference(owner: str, value: str, suffixes: set[str]) -> str:
        if not value or '\\' in value:
            return value
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc or not parsed.path:
            return value
        route = posixpath.normpath(posixpath.join(posixpath.dirname('/' + owner), parsed.path))
        dependency = route.lstrip('/')
        if dependency not in original or Path(dependency).suffix.lower() not in suffixes:
            return value
        digest = hashlib.sha256(compile_asset(dependency)).hexdigest()
        # Keep the spelling and order of all application query parameters.
        # This one compiler-owned parameter may already exist in an input.
        query = '&'.join(part for part in parsed.query.split('&')
                         if part.split('=', 1)[0] != VERSION_PARAMETER)
        query += ('&' if query else '') + VERSION_PARAMETER + '=' + digest
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))

    def css(owner: str, text: str) -> str:
        def replace(match: re.Match) -> str:
            group = next((name for name in ('import_url', 'quoted_url', 'bare_url')
                          if match.group(name) is not None), None)
            if group is None:
                return match.group()
            value = match.group(group)
            rewritten = reference(owner, value, {'.css'} if group == 'import_url' else CSS_ASSET_SUFFIXES)
            start, end = match.span(group)
            return match.group()[:start - match.start()] + rewritten + match.group()[end - match.start():]
        return CSS_REFERENCE.sub(replace, text)

    class HtmlVersions(HTMLParser):
        def __init__(self, owner: str, text: str):
            super().__init__(convert_charrefs=False)
            self.owner = owner
            self.text = text
            self.line_offsets = [0]
            self.line_offsets.extend(match.end() for match in re.finditer('\n', text))
            self.edits: list[tuple[int, int, str]] = []

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
            attributes = dict(attrs)
            if tag == 'link' and 'stylesheet' in (attributes.get('rel') or '').lower().split():
                attribute, suffixes = 'href', {'.css'}
            elif tag == 'script':
                attribute, suffixes = 'src', {'.js'}
            else:
                return
            raw_tag = self.get_starttag_text()
            for match in HTML_ATTRIBUTE.finditer(raw_tag):
                if match.group('name').lower() != attribute:
                    continue
                group = next(name for name in ('double', 'single', 'bare') if match.group(name) is not None)
                value = html.unescape(match.group(group))
                rewritten = reference(self.owner, value, suffixes)
                if rewritten != value:
                    line, column = self.getpos()
                    offset = self.line_offsets[line - 1] + column
                    start, end = match.span(group)
                    self.edits.append((offset + start, offset + end, html.escape(rewritten, quote=True)))
                break

        def result(self) -> str:
            self.feed(self.text)
            self.close()
            result = self.text
            for start, end, value in reversed(self.edits):
                result = result[:start] + value + result[end:]
            return result

    def compile_asset(name: str) -> bytes:
        if name in finished:
            return finished[name]
        if name in visiting:
            raise RuntimeError('Circular shell asset dependency: ' + ' -> '.join(visiting + [name]))
        visiting.append(name)
        body = original[name]
        if name.endswith('.css'):
            body = css(name, body.decode('utf-8')).encode('utf-8')
        elif name.endswith('.html'):
            body = HtmlVersions(name, body.decode('utf-8')).result().encode('utf-8')
        visiting.pop()
        finished[name] = body
        return body

    return {name: compile_asset(name) for name in original}


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
    bodies = _version_assets(bodies)
    for name, body in bodies.items():
        records['/' + name].update(bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
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
