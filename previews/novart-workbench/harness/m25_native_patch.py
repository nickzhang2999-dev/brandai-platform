"""Pin-checked M25 native image gestures around frozen M12 derivatives.

Only the opt-in M25 runtime serves the new native response. Captured originals,
M12 and M24 files stay untouched. Canvas writes use the original public Editor
methods and original components; native Undo remains the document authority.
"""

from __future__ import annotations

import hashlib

import m12_native_patch as _m12


NativePatchError = _m12.NativePatchError
ORIGINAL_CHUNK_SHA256 = "2dc5773410b0759fa63a05fc97fbf6c9f6e11d9423af40090eb8aa354ba25750"
ORIGINAL_CONTROLS_SHA256 = "c60663cb8fcb58ee821e1ababeea5ea296f3a780bf03c199ef0828bc5b66c410"
M12_NATIVE_CHUNK_SHA256 = "aa9c1b56e0ecabd3f1ea80b7d47f6b9b2e205f6226fe3abd285a2bbf4d4f68ef"


_ANGLE_CALLBACK_ANCHOR = 'r=e=>{if(void 0===e||!Number.isFinite(e))return;let i=a.getShape(t.id),r=(e-_3(i?i.rotation:0))*Math.PI/180,n=a.getSelectionPageBounds(),s=n?{x:n.x+n.w/2,y:n.y+n.h/2}:void 0;a.rotateShapesBy([t.id],r,s?{center:s}:void 0)};return(0,c.jsx)(_1'
_ANGLE_CALLBACK_REPLACEMENT = r'''nvM25AngleGesture=(0,d.useRef)(null),r=e=>{
  if(void 0===e||!Number.isFinite(e)||a.getInstanceState().isReadonly)return;
  const nvShape=a.getShape(t.id),nvIds=a.getSelectedShapeIds();
  if(!nvShape||nvShape.type!=="c-image"||nvIds.length!==1||nvIds[0]!==t.id)return;
  const nvDelta=(e-_3(nvShape.rotation))*Math.PI/180;
  if(Math.abs(nvDelta)<1e-10)return;
  const nvGesture=nvM25AngleGesture.current;
  if(!nvGesture||!nvGesture.marked){
    a.markHistoryStoppingPoint("novart-rotate-angle");
    if(nvGesture)nvGesture.marked=true;
  }
  const nvBounds=a.getSelectionPageBounds(),nvCenter=nvBounds?{x:nvBounds.x+nvBounds.w/2,y:nvBounds.y+nvBounds.h/2}:void 0;
  a.rotateShapesBy([t.id],nvDelta,nvCenter?{center:nvCenter}:void 0);
};return(0,c.jsx)(_1'''

_ANGLE_WRAPPER_ANCHOR = '"data-testid":eE.Hl.FlipRotateToolbar.Angle,children:(0,c.jsx)(v.YIz,'
_ANGLE_WRAPPER_REPLACEMENT = r'''"data-testid":eE.Hl.FlipRotateToolbar.Angle,
onPointerDownCapture:nvEvent=>{
  if(nvEvent.target.closest("input,textarea,[contenteditable='true']")){nvM25AngleGesture.current=null;return;}
  if(nvEvent.button!==0)return;
  nvM25AngleGesture.current={kind:"pointer",id:nvEvent.pointerId,marked:false};
},
onPointerUpCapture:()=>{nvM25AngleGesture.current=null;},
onPointerCancelCapture:()=>{nvM25AngleGesture.current=null;},
onKeyDownCapture:nvEvent=>{
  if(!["ArrowUp","ArrowDown","Enter"].includes(nvEvent.key)||nvEvent.isComposing||nvEvent.keyCode===229)return;
  const nvPrior=nvM25AngleGesture.current;
  if(!nvPrior||nvPrior.kind!=="keyboard"||nvPrior.key!==nvEvent.key)
    nvM25AngleGesture.current={kind:"keyboard",key:nvEvent.key,marked:false};
},
onKeyUpCapture:nvEvent=>{if(nvM25AngleGesture.current?.kind==="keyboard"&&nvM25AngleGesture.current.key===nvEvent.key)nvM25AngleGesture.current=null;},
onFocusCapture:nvEvent=>{if(nvEvent.target.closest("input,textarea,[contenteditable='true']"))nvM25AngleGesture.current=null;},
onBlurCapture:()=>{nvM25AngleGesture.current=null;},
children:(0,c.jsx)(v.YIz,'''


