"""Pin-checked M26 attachment layout over the frozen M25 native derivative.

The original image components retain their selection, camera, size observer,
input and history behavior. Only the two shared attachment position functions
receive a measured lower boundary. Captured bundles and M25 stay unchanged.
"""

from __future__ import annotations

import hashlib

import m25_native_patch as _m25


NativePatchError = _m25.NativePatchError
ORIGINAL_CHUNK_SHA256 = "2dc5773410b0759fa63a05fc97fbf6c9f6e11d9423af40090eb8aa354ba25750"
ORIGINAL_CONTROLS_SHA256 = "c60663cb8fcb58ee821e1ababeea5ea296f3a780bf03c199ef0828bc5b66c410"
M25_NATIVE_CHUNK_SHA256 = "f99758086b65206e074dd5fee5996956e992c70e1b136e51e793eaa9b87d5e2a"


_HORIZONTAL_ANCHOR = 'function _2(e,t,a,i){let r,n=e.getViewportScreenBounds();if(!i.isValid||!i.relativeBounds)return null;let s=i.relativeBounds,o=(0,ey.S3)();if(!(s.maxX>=o&&s.x<=n.w-_$&&s.maxY>=_0&&s.y<=n.h-_0))return null;let{w:l,h:c}=t;if(!l||!c){let e=a.getBoundingClientRect();l=e.width,c=e.height}if(!l||!c)return null;r=s.y-24-_0>=c?Math.max(_0,s.y-24-c):s.maxY+24;let d=s.x+(s.w-l)/2;d=Math.max(o,Math.min(d,n.w-_$-l));let{scrollLeft:u,scrollTop:m}=e.getContainer();return{x:Math.round(d+u),y:Math.round(r+m)}}'

_BOTTOM_HELPER = r'''function nvM26AttachmentBottom(e,t){
  let a=t.h-16,i=e.getContainer().ownerDocument,r=i.querySelector('[data-testid="bottom-toolbar"]');
  if(!r)return a;
  let n=r.getBoundingClientRect(),s=i.defaultView?i.defaultView.getComputedStyle(r):null;
  if(n.width>0&&n.height>0&&n.bottom>t.y&&n.top<t.y+t.h&&n.right>t.x&&n.left<t.x+t.w&&(!s||s.display!=="none"&&s.visibility!=="hidden"&&s.visibility!=="collapse"&&s.opacity!=="0"))a=Math.min(a,n.top-t.y-12);
  return a;
}'''

_HORIZONTAL_REPLACEMENT = _BOTTOM_HELPER + _HORIZONTAL_ANCHOR.replace(
    'r=s.y-24-_0>=c?Math.max(_0,s.y-24-c):s.maxY+24;',
    'r=s.y-24-_0>=c?Math.max(_0,s.y-24-c):s.maxY+24;r=Math.max(_0,Math.min(r,nvM26AttachmentBottom(e,n)-c));',
    1,
)

_VERTICAL_ANCHOR = 'let h=l.h-m-h2,_=Math.max(h2,Math.min(c.y,h)),v=!1,y=!1;'
_VERTICAL_REPLACEMENT = 'let h=Math.min(l.h-h2,nvM26AttachmentBottom(e,l))-m,_=Math.max(h2,Math.min(c.y,h)),v=!1,y=!1;'

PATCHES = (
    ("horizontal original attachment lower boundary", _HORIZONTAL_ANCHOR, _HORIZONTAL_REPLACEMENT),
    ("vertical original attachment lower boundary", _VERTICAL_ANCHOR, _VERTICAL_REPLACEMENT),
)


