"""Supply an owned public license through the SDK's existing licenseKey prop.

Only the captured application's exported getter changes. The SDK's signature,
domain, expiry and development checks, and the frozen files, remain untouched.
Configuration is server-owned and installed before any native script executes.
"""
from __future__ import annotations

import hashlib
import json


MAX_LICENSE_KEY_LENGTH = 8192
LICENSE_GLOBAL = '__NOVART_TLDRAW_LICENSE_KEY'
SOURCE_SHA256 = 'e7c90258dad551612f1cc57436f1f3ee2f3a2d7c15fa0decd32b16e71e6d0bb7'
ORIGINAL_SHA256 = '2dc5773410b0759fa63a05fc97fbf6c9f6e11d9423af40090eb8aa354ba25750'
ANCHOR = b'10938(e,t,a){"use strict";var i;a.d(t,{$y:()=>r,DE:()=>s,LI:()=>n,_v:()=>l,te:()=>o});'
REPLACEMENT = (b'10938(e,t,a){"use strict";var i;a.d(t,{$y:()=>'
    b'typeof globalThis.__NOVART_TLDRAW_LICENSE_KEY==="string"?'
    b'globalThis.__NOVART_TLDRAW_LICENSE_KEY:"",DE:()=>s,LI:()=>n,_v:()=>l,te:()=>o});')
SCRIPT_MARKER = b'data-novart-license-config'


def validate_license_key(value):
    """Validate configuration syntax only; the original SDK validates the license."""
    if value is None:
        return ''
    if (not isinstance(value, str) or len(value) > MAX_LICENSE_KEY_LENGTH
        or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in value)):
        # Never include the supplied value, even in an exception or its cause.
        raise ValueError('Invalid Novart tldraw license configuration')
    return value


def build_license_script(value):
    """Return an inline-safe, synchronous and immutable public configuration."""
    value = validate_license_key(value)
    literal = (json.dumps(value, ensure_ascii=True).replace('<', '\\u003c')
        .replace('>', '\\u003e').replace('&', '\\u0026'))
    return ('Object.defineProperty(globalThis,"' + LICENSE_GLOBAL + '",{value:' + literal
        + ',writable:false,configurable:false,enumerable:false});').encode('ascii')


def inject_license_script(document, script):
    """Insert before native execution; fail closed if the frozen HTML shape drifts."""
    if (not isinstance(document, bytes) or document.count(b'<head>') != 1
        or SCRIPT_MARKER in document or b'</script' in script.lower()):
        raise ValueError('Native license configuration HTML anchor changed')
    tag = b'<script ' + SCRIPT_MARKER + b'>' + script + b'</script>'
    return document.replace(b'<head>', b'<head>' + tag, 1)


def _build_chunk(source, expected_sha256):
    if not isinstance(source, bytes):
        raise TypeError('Expected frozen native bytes')
    if hashlib.sha256(source).hexdigest() != expected_sha256 or source.count(ANCHOR) != 1:
        raise ValueError('Native license source or unique getter anchor changed')
    derived = source.replace(ANCHOR, REPLACEMENT, 1)
    if derived.count(REPLACEMENT) != 1 or derived.replace(REPLACEMENT, ANCHOR, 1) != source:
        raise ValueError('Native license getter inverse check failed')
    return derived


def build_native_license_chunk(source):
    """Wrap the final RC3 derivative, after every earlier frozen transform."""
    return _build_chunk(source, SOURCE_SHA256)


def build_original_license_chunk(source):
    """Also protect the frozen URL alias without changing its file on disk."""
    return _build_chunk(source, ORIGINAL_SHA256)