_ADJUST_REFS_ANCHOR = 'A=(0,d.useRef)(k),I=(0,d.useRef)(b);(0,d.useEffect)(()=>{A.current=k},[k]);'
_ADJUST_REFS_REPLACEMENT = r'''A=(0,d.useRef)(k),I=(0,d.useRef)(b);
const nvM25AdjustGesture=(0,d.useRef)(null),nvM25AdjustEpoch=(0,d.useRef)(0),nvM25AdjustMounted=(0,d.useRef)(true);
const nvM25AdjustRead=nvShape=>Object.fromEntries(Object.keys(h4).map(nvKey=>[nvKey,nvShape?.props.adjust?.[nvKey]??0]));
const nvM25AdjustUiKey=nvValues=>JSON.stringify(Object.keys(h4).map(nvKey=>nvValues[nvKey]??0));
const nvM25AdjustNative=i.getShape(t.id),nvM25AdjustNativeValues=nvM25AdjustRead(nvM25AdjustNative),nvM25AdjustNativeKey=nvM25AdjustUiKey(nvM25AdjustNativeValues);
const nvM25AdjustSource=nvM25AdjustNative?.props.originalUrl||nvM25AdjustNative?.props.url||"";
const nvM25AdjustIdentity=(0,d.useRef)({id:t.id,source:nvM25AdjustSource});
(0,d.useLayoutEffect)(()=>{
  if(!nvM25AdjustNative||nvM25AdjustNative.type!=="c-image")return;
  const nvChangedIdentity=nvM25AdjustIdentity.current.id!==t.id||nvM25AdjustIdentity.current.source!==nvM25AdjustSource;
  const nvChangedValues=nvM25AdjustUiKey(A.current)!==nvM25AdjustNativeKey;
  if(!nvChangedIdentity&&!nvChangedValues)return;
  nvM25AdjustIdentity.current={id:t.id,source:nvM25AdjustSource};
  nvM25AdjustGesture.current=null;
  nvM25AdjustEpoch.current++;
  A.current=nvM25AdjustNativeValues;
  if(nvChangedValues)S(nvM25AdjustNativeValues);
},[t.id,nvM25AdjustSource,nvM25AdjustNativeKey]);
(0,d.useEffect)(()=>{nvM25AdjustMounted.current=true;return()=>{nvM25AdjustMounted.current=false;nvM25AdjustEpoch.current++;nvM25AdjustGesture.current=null;};},[]);
'''

_ADJUST_WRITER_ANCHOR = 'let T=(0,d.useCallback)(e=>{if(!p.current)return;let t=Object.values(e).some(e=>0!==e);i.updateShapes([{id:p.current,type:"c-image",props:{adjust:function(e){if(!Object.values(e).some(e=>0!==e))return;let t={};for(let[a,i]of Object.entries(e))0!==i&&(t[a]=i);return t}(e),...t?{genType:h$.GH.adjust}:{}}}])},[i]);(0,d.useEffect)(()=>{T(k)},[k,T]);'
_ADJUST_WRITER_REPLACEMENT = r'''let T=(0,d.useCallback)(nvNext=>{
  const nvShape=i.getShape(t.id),nvIds=i.getSelectedShapeIds();
  if(!nvM25AdjustMounted.current||a.getState()!=="adjust"||i.getInstanceState().isReadonly||!nvShape||nvShape.type!=="c-image"||nvIds.length!==1||nvIds[0]!==t.id)return false;
  if(nvM25AdjustUiKey(nvM25AdjustRead(nvShape))===nvM25AdjustUiKey(nvNext))return false;
  const nvGesture=nvM25AdjustGesture.current;
  if(!nvGesture||!nvGesture.marked){
    i.markHistoryStoppingPoint("novart-adjust-image");
    if(nvGesture)nvGesture.marked=true;
  }
  const nvNonzero=Object.values(nvNext).some(nvValue=>0!==nvValue),nvAdjust={};
  for(const [nvKey,nvValue]of Object.entries(nvNext))if(nvValue!==0)nvAdjust[nvKey]=nvValue;
  nvM25AdjustEpoch.current++;
  i.updateShapes([{id:t.id,type:"c-image",props:{adjust:nvNonzero?nvAdjust:void 0,...nvNonzero?{genType:h$.GH.adjust}:{}}}]);
  return true;
},[i,a,t.id]);'''

