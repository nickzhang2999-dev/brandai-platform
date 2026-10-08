"""Strict M12 menu/input derivatives layered on the frozen M11 builders.

Inputs are captured original bytes. No source file is modified. Only the opt-in
M12 runtime serves these derivatives; all inherited M11 behavior is retained.
"""

from __future__ import annotations

import hashlib

import m11_native_patch as _m11


NativePatchError = _m11.NativePatchError
ORIGINAL_CHUNK_SHA256 = "2dc5773410b0759fa63a05fc97fbf6c9f6e11d9423af40090eb8aa354ba25750"
ORIGINAL_EDITOR_CHUNK_SHA256 = "99079b08341259acf30d9d0e834f1dca74d8ce3b52c3e8e905f8b1ec7c040101"
M11_NATIVE_CHUNK_SHA256 = "644133c939177a0b5e1fd4177cc82fb124ce54ae688b87216427f52a40e5964e"
M11_EDITOR_CHUNK_SHA256 = "4a072d7e276ce0b913231520df6f6bb2cd678ff2c9f52908f8d4391226e5ab96"


# Open state alone is insufficient: force-mounted/hidden/inert popovers must
# not suppress the original canvas Escape command. Other keys are unchanged.
OPEN_POPOVER_FUNCTION = r'''function nvM12HasOpenPopover(nvDoc,nvWindow){
  return Array.from(nvDoc.querySelectorAll('[data-lovart-popover-content][data-state="open"]')).some(nvPopover=>{
    if(nvPopover.closest("[hidden],[inert]"))return false;
    const nvBounds=nvPopover.getBoundingClientRect();
    const nvVisibility=nvWindow.getComputedStyle(nvPopover).visibility;
    return nvBounds.width>0&&nvBounds.height>0&&nvVisibility!=="hidden"&&nvVisibility!=="collapse";
  });
}'''

# Radix closes a popover in document capture without stopping propagation.
# Mark only its menu Escape in the existing editor event bookkeeping so the
# later native canvas keydown does not also cancel the current selection.
# A not-yet-initialized editor must not prevent the menu receiving its event.
MARK_MENU_ESCAPE_FUNCTION = r'''function nvM12MarkMenuEscape(nvApp,nvEvent){
  try{
    nvApp.getEditor().markEventAsHandled(nvEvent);
    return true;
  }catch{return false;}
}'''

# The original fg helper expects an Element, reading tagName and closest
# directly. Check that boundary before using the same module's existing helper.
TAB_GUARD_FUNCTION = r'''function nvM12ShouldHandleTab(nvEvent,nvDoc,nvElement,nvEditable){
  if(nvEvent.key!=="Tab"||nvEvent.defaultPrevented||nvEvent.isComposing||nvEvent.keyCode===229)return false;
  const nvFocused=nvDoc.activeElement,nvTarget=nvEvent.target;
  return !(nvFocused instanceof nvElement&&nvEditable(nvFocused))&&!(nvTarget instanceof nvElement&&nvEditable(nvTarget));
}'''

_CONTEXT_MENU_ANCHOR = '(0,c.jsx)("div",{className:"pointer-events-auto fixed inset-0 z-[9999]",children:(0,c.jsx)("div",{ref:t,className:"absolute",style:{left:(o||r).x,top:(o||r).y}'
_CONTEXT_MENU_REPLACEMENT = '(0,c.jsx)("div",{className:"pointer-events-auto fixed inset-0 z-[9999]","data-lovart-menu-content":"",children:(0,c.jsx)("div",{ref:t,className:"absolute",style:{left:(o||r).x,top:(o||r).y}'

_ESCAPE_ANCHOR = 'if(this.disposed||document.querySelector("[data-lovart-menu-content]"))return;'
_ESCAPE_REPLACEMENT = 'if(this.disposed)return;if(document.querySelector("[data-lovart-menu-content]")||"Escape"===e.key&&(' + OPEN_POPOVER_FUNCTION + ')(document,window)){if("Escape"===e.key)(' + MARK_MENU_ESCAPE_FUNCTION + ')(this.app,e);return;}'

_DIRECT_TAB_ANCHOR = '(0,d.useEffect)(()=>{let e=e=>{"Tab"===e.key&&(e.preventDefault(),vh("tab"))};return document.addEventListener("keydown",e,!0),()=>{document.removeEventListener("keydown",e,!0)}},[])'
_DIRECT_TAB_REPLACEMENT = '(0,d.useEffect)(()=>{let e=e=>{(' + TAB_GUARD_FUNCTION + ')(e,document,Element,hv.fg)&&(e.preventDefault(),vh("tab"))};return document.addEventListener("keydown",e,!0),()=>{document.removeEventListener("keydown",e,!0)}},[])'

