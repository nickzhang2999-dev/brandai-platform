"""Audited, in-memory M11 derivatives of captured native toolbar/editor chunks.

The builder never reads or writes files. The M11 runtime supplies original bytes
and serves the returned bytes only for its opt-in canvas entry. A changed source
or a missing/non-unique anchor is a hard failure, not an approximate patch.
"""

from __future__ import annotations

import hashlib


ORIGINAL_CHUNK_SHA256 = "2dc5773410b0759fa63a05fc97fbf6c9f6e11d9423af40090eb8aa354ba25750"
ORIGINAL_EDITOR_CHUNK_SHA256 = "99079b08341259acf30d9d0e834f1dca74d8ce3b52c3e8e905f8b1ec7c040101"


class NativePatchError(ValueError):
    """The captured native source does not satisfy this exact M11 patch."""


# Kept as a readable pure function so the no-op proof can be checked separately
# from React. Unknown/inherited sizes are deliberately not assumed to be equal.
UNIFORM_FONT_SIZE_FUNCTION = r"""function nvM11UniformFontSize(nvShapes,nvSize){
  const nvWanted=Number(nvSize);
  if(!Number.isFinite(nvWanted)||nvWanted<1||nvWanted>1000||!Array.isArray(nvShapes))return false;
  const nvTargets=nvShapes.filter(nvShape=>nvShape&&nvShape.type==="text");
  if(!nvTargets.length)return false;
  return nvTargets.every(nvShape=>{
    const nvRichText=nvShape.props&&nvShape.props.richText;
    if(!nvRichText||!Array.isArray(nvRichText.content))return false;
    let nvSeen=false,nvSame=true;
    function nvWalk(nvNode){
      if(!nvNode||!nvSame)return;
      if(nvNode.type==="text"&&typeof nvNode.text==="string"&&nvNode.text.length>0){
        nvSeen=true;
        const nvMark=Array.isArray(nvNode.marks)?nvNode.marks.find(nvItem=>nvItem&&nvItem.type==="textStyle"):null;
        const nvValue=nvMark&&nvMark.attrs&&nvMark.attrs.fontSize;
        const nvText=typeof nvValue==="string"?nvValue.trim():"";
        if(!/^(?:\d+(?:\.\d+)?|\.\d+)(?:px)?$/i.test(nvText)||Number(nvText.replace(/px$/i,""))!==nvWanted)nvSame=false;
      }
      if(Array.isArray(nvNode.content))nvNode.content.forEach(nvWalk);
    }
    nvWalk(nvRichText);
    return nvSeen&&nvSame;
  });
}"""


_SYNC_ANCHOR = 'p=(null==m?void 0:m.id)||null;if((0,d.useEffect)(()=>{if(p!==u.current){let e="";if(m){let t=a.getTextStyle(m);e=nL(null==t?void 0:t.fontSize)}l(e),u.current=p}},[p,m,a]),!m)return null;'
_SYNC_REPLACEMENT = 'p=(null==m?void 0:m.id)||null,nvM11NativeSize=m?nL(a.getTextStyle(m)?.fontSize):"";if((0,d.useEffect)(()=>{if(!u.current||u.current.id!==p||u.current.fontSize!==nvM11NativeSize){l(nvM11NativeSize),u.current={id:p,fontSize:nvM11NativeSize}}},[p,nvM11NativeSize]),!m)return null;'

_CONFIRM_ANCHOR = 'let g=e=>{l(e),r.isSelectionMode&&r.restoreSelection(),t.executeCommand(r4.j.applyTextStyle.id,{fontSize:`${e}px`})};return(0,c.jsx)(nU,'
_CONFIRM_REPLACEMENT = UNIFORM_FONT_SIZE_FUNCTION + '\nlet g=nvSize=>{l(nvSize),r.isSelectionMode&&r.restoreSelection();if(null!==e.getEditingShapeId()||!nvM11UniformFontSize(e.getSelectedShapes(),nvSize))t.executeCommand(r4.j.applyTextStyle.id,{fontSize:`${nvSize}px`})};return(0,c.jsx)(nU,'