_ADJUST_RESET_ANCHOR = 'let M=(0,d.useCallback)(()=>{o(!1),A.current=h4,S(h4),p.current&&i.updateShapes([{id:p.current,type:"c-image",props:{adjust:void 0}}])},[i]),'
_ADJUST_RESET_REPLACEMENT = r'''let M=(0,d.useCallback)(()=>{
  nvM25AdjustGesture.current=null;
  const nvNext={...h4};
  A.current=nvNext;
  T(nvNext);
  o(!1);S(nvNext);
},[T]),'''

_ADJUST_CHANGE_ANCHOR = 'E=(0,d.useCallback)((e,t)=>{let a=s?"auto":"others",i=h6[r].id;(0,a3.yc)({original_media_url:b,mode:a,section:i}),f.current=!0,o(!1),S(a=>({...a,[e]:t}))},[b,s,r]),'
_ADJUST_CHANGE_REPLACEMENT = r'''E=(0,d.useCallback)((nvKey,nvValue)=>{
  if(!Object.hasOwn(h4,nvKey)||!Number.isFinite(nvValue))return;
  const nvNext={...nvM25AdjustRead(i.getShape(t.id)),[nvKey]:nvValue};
  A.current=nvNext;
  if(T(nvNext)){
    const nvMode=s?"auto":"others",nvSection=h6[r].id;
    (0,a3.yc)({original_media_url:b,mode:nvMode,section:nvSection});
    f.current=true;o(false);
  }
  S(nvNext);
},[b,s,r,i,t.id,T]),'''

_ADJUST_AUTO_RESULT_ANCHOR = 'S(t),f.current=!0,o(!0);let a=null,i=0;'
_ADJUST_AUTO_RESULT_REPLACEMENT = 'nvM25AdjustGesture.current=null;A.current=t;T(t);S(t),f.current=!0,o(!0);let a=null,i=0;'
_ADJUST_AUTO_CALLBACK_DEPS_ANCHOR = 'setTimeout(()=>{m.current=!1},500)},[]);(0,d.useEffect)(()=>()=>{j()},[j]);'
_ADJUST_AUTO_CALLBACK_DEPS_REPLACEMENT = 'setTimeout(()=>{m.current=!1},500)},[T]);(0,d.useEffect)(()=>()=>{j()},[j]);'

_ADJUST_AUTO_BUTTON_ANCHOR = 'let B=(0,d.useCallback)(async()=>{let e=!s,t=h6[r].id;if((0,a3.yc)({original_media_url:b,mode:e?"auto":"others",section:t}),!x)return;let a=x.props.originalUrl||x.props.url;if(a){if(C)return void(0,hH.s4)(x.id,L);try{let e=new hW.Z;await e.loadImage(a);let t=e.autoFix();e.dispose(),L(t)}catch(e){console.error("Auto adjust failed:",e)}}},[x,C,L,b,s,r]);'
_ADJUST_AUTO_BUTTON_REPLACEMENT = r'''let B=(0,d.useCallback)(async()=>{
  const nvShape=i.getShape(t.id),nvIds=i.getSelectedShapeIds();
  if(!nvM25AdjustMounted.current||!nvShape||nvShape.type!=="c-image"||nvIds.length!==1||nvIds[0]!==t.id||a.getState()!=="adjust")return;
  const nvSource=nvShape.props.originalUrl||nvShape.props.url;
  if(!nvSource)return;
  const nvToken=++nvM25AdjustEpoch.current,nvTarget=t.id,nvBaseline=JSON.stringify({rotation:nvShape.rotation,props:nvShape.props});
  const nvApply=nvResult=>{
    const nvCurrent=i.getShape(nvTarget),nvSelected=i.getSelectedShapeIds();
    if(!nvM25AdjustMounted.current||nvM25AdjustEpoch.current!==nvToken||a.getState()!=="adjust"||!nvCurrent||nvCurrent.type!=="c-image"||(nvCurrent.props.originalUrl||nvCurrent.props.url)!==nvSource||JSON.stringify({rotation:nvCurrent.rotation,props:nvCurrent.props})!==nvBaseline||nvSelected.length!==1||nvSelected[0]!==nvTarget)return;
    L(nvResult);
  };
  (0,a3.yc)({original_media_url:b,mode:!s?"auto":"others",section:h6[r].id});
  if(C)return void(0,hH.s4)(nvTarget,nvApply);
  let nvProcessor;
  try{nvProcessor=new hW.Z;await nvProcessor.loadImage(nvSource);const nvResult=nvProcessor.autoFix();nvApply(nvResult);}
  catch(nvProblem){console.error("Auto adjust failed:",nvProblem);}
  finally{nvProcessor?.dispose();}
},[i,t.id,a,C,L,b,s,r]);'''