PATCH_ANCHORS = (_CONTEXT_MENU_ANCHOR, _ESCAPE_ANCHOR, _DIRECT_TAB_ANCHOR)
PATCH_REPLACEMENTS = (_CONTEXT_MENU_REPLACEMENT, _ESCAPE_REPLACEMENT, _DIRECT_TAB_REPLACEMENT)


def _verify_input(original: bytes, expected: str, label: str) -> None:
    if not isinstance(original, bytes):
        raise NativePatchError(f"M12 {label} patch expects original bytes")
    actual = hashlib.sha256(original).hexdigest()
    if actual != expected:
        raise NativePatchError(f"M12 original {label} SHA256 mismatch: {actual}")


def _verified_native_base(original: bytes) -> tuple[bytes, str]:
    _verify_input(original, ORIGINAL_CHUNK_SHA256, "native")
    base = _m11.build_native_chunk(original)
    actual = hashlib.sha256(base).hexdigest()
    if actual != M11_NATIVE_CHUNK_SHA256:
        raise NativePatchError(f"M12 frozen M11 native SHA256 mismatch: {actual}")
    try:
        source = base.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise NativePatchError("M12 frozen M11 native chunk is not UTF-8") from exc
    for number, anchor in enumerate(PATCH_ANCHORS, 1):
        count = source.count(anchor)
        if count != 1:
            raise NativePatchError(f"M12 anchor {number} must occur once; found {count}")
    return base, source


def _apply_native(source: str) -> bytes:
    derived = source
    for anchor, replacement in zip(PATCH_ANCHORS, PATCH_REPLACEMENTS):
        derived = derived.replace(anchor, replacement, 1)
    restored = derived
    for number in range(len(PATCH_ANCHORS) - 1, -1, -1):
        replacement = PATCH_REPLACEMENTS[number]
        count = restored.count(replacement)
        if count != 1:
            raise NativePatchError(f"M12 inverse anchor {number + 1} must occur once; found {count}")
        restored = restored.replace(replacement, PATCH_ANCHORS[number], 1)
    if restored != source:
        raise NativePatchError("M12 inverse did not recover the frozen M11 native source")
    return derived.encode("utf-8")


def build_native_chunk(original: bytes) -> bytes:
    """Preserve menu Escape and editable Tab paths, or fail strictly."""
    _, source = _verified_native_base(original)
    return _apply_native(source)


def patch_manifest(original: bytes) -> dict:
    """Report original/M11/M12 hashes and unique anchors in the M11 base."""
    base, source = _verified_native_base(original)
    derived = _apply_native(source)
    anchors = []
    for number, (anchor, replacement) in enumerate(zip(PATCH_ANCHORS, PATCH_REPLACEMENTS), 1):
        offset = source.index(anchor)
        anchors.append({
            "number": number,
            "count": 1,
            "characterOffset": offset,
            "byteOffset": len(source[:offset].encode("utf-8")),
            "line": source.count("\n", 0, offset) + 1,
            "anchorSha256": hashlib.sha256(anchor.encode("utf-8")).hexdigest(),
            "replacementSha256": hashlib.sha256(replacement.encode("utf-8")).hexdigest(),
        })
    return {
        "sourceSha256": ORIGINAL_CHUNK_SHA256,
        "baseSha256": M11_NATIVE_CHUNK_SHA256,
        "derivedSha256": hashlib.sha256(derived).hexdigest(),
        "sourceBytes": len(original),
        "baseBytes": len(base),
        "derivedBytes": len(derived),
        "anchors": anchors,
        "inverseToBaseExact": True,
        "inheritedPatchManifest": _m11.patch_manifest(original),
    }


def _verified_editor_base(original: bytes) -> bytes:
    _verify_input(original, ORIGINAL_EDITOR_CHUNK_SHA256, "editor")
    base = _m11.build_editor_chunk(original)
    actual = hashlib.sha256(base).hexdigest()
    if actual != M11_EDITOR_CHUNK_SHA256:
        raise NativePatchError(f"M12 frozen M11 editor SHA256 mismatch: {actual}")
    return base