# Only suppress the existing selected-object toolbar while the original drawing
# tool is active. Keep native selection, shape properties and history untouched.
_TOOLBAR_ANCHOR = 'if(0===y.length||e.isIn("select.translating")||e.isIn("select.rotating")||e.isIn("select.resizing")||!e.getSelectionScreenBounds()||N||S||A)return null;'
_TOOLBAR_REPLACEMENT = 'if("c-draw"===e.getCurrentToolId()||0===y.length||e.isIn("select.translating")||e.isIn("select.rotating")||e.isIn("select.resizing")||!e.getSelectionScreenBounds()||N||S||A)return null;'

# Use the captured library's existing render tracker so this component observes
# native selected-shape updates independently of its parent toolbar rendering.
_OBSERVER_OPEN_ANCHOR = 'nD=()=>{let e=(0,w.hGv)(),t=(0,N.Y)(),a=t.getExtEditor(),i=e.getSelectedShapes();'
_OBSERVER_OPEN_REPLACEMENT = 'nD=(0,w.u4I)(()=>{let e=(0,w.hGv)(),t=(0,N.Y)(),a=t.getExtEditor(),i=e.getSelectedShapes();'
_OBSERVER_CLOSE_ANCHOR = 'a.focusTextSelection()}}})},nF=e=>{'
_OBSERVER_CLOSE_REPLACEMENT = 'a.focusTextSelection()}}})}),nF=e=>{'

PATCH_ANCHORS = (_SYNC_ANCHOR, _CONFIRM_ANCHOR, _TOOLBAR_ANCHOR,
                 _OBSERVER_OPEN_ANCHOR, _OBSERVER_CLOSE_ANCHOR)


def _verified_source(original: bytes) -> str:
    if not isinstance(original, bytes):
        raise NativePatchError("M11 native patch expects original bytes")
    digest = hashlib.sha256(original).hexdigest()
    if digest != ORIGINAL_CHUNK_SHA256:
        raise NativePatchError(f"M11 original chunk SHA256 mismatch: {digest}")
    try:
        source = original.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise NativePatchError("M11 original chunk is not UTF-8") from exc
    for number, anchor in enumerate(PATCH_ANCHORS, 1):
        count = source.count(anchor)
        if count != 1:
            raise NativePatchError(f"M11 anchor {number} must occur once; found {count}")
    return source


def build_native_chunk(original: bytes) -> bytes:
    """Return local nD changes/tracking and one sX guard, or fail strictly."""
    source = _verified_source(original)
    derived = source.replace(_SYNC_ANCHOR, _SYNC_REPLACEMENT, 1)
    derived = derived.replace(_CONFIRM_ANCHOR, _CONFIRM_REPLACEMENT, 1)
    derived = derived.replace(_TOOLBAR_ANCHOR, _TOOLBAR_REPLACEMENT, 1)
    derived = derived.replace(_OBSERVER_OPEN_ANCHOR, _OBSERVER_OPEN_REPLACEMENT, 1)
    derived = derived.replace(_OBSERVER_CLOSE_ANCHOR, _OBSERVER_CLOSE_REPLACEMENT, 1)
    return derived.encode("utf-8")


def patch_manifest(original: bytes) -> dict:
    """Return source/derived hashes and exact anchor positions for evidence."""
    source = _verified_source(original)
    derived = build_native_chunk(original)
    anchors = []
    for number, anchor in enumerate(PATCH_ANCHORS, 1):
        offset = source.index(anchor)
        anchors.append({
            "number": number,
            "count": 1,
            "characterOffset": offset,
            "byteOffset": len(source[:offset].encode("utf-8")),
        })
    return {
        "sourceSha256": ORIGINAL_CHUNK_SHA256,
        "derivedSha256": hashlib.sha256(derived).hexdigest(),
        "sourceBytes": len(original),
        "derivedBytes": len(derived),
        "anchors": anchors,
    }