_ADJUST_SLIDER_WRAPPER_ANCHOR = '"data-testid":`adjust-slider-${e.key}`,children:(0,c.jsx)(v.Apm,'
_ADJUST_SLIDER_WRAPPER_REPLACEMENT = r'''"data-testid":`adjust-slider-${e.key}`,
onPointerDownCapture:nvEvent=>{
  const nvRole=nvEvent.target.closest('[role="slider"]');
  if(nvEvent.button!==0||!nvRole||nvRole.getAttribute("aria-disabled")==="true")return;
  nvM25AdjustGesture.current={kind:"pointer",id:nvEvent.pointerId,key:e.key,marked:false};
},
onPointerUpCapture:()=>{if(nvM25AdjustGesture.current?.kind==="pointer")nvM25AdjustGesture.current=null;},
onPointerCancelCapture:()=>{if(nvM25AdjustGesture.current?.kind==="pointer")nvM25AdjustGesture.current=null;},
children:(0,c.jsx)(v.Apm,'''

_ADJUST_SLIDER_END_ANCHOR = 'onChange:t=>E(e.key,t),onDoubleClick:()=>E(e.key,0)'
_ADJUST_SLIDER_END_REPLACEMENT = 'onChange:t=>E(e.key,t),onChangeEnd:()=>{if(nvM25AdjustGesture.current?.kind==="pointer")nvM25AdjustGesture.current=null;},onDoubleClick:()=>E(e.key,0)'

# A display-canvas cache hit must invalidate the same two rendered-image
# caches as the following fresh branch. Otherwise Undo can cache the full
# source in ExtEditor and Redo display the crop while its pending mention
# still reads the full source. Preserve original CB and metadata behavior.
# Rename the block-local cached entry before using the outer ExtEditor `e`:
# the original `let e` would otherwise shadow that editor and throw on a hit.
_IMAGE_PIPELINE_CACHE_ANCHOR = 'if(!(a&&y)){let e,a=(r=t.id,(e=tt.get(r))&&e.sig===l&&0!==e.canvas.width?(tt.delete(r),tt.set(r,e),e.canvas):null);if(a){tr.set(t.id,n),c(null),u(a),g(n),h(e=>e+1),(0,eK.CB)(t.id);return}}let d=!1;return e.deleteRenderedImageData(t.id),'
_IMAGE_PIPELINE_CACHE_REPLACEMENT = 'if(!(a&&y)){let nvM25CachedEntry,a=(r=t.id,(nvM25CachedEntry=tt.get(r))&&nvM25CachedEntry.sig===l&&0!==nvM25CachedEntry.canvas.width?(tt.delete(r),tt.set(r,nvM25CachedEntry),nvM25CachedEntry.canvas):null);if(a){e.deleteRenderedImageData(t.id),tr.set(t.id,n),c(null),u(a),g(n),h(e=>e+1),(0,eK.CB)(t.id);return}}let d=!1;return e.deleteRenderedImageData(t.id),'


PATCHES = (
    ("angle first meaningful delta", _ANGLE_CALLBACK_ANCHOR, _ANGLE_CALLBACK_REPLACEMENT),
    ("angle pointer and keyboard gesture lifetime", _ANGLE_WRAPPER_ANCHOR, _ANGLE_WRAPPER_REPLACEMENT),
    ("adjust native to UI authority", _ADJUST_REFS_ANCHOR, _ADJUST_REFS_REPLACEMENT),
    ("adjust explicit intent writer", _ADJUST_WRITER_ANCHOR, _ADJUST_WRITER_REPLACEMENT),
    ("adjust reset single intent", _ADJUST_RESET_ANCHOR, _ADJUST_RESET_REPLACEMENT),
    ("adjust slider original intent", _ADJUST_CHANGE_ANCHOR, _ADJUST_CHANGE_REPLACEMENT),
    ("adjust original automatic result intent", _ADJUST_AUTO_RESULT_ANCHOR, _ADJUST_AUTO_RESULT_REPLACEMENT),
    ("adjust automatic result current writer", _ADJUST_AUTO_CALLBACK_DEPS_ANCHOR, _ADJUST_AUTO_CALLBACK_DEPS_REPLACEMENT),
    ("adjust automatic result generation scope", _ADJUST_AUTO_BUTTON_ANCHOR, _ADJUST_AUTO_BUTTON_REPLACEMENT),
    ("adjust original pointer gesture lifetime", _ADJUST_SLIDER_WRAPPER_ANCHOR, _ADJUST_SLIDER_WRAPPER_REPLACEMENT),
    ("adjust original pointer completion", _ADJUST_SLIDER_END_ANCHOR, _ADJUST_SLIDER_END_REPLACEMENT),
    ("cached image display invalidates native reference render cache", _IMAGE_PIPELINE_CACHE_ANCHOR, _IMAGE_PIPELINE_CACHE_REPLACEMENT),
)