def _base(original: bytes, controls_original: bytes) -> tuple[bytes, str]:
    if not isinstance(original, bytes) or not isinstance(controls_original, bytes):
        raise TypeError("Expected captured original chunk and controls bytes")
    for label, content, pin in (
        ("original chunk", original, ORIGINAL_CHUNK_SHA256),
        ("original controls", controls_original, ORIGINAL_CONTROLS_SHA256),
    ):
        actual = hashlib.sha256(content).hexdigest()
        if actual != pin:
            raise NativePatchError(f"M26 {label} SHA256 mismatch: {actual}")
    base = _m25.build_native_chunk(original, controls_original)
    actual = hashlib.sha256(base).hexdigest()
    if actual != M25_NATIVE_CHUNK_SHA256:
        raise NativePatchError(f"M26 frozen M25 native SHA256 mismatch: {actual}")
    try:
        source = base.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise NativePatchError("M26 M25 native base is not UTF-8") from exc
    for number, (label, anchor, _) in enumerate(PATCHES, 1):
        count = source.count(anchor)
        if count != 1:
            raise NativePatchError(f"M26 anchor {number} ({label}) must occur once; found {count}")
    return base, source


def _apply(source: str) -> bytes:
    derived = source
    for number, (label, anchor, replacement) in enumerate(PATCHES, 1):
        count = derived.count(anchor)
        if count != 1:
            raise NativePatchError(f"M26 sequential anchor {number} ({label}) must occur once; found {count}")
        derived = derived.replace(anchor, replacement, 1)
    restored = derived
    for number in range(len(PATCHES) - 1, -1, -1):
        label, anchor, replacement = PATCHES[number]
        count = restored.count(replacement)
        if count != 1:
            raise NativePatchError(f"M26 inverse anchor {number + 1} ({label}) must occur once; found {count}")
        restored = restored.replace(replacement, anchor, 1)
    if restored != source:
        raise NativePatchError("M26 inverse did not recover frozen M25 native bytes")
    return derived.encode("utf-8")


def build_native_chunk(original: bytes, controls_original: bytes) -> bytes:
    """Return the isolated M26 derivative after both source pins and base pass."""
    _, source = _base(original, controls_original)
    return _apply(source)


def patch_manifest(original: bytes, controls_original: bytes) -> dict:
    """Record the exact source pins, bounded changes and byte-exact inverse."""
    base, source = _base(original, controls_original)
    derived = _apply(source)
    anchors = []
    original_source = original.decode("utf-8")
    for number, (label, anchor, replacement) in enumerate(PATCHES, 1):
        offset = source.index(anchor)
        original_offset = original_source.index(anchor)
        anchors.append({
            "number": number,
            "label": label,
            "count": 1,
            "characterOffset": offset,
            "byteOffset": len(source[:offset].encode("utf-8")),
            "line": source.count("\n", 0, offset) + 1,
            "originalCharacterOffset": original_offset,
            "originalByteOffset": len(original_source[:original_offset].encode("utf-8")),
            "originalLine": original_source.count("\n", 0, original_offset) + 1,
            "anchor": anchor,
            "anchorSha256": hashlib.sha256(anchor.encode("utf-8")).hexdigest(),
            "replacementSha256": hashlib.sha256(replacement.encode("utf-8")).hexdigest(),
        })
    return {
        "sourceSha256": ORIGINAL_CHUNK_SHA256,
        "controlsSourceSha256": ORIGINAL_CONTROLS_SHA256,
        "controlsModified": False,
        "baseSha256": M25_NATIVE_CHUNK_SHA256,
        "derivedSha256": hashlib.sha256(derived).hexdigest(),
        "sourceBytes": len(original),
        "baseBytes": len(base),
        "derivedBytes": len(derived),
        "anchors": anchors,
        "inverseToBaseExact": True,
        "inheritedPatchManifest": _m25.patch_manifest(original, controls_original),
        "layoutOnly": True,
        "nativeSelectionGateChanged": False,
        "nativeHorizontalPlacementChanged": False,
        "nativeScrollConversionChanged": False,
        "bottomToolbarInset": 12,
        "noBottomToolbarViewportInset": 16,
        "directStoreWrites": False,
        "privateReactOrLexicalWrites": False,
        "documentHistoryWrites": False,
        "globalDOMObserver": False,
    }