# Scope the listener to this rich editor's existing 100 ms initialization timer.
# Actual document pointer events have Node targets; composedPath also preserves
# events originating inside a nested field if the target has been retargeted.
# Synthetic dispatches do not replace a genuine user's next pointer gesture.
PENDING_EDITOR_FOCUS_FUNCTION = r"""function nvM11PendingEditorFocus(nvDoc,nvField,nvSchedule,nvClear,nvFocus,nvReset){
  let nvPending=true,nvListening=false,nvTimer;
  function nvDetach(){
    if(nvListening){nvDoc.removeEventListener("pointerdown",nvPointerDown,true);nvListening=false;}
  }
  function nvPointerDown(nvEvent){
    if(!nvPending||!nvEvent.isTrusted)return;
    const nvCurrentField=nvField(),nvTarget=nvEvent.target;
    if(nvCurrentField&&(nvCurrentField.contains(nvTarget)||(typeof nvEvent.composedPath==="function"&&nvEvent.composedPath().includes(nvCurrentField))))return;
    nvPending=false;
    nvClear(nvTimer);
    nvReset();
    nvDetach();
  }
  nvDoc.addEventListener("pointerdown",nvPointerDown,true);
  nvListening=true;
  nvTimer=nvSchedule(()=>{
    if(!nvPending)return;
    nvPending=false;
    nvDetach();
    nvFocus();
    nvReset();
  },100);
  return ()=>{nvPending=false;nvClear(nvTimer);nvDetach();};
}"""

_EDITOR_FOCUS_ANCHOR = 's=u.timers.setTimeout(()=>{S.current.caretPosition||S.current.selectAll?n.commands.focus():n.commands.focus("end"),S.current.selectAll=!1,S.current.caretPosition=null},100);return x.current=n,()=>{x.current=null,clearTimeout(s),n.destroy()}'
_EDITOR_FOCUS_REPLACEMENT = 's=(' + PENDING_EDITOR_FOCUS_FUNCTION + ')(u.getContainerDocument(),()=>b.current,(nvCallback,nvDelay)=>u.timers.setTimeout(nvCallback,nvDelay),nvTimer=>clearTimeout(nvTimer),()=>{S.current.caretPosition||S.current.selectAll?n.commands.focus():n.commands.focus("end")},()=>{S.current.selectAll=!1,S.current.caretPosition=null});return x.current=n,()=>{x.current=null,s(),n.destroy()}'
EDITOR_PATCH_ANCHORS = (_EDITOR_FOCUS_ANCHOR,)


def _verified_editor_source(original: bytes) -> str:
    if not isinstance(original, bytes):
        raise NativePatchError("M11 editor patch expects original bytes")
    digest = hashlib.sha256(original).hexdigest()
    if digest != ORIGINAL_EDITOR_CHUNK_SHA256:
        raise NativePatchError(f"M11 original editor chunk SHA256 mismatch: {digest}")
    try:
        source = original.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise NativePatchError("M11 original editor chunk is not UTF-8") from exc
    for number, anchor in enumerate(EDITOR_PATCH_ANCHORS, 1):
        count = source.count(anchor)
        if count != 1:
            raise NativePatchError(f"M11 editor anchor {number} must occur once; found {count}")
    return source


def build_editor_chunk(original: bytes) -> bytes:
    """Cancel only pending initial editor focus after a new outside pointer."""
    source = _verified_editor_source(original)
    return source.replace(_EDITOR_FOCUS_ANCHOR, _EDITOR_FOCUS_REPLACEMENT, 1).encode("utf-8")


def editor_patch_manifest(original: bytes) -> dict:
    """Return exact editor derivative hashes and the unique timer anchor."""
    source = _verified_editor_source(original)
    derived = build_editor_chunk(original)
    anchors = []
    for number, anchor in enumerate(EDITOR_PATCH_ANCHORS, 1):
        offset = source.index(anchor)
        anchors.append({
            "number": number,
            "count": 1,
            "characterOffset": offset,
            "byteOffset": len(source[:offset].encode("utf-8")),
        })
    return {
        "sourceSha256": ORIGINAL_EDITOR_CHUNK_SHA256,
        "derivedSha256": hashlib.sha256(derived).hexdigest(),
        "sourceBytes": len(original),
        "derivedBytes": len(derived),
        "anchors": anchors,
    }