def _verify(original: bytes, expected: str, label: str) -> None:
    if not isinstance(original, bytes):
        raise NativePatchError(f"M25 {label} expects captured bytes")
    actual = hashlib.sha256(original).hexdigest()
    if actual != expected:
        raise NativePatchError(f"M25 {label} source SHA256 mismatch: {actual}")


def _base(original: bytes, controls_original: bytes) -> tuple[bytes, str]:
    _verify(original, ORIGINAL_CHUNK_SHA256, "native")
    _verify(controls_original, ORIGINAL_CONTROLS_SHA256, "controls")
    base = _m12.build_native_chunk(original)
    actual = hashlib.sha256(base).hexdigest()
    if actual != M12_NATIVE_CHUNK_SHA256:
        raise NativePatchError(f"M25 frozen M12 native SHA256 mismatch: {actual}")
    try:
        source = base.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise NativePatchError("M25 M12 native base is not UTF-8") from exc
    for number, (label, anchor, _) in enumerate(PATCHES, 1):
        count = source.count(anchor)
        if count != 1:
            raise NativePatchError(f"M25 anchor {number} ({label}) must occur once; found {count}")
    return base, source


def _apply(source: str) -> bytes:
    derived = source
    for number, (label, anchor, replacement) in enumerate(PATCHES, 1):
        count = derived.count(anchor)
        if count != 1:
            raise NativePatchError(f"M25 sequential anchor {number} ({label}) must occur once; found {count}")
        derived = derived.replace(anchor, replacement, 1)
    restored = derived
    for number in range(len(PATCHES) - 1, -1, -1):
        label, anchor, replacement = PATCHES[number]
        count = restored.count(replacement)
        if count != 1:
            raise NativePatchError(f"M25 inverse anchor {number + 1} ({label}) must occur once; found {count}")
        restored = restored.replace(replacement, anchor, 1)
    if restored != source:
        raise NativePatchError("M25 inverse did not recover frozen M12 native bytes")
    return derived.encode("utf-8")


def build_native_chunk(original: bytes, controls_original: bytes) -> bytes:
    """Return the M25 derivative only after both source pins and base pass."""
    _, source = _base(original, controls_original)
    return _apply(source)


def patch_manifest(original: bytes, controls_original: bytes) -> dict:
    """Reviewable source pins, unique bounded changes and exact inverse proof."""
    base, source = _base(original, controls_original)
    derived = _apply(source)
    anchors = []
    for number, (label, anchor, replacement) in enumerate(PATCHES, 1):
        offset = source.index(anchor)
        anchors.append({
            "number": number,
            "label": label,
            "count": 1,
            "characterOffset": offset,
            "byteOffset": len(source[:offset].encode("utf-8")),
            "line": source.count("\n", 0, offset) + 1,
            "anchor": anchor,
            "anchorSha256": hashlib.sha256(anchor.encode("utf-8")).hexdigest(),
            "replacementSha256": hashlib.sha256(replacement.encode("utf-8")).hexdigest(),
        })
    return {
        "sourceSha256": ORIGINAL_CHUNK_SHA256,
        "controlsSourceSha256": ORIGINAL_CONTROLS_SHA256,
        "controlsModified": False,
        "baseSha256": M12_NATIVE_CHUNK_SHA256,
        "derivedSha256": hashlib.sha256(derived).hexdigest(),
        "sourceBytes": len(original),
        "baseBytes": len(base),
        "derivedBytes": len(derived),
        "anchors": anchors,
        "inverseToBaseExact": True,
        "inheritedPatchManifest": _m12.patch_manifest(original),
        "cropHistoryPatch": False,
        "imageDisplayCacheRepair": True,
        "directStoreWrites": False,
        "privateReactOrLexicalWrites": False,
    }