# Ignore only the adjacent-selection step of image quick edit's opening Tab
# release. The native container still dispatches keyup and updates its inputs.
# The always-mounted empty positioning anchor is deliberately insufficient.
QUICK_EDIT_VISIBLE_FUNCTION = r'''function nvM12ImageQuickEditOpen(nvDoc){
  const nvFooter=nvDoc.querySelector(".mark-tab-edit-position #mark-editor-footer");
  const nvEditable=nvFooter&&nvFooter.querySelector('[contenteditable="true"]');
  if(!nvFooter||!nvEditable)return false;
  return [nvFooter,nvEditable].every(nvNode=>{
    if(nvNode.closest("[hidden],[inert]"))return false;
    const nvBounds=nvNode.getBoundingClientRect();
    const nvVisibility=nvDoc.defaultView.getComputedStyle(nvNode).visibility;
    return nvBounds.width>0&&nvBounds.height>0&&nvVisibility!=="hidden"&&nvVisibility!=="collapse";
  });
}'''

_EDITOR_TAB_UP_ANCHOR = 'case"Tab":this.editor.getSelectedShapes().length&&!e.altKey&&this.editor.selectAdjacentShape(e.shiftKey?"prev":"next")}}startEditingShape(e,t,i){'
_EDITOR_TAB_UP_REPLACEMENT = 'case"Tab":if(this.editor.getOnlySelectedShape()?.type==="c-image"&&(' + QUICK_EDIT_VISIBLE_FUNCTION + ')(this.editor.getContainer().ownerDocument))break;this.editor.getSelectedShapes().length&&!e.altKey&&this.editor.selectAdjacentShape(e.shiftKey?"prev":"next")}}startEditingShape(e,t,i){'
EDITOR_PATCH_ANCHORS = (_EDITOR_TAB_UP_ANCHOR,)
EDITOR_PATCH_REPLACEMENTS = (_EDITOR_TAB_UP_REPLACEMENT,)


def _verified_editor_source(original: bytes) -> tuple[bytes, str]:
    base = _verified_editor_base(original)
    try:
        source = base.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise NativePatchError("M12 frozen M11 editor chunk is not UTF-8") from exc
    for number, anchor in enumerate(EDITOR_PATCH_ANCHORS, 1):
        count = source.count(anchor)
        if count != 1:
            raise NativePatchError(f"M12 editor anchor {number} must occur once; found {count}")
    return base, source


def _apply_editor(source: str) -> bytes:
    derived = source.replace(_EDITOR_TAB_UP_ANCHOR, _EDITOR_TAB_UP_REPLACEMENT, 1)
    count = derived.count(_EDITOR_TAB_UP_REPLACEMENT)
    if count != 1:
        raise NativePatchError(f"M12 editor inverse anchor must occur once; found {count}")
    if derived.replace(_EDITOR_TAB_UP_REPLACEMENT, _EDITOR_TAB_UP_ANCHOR, 1) != source:
        raise NativePatchError("M12 editor inverse did not recover the frozen M11 editor source")
    return derived.encode("utf-8")


def build_editor_chunk(original: bytes) -> bytes:
    """Keep image quick edit open on its Tab release, preserving native keyup."""
    _, source = _verified_editor_source(original)
    return _apply_editor(source)


def editor_patch_manifest(original: bytes) -> dict:
    """Report the unique M12 keyup anchor and inherited M11 timer patch."""
    base, source = _verified_editor_source(original)
    derived = _apply_editor(source)
    offset = source.index(_EDITOR_TAB_UP_ANCHOR)
    return {
        "sourceSha256": ORIGINAL_EDITOR_CHUNK_SHA256,
        "baseSha256": M11_EDITOR_CHUNK_SHA256,
        "derivedSha256": hashlib.sha256(derived).hexdigest(),
        "sourceBytes": len(original),
        "baseBytes": len(base),
        "derivedBytes": len(derived),
        "anchors": [{
            "number": 1,
            "count": 1,
            "characterOffset": offset,
            "byteOffset": len(source[:offset].encode("utf-8")),
            "line": source.count("\n", 0, offset) + 1,
            "anchorSha256": hashlib.sha256(_EDITOR_TAB_UP_ANCHOR.encode("utf-8")).hexdigest(),
            "replacementSha256": hashlib.sha256(_EDITOR_TAB_UP_REPLACEMENT.encode("utf-8")).hexdigest(),
        }],
        "inverseToBaseExact": True,
        "inheritedPatchManifest": _m11.editor_patch_manifest(original),
    }
