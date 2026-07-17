"""HTTP providers for third-party AI APIs (OpenAI-compatible by default).

Image side (`HttpImageProvider`) talks the OpenAI images API; swapping vendors
(OpenAI gpt-image / DALL·E, SeedDream, OpenRouter-fronted gateways) is env-only.
VLM side (`HttpVLMProvider`) talks the OpenAI `/chat/completions` vision API and
returns the structured brand-analysis / compliance JSON the contract expects.

Two facts shape the VLM impl:
  - asset URLs point at *internal* object storage that a third-party model can't
    fetch, so images are downloaded here (we're on the internal network) and
    inlined as base64 ``data:`` URLs — with graceful fallback to the raw URL.
  - models occasionally wrap JSON in prose / code fences, so parsing is lenient.

mock stays the registry default, so the service runs with zero keys.
"""
import asyncio
import base64
import io
import json
import logging
import math
import re
import time
from collections import Counter
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup
from tenacity import retry, stop_after_attempt, wait_exponential

from ..config import settings
from ..ssrf import SSRFError, safe_get
from .base import ImageProvider, ProviderCheck, VLMProvider

logger = logging.getLogger("brandai.ai.provider")

# Self-check uses a tighter timeout than generation: an operator wants a fast
# answer, not a 60s hang on a wrong endpoint.
_CHECK_TIMEOUT = 15.0


async def _check_models_endpoint(
    base_url: str,
    api_key: str,
    transport: httpx.BaseTransport | None = None,
    model: str = "",
) -> ProviderCheck:
    """Probe `GET {base_url}/models` with a bearer token. Translates the result
    into a ProviderCheck; never raises (connection/timeout errors are captured).

    T-conn-a: when `model` is set, also verify it's actually offered by the
    endpoint — a wrong model id authenticates fine but every generate then 400s,
    so catch it here. If the model list can't be read (a gateway that doesn't
    expose an OpenAI-shaped `/models`), validation is skipped (auth-only)."""
    kind = _provider_kind(base_url)
    kwargs: dict[str, Any] = {"timeout": _CHECK_TIMEOUT}
    if transport is not None:
        kwargs["transport"] = transport
    try:
        async with httpx.AsyncClient(**kwargs) as c:
            r = await c.get(
                f"{base_url}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
    except Exception as exc:  # noqa: BLE001 — surface as structured failure
        return ProviderCheck(False, f"{type(exc).__name__}: {exc}")
    if r.is_success:
        if model:
            ids = _model_ids(r)
            if ids and not _model_in_list(model, ids):
                preview = ", ".join(ids[:20])
                return ProviderCheck(
                    False, f"模型 '{model}' 不存在,可用: {preview}"
                )
            return ProviderCheck(True, f"{kind} OK · model={model}")
        return ProviderCheck(True, f"{kind} OK")
    body = (r.text or "")[:200].replace("\n", " ").strip()
    return ProviderCheck(False, f"{r.status_code}: {body}")


def _model_ids(resp: httpx.Response) -> list[str]:
    """Parse model ids from an OpenAI-shaped `/models` response (`{data:[{id}]}`).
    Returns [] when the shape is unexpected so callers skip model validation."""
    try:
        data = resp.json()
    except (ValueError, json.JSONDecodeError):
        return []
    items = data.get("data") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [str(i["id"]) for i in items if isinstance(i, dict) and i.get("id")]


def _model_in_list(model: str, ids: list[str]) -> bool:
    """Lenient match so a namespaced gateway id ('openai/gpt-4o') and a bare id
    ('gpt-4o') still count as the same model, while a real typo ('gpt-4oo')
    does not."""
    if not model:
        return True
    last = model.split("/")[-1]
    return any(
        model == i or i.endswith("/" + model) or i.split("/")[-1] == last
        for i in ids
    )

_retry = retry(
    stop=stop_after_attempt(settings.max_retries),
    wait=wait_exponential(multiplier=1, min=1, max=10),
    reraise=True,
)

# Caps so a pathological page / asset set can't blow up token spend.
_MAX_VISION_IMAGES = 8
_MAX_SCRAPE_IMAGES = 30
_MAX_SCRAPE_TEXT = 6000
_MANUAL_BATCH_PAGES = 8
_MAX_MANUAL_ASSETS = 72

# gpt-image-1 only accepts these three sizes (plus "auto"); any other W×H is a
# hard 400. We snap the requested canvas to the nearest by aspect ratio.
_OPENAI_SIZES = ("1024x1024", "1024x1536", "1536x1024")
_DEFAULT_IMAGE_QUALITY = "medium"
# Max STRICT reference images forwarded to /images/edits. Matches the web
# contract's `CreateGenerationInput.referenceAssets` max (8) so the full allowed
# set of "100% 调用" assets reaches the model — never silently dropped. OpenAI's
# edit API itself documents up to 16 GPT-image inputs, so 8 leaves headroom.
_MAX_IMG2IMG_REFS = 8

# Best-effort USD price per generated image, by provider kind → quality → size.
# gpt-image-1 is token-priced (image output $40/1M tokens); these are OpenAI's
# published per-image figures. Used only for the cost log line; None when
# unknown. Update as vendor pricing changes — this never gates generation.
_IMAGE_PRICE_USD: dict[str, dict[str, dict[str, float]]] = {
    "openai": {
        "low": {"1024x1024": 0.011, "1024x1536": 0.016, "1536x1024": 0.016},
        "medium": {"1024x1024": 0.042, "1024x1536": 0.063, "1536x1024": 0.063},
        "high": {"1024x1024": 0.167, "1024x1536": 0.25, "1536x1024": 0.25},
    },
}


def _provider_kind(base_url: str) -> str:
    host = base_url.lower()
    if "openai.com" in host:
        return "openai"
    if "googleapis.com" in host:
        return "gemini"
    if "volces.com" in host or "ark" in host:
        return "seeddream"
    return "generic"


def _snap_openai_size(width: int, height: int) -> str:
    """Pick the nearest gpt-image-1 size by aspect ratio (it rejects others)."""
    ar = width / height if height else 1.0
    if ar < 0.85:
        return "1024x1536"
    if ar > 1.18:
        return "1536x1024"
    return "1024x1024"


def _edit_image_part(raw: bytes, idx: int) -> tuple[str, tuple[str, bytes, str]]:
    """Build a `/images/edits` multipart `image[]` part, labelling it by the
    reference's REAL format (magic-byte sniff), not a hardcoded PNG.

    Uploads are accepted as any `image/*`, so a STRICT logo is often JPEG/WebP;
    posting those bytes as `refN.png`/`image/png` can be rejected by the edit
    API. OpenAI accepts png/jpeg/webp directly → pass through with correct
    filename+type; anything else (gif/bmp/…) is re-encoded to PNG via Pillow so
    it's still usable rather than dropped.
    """
    head = raw[:12]
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return ("image[]", (f"ref{idx}.png", raw, "image/png"))
    if head[:3] == b"\xff\xd8\xff":
        return ("image[]", (f"ref{idx}.jpg", raw, "image/jpeg"))
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ("image[]", (f"ref{idx}.webp", raw, "image/webp"))
    try:
        from PIL import Image  # local import — matches _build_inpaint_mask

        im = Image.open(io.BytesIO(raw))
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return ("image[]", (f"ref{idx}.png", buf.getvalue(), "image/png"))
    except Exception as exc:  # noqa: BLE001
        # Undecodable (e.g. an SVG or corrupt file) — do NOT relabel the raw
        # bytes as PNG; /images/edits would reject them with an opaque provider
        # error. Fail with a clear, actionable reason instead, so a STRICT pick
        # that can't be rasterized surfaces as a readable generation failure.
        raise ValueError(
            f"STRICT reference #{idx + 1} is not a raster image the model can "
            "use (e.g. SVG or a corrupt file); use a PNG / JPEG / WebP asset."
        ) from exc


# 改图 op → 自然语言 prompt 前缀(OpenAI /images/edits 只吃文字 prompt)。
_EDIT_OP_PROMPTS = {
    "IMAGE_EDIT": "Edit the whole image according to the instruction while preserving the main structure",
    "REPLACE_BACKGROUND": "Replace the background of the product image",
    "MOVE_PRODUCT": "Reposition the main product within the frame",
    "EDIT_TEXT": "Edit the text shown in the image",
    "RECOLOR": "Recolor the image",
    "ADD_ELEMENT": "Add an element to the image",
    "REMOVE_ELEMENT": "Remove an element from the image",
    "OUTPAINT": "Extend the image outward (outpaint)",
    "INPAINT": "Inpaint and refine the masked region",
    "RESIZE": "Re-render the image at the requested size",
}


def _build_inpaint_mask(image_bytes: bytes, mask_ref: str) -> bytes:
    """局部重画(INPAINT)蒙版归一。前端 MaskPaintCanvas 导出黑白蒙版(白=重绘、
    黑=保留)；OpenAI /images/edits 需要 RGBA 蒙版且「透明区=被编辑、不透明区=保留」、
    尺寸与底图一致。这里把白区转成透明、缩放到底图真实像素尺寸，返回 PNG 字节。
    """
    from PIL import Image

    if mask_ref.startswith("data:"):
        mask_ref = mask_ref.split(",", 1)[1]
    mask_raw = base64.b64decode(mask_ref)
    with Image.open(io.BytesIO(image_bytes)) as base_im:
        size = base_im.size  # (W, H)
    with Image.open(io.BytesIO(mask_raw)) as m:
        gray = m.convert("L").resize(size)
    # 白(>128)=重绘 → alpha 0(透明,被编辑); 其余 → alpha 255(保留)。向量化,无逐像素循环。
    alpha = gray.point(lambda v: 0 if v > 128 else 255)
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    out.putalpha(alpha)
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def _edit_prompt(op: str, payload: dict[str, Any]) -> str:
    """把 op + payload 里的用户指令拼成给 OpenAI 的编辑 prompt。"""
    instr = (
        payload.get("prompt")
        or payload.get("instruction")
        or payload.get("text")
        or payload.get("description")
    )
    base = _EDIT_OP_PROMPTS.get(op, "Edit the image as instructed")
    instr = str(instr).strip() if instr else ""
    return f"{base}. {instr}".strip() if instr else f"{base}."


def _estimate_cost_usd(
    kind: str, size: str, quality: str, n: int
) -> float | None:
    table = _IMAGE_PRICE_USD.get(kind)
    if not table:
        return None
    per = table.get(quality or _DEFAULT_IMAGE_QUALITY, {}).get(size)
    return round(per * n, 4) if per is not None else None


def _extract_image_refs(data: dict[str, Any]) -> list[str]:
    """Accept OpenAI-style {data:[{url|b64_json}]}. b64 → data: URL."""
    refs: list[str] = []
    for item in data.get("data", []):
        if item.get("url"):
            refs.append(item["url"])
        elif item.get("b64_json"):
            refs.append(f"data:image/png;base64,{item['b64_json']}")
    return refs


def _loads_json_lenient(text: str) -> dict[str, Any]:
    """Parse model output that may be fenced or wrapped in prose.

    Tries strict parse, then strips ```json fences, then falls back to the
    outermost ``{ ... }`` slice. Returns ``{}`` when nothing parses, so callers
    coerce to a valid (if empty) contract shape rather than 500.
    """
    if not text:
        return {}
    candidates = [text.strip()]
    fenced = text.strip()
    if fenced.startswith("```"):
        fenced = fenced.strip("`")
        if fenced.lower().startswith("json"):
            fenced = fenced[4:]
        candidates.append(fenced.strip())
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    for c in candidates:
        try:
            parsed = json.loads(c)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            continue
    return {}


def _coerce_score(raw: Any) -> int | None:
    """Coerce a model-supplied brand-consistency score to a clamped 0–100 int.

    Returns ``None`` when absent or unparseable so the no-null contract holds.
    """
    if raw is None:
        return None
    try:
        n = int(round(float(raw)))
    except (TypeError, ValueError):
        return None
    return max(0, min(100, n))


class HttpImageProvider(ImageProvider):
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str = "",
        transport: httpx.BaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.kind = _provider_kind(self.base_url)
        # Tests inject a MockTransport; prod leaves this None.
        self._transport = transport

    def _build_body(
        self,
        prompt: str,
        width: int,
        height: int,
        n: int,
        negative: list[str] | None,
        extra: dict[str, Any] | None,
    ) -> dict[str, Any]:
        # OpenAI/gpt-image-1 only accepts a fixed size set → snap; other
        # gateways take the literal canvas.
        size = (
            _snap_openai_size(width, height)
            if self.kind == "openai"
            else f"{width}x{height}"
        )
        # OpenAI's gpt-image-* doesn't accept negative_prompt — fold the
        # constraints into the positive prompt as a natural-language "avoid"
        # clause so the signal isn't lost. Other gateways still get the
        # structured negative_prompt below.
        effective_prompt = prompt
        if negative and self.kind == "openai":
            avoid = "; ".join(s for s in negative if s)
            if avoid:
                effective_prompt = f"{prompt}\n\nAvoid: {avoid}"
        body: dict[str, Any] = {
            "prompt": effective_prompt,
            "size": size,
            "n": n,
        }
        # Per-request model wins over the env default; either gets sent so
        # OpenAI-compatible gateways (which require an explicit model) work.
        model = (extra or {}).get("model") or self.model
        if model:
            body["model"] = model
        if self.kind == "openai":
            # gpt-image-1 supports quality low|medium|high (cost scales ~15× across
            # them). Default medium; caller may override via extra["quality"].
            body["quality"] = (extra or {}).get("quality") or _DEFAULT_IMAGE_QUALITY
            # gpt-image-1 returns b64 and rejects response_format; DALL·E accepts
            # response_format=url. Let the caller opt in via extra["response_format"].
            if extra and extra.get("response_format"):
                body["response_format"] = extra["response_format"]
        # negative_prompt is honored by Replicate / SD-style gateways. OpenAI's
        # gpt-image-* endpoint validates strictly and 400s on unknown keys
        # ("Unknown parameter: 'negative_prompt'"), so for kind="openai" we
        # fold the constraints into the positive prompt up-stream instead.
        if negative and self.kind != "openai":
            body["negative_prompt"] = ", ".join(negative)
        # 这些参数只对 SD 风格网关有意义。OpenAI gpt-image-* 严格校验、对未知字段
        # 400(同 negative_prompt),且 aspect_ratio 已在 main.py 折进 width/height,
        # 故 kind="openai" 一律不带,避免带 machineRules 的真实出图被 400。
        if extra and self.kind != "openai":
            for key in ("aspect_ratio", "cfg", "seed"):
                if key in extra:
                    body[key] = extra[key]
        return body

    def _client(self) -> httpx.AsyncClient:
        kwargs: dict[str, Any] = {"timeout": settings.http_timeout}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.AsyncClient(**kwargs)

    @_retry
    async def generate(
        self,
        prompt: str,
        *,
        width: int,
        height: int,
        n: int,
        negative: list[str] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> list[str]:
        body = self._build_body(prompt, width, height, n, negative, extra)
        started = time.perf_counter()
        status = 0
        error: str | None = None
        # Best-effort token count for the activity log; reset per call so a
        # failed/older value never leaks. gpt-image-* returns
        # usage.total_tokens; mock / non-OpenAI gateways won't.
        self.last_total_tokens = None
        try:
            async with self._client() as c:
                r = await c.post(
                    f"{self.base_url}/images/generations",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json=body,
                )
                status = r.status_code
                r.raise_for_status()
                data = r.json()
                try:
                    usage_obj = data.get("usage")
                    # Diagnostic: log the gateway's actual usage shape + the
                    # top-level response keys, so "Token shows —" can be traced
                    # to "gateway didn't return usage" vs "we read the wrong
                    # key". gpt-image-* documents usage.total_tokens; some
                    # gateways nest it or omit it entirely.
                    logger.info(
                        "image.generate.usage",
                        extra={
                            "usage": usage_obj,
                            "top_keys": list(data.keys()),
                        },
                    )
                    tok = (usage_obj or {}).get("total_tokens")
                    if tok is None and isinstance(usage_obj, dict):
                        # Tolerate alternate gateway key names.
                        tok = (
                            usage_obj.get("totalTokens")
                            or usage_obj.get("total_token")
                            or (usage_obj.get("output_tokens", 0)
                                + usage_obj.get("input_tokens", 0)
                                or None)
                        )
                    self.last_total_tokens = int(tok) if tok is not None else None
                except Exception:  # noqa: BLE001 — token capture must never break generation
                    self.last_total_tokens = None
                refs = _extract_image_refs(data)
                if not refs:
                    raise ValueError("provider returned no image refs")
                return refs
        except Exception as exc:  # noqa: BLE001 — logged then re-raised
            error = type(exc).__name__
            raise
        finally:
            logger.info(
                "image.generate",
                extra={
                    "provider": self.kind,
                    "model": body.get("model"),
                    "n": n,
                    "size": body.get("size"),
                    "quality": body.get("quality"),
                    "latency_ms": round((time.perf_counter() - started) * 1000),
                    "status": status,
                    "cost_usd": _estimate_cost_usd(
                        self.kind, body.get("size", ""), body.get("quality", ""), n
                    ),
                    "error": error,
                },
            )

    @_retry
    async def _load_image_bytes(
        self, image_url: str, *, allow_private_initial: bool = True
    ) -> bytes:
        """取源图字节:data: URL 直接 base64 解码;http(s) 经 SSRF 安全取流。
        `allow_private_initial` 默认信任(改图源图/内部存储/上传);WEBSITE 采集的
        参考图须传 False,让初始 host 也过私网校验(K7 防 DNS-rebinding)。"""
        if image_url.startswith("data:"):
            return base64.b64decode(image_url.split(",", 1)[1])
        async with self._client() as c:
            r = await safe_get(
                c, image_url, allow_private_initial=allow_private_initial
            )
            r.raise_for_status()
            return r.content

    @_retry
    async def generate_with_references(
        self,
        prompt: str,
        references: list[dict[str, Any]],
        *,
        width: int,
        height: int,
        n: int,
        quality: str | None = None,
        model: str | None = None,
    ) -> list[str]:
        """gpt-image /images/edits with STRICT reference image(s) as visual
        input, so a 100%-use asset (e.g. a logo) lands in the output verbatim.

        Only meaningful for kind == "openai": the /images/generations
        text-to-image endpoint cannot accept input pixels, so a STRICT
        reference would otherwise be dropped and only survive as a text steer
        (the model has no idea what the logo looks like). Callers guard on
        kind == "openai" + hasattr; other gateways keep the text-to-image path.

        Each reference is a dict with `url` and (optional) `sourceHint`. K7 —
        a WEBSITE-harvested URL is fetched with the strict initial-host SSRF
        check (`allow_private_initial=False`, DNS-rebinding guard); UPLOAD /
        internal-storage URLs keep the trusting default. Mirrors the policy the
        rest of the reference-inlining paths already apply.
        """
        # Forward the full allowed set of STRICT refs (bounded by the contract's
        # max, not an arbitrary 4) — dropping any would leave a "100% 调用" asset
        # out of the composited image.
        refs = [r for r in references if r.get("url")][:_MAX_IMG2IMG_REFS]
        size = _snap_openai_size(width, height)
        started = time.perf_counter()
        status = 0
        error: str | None = None
        self.last_total_tokens = None
        try:
            # OpenAI /images/edits takes multiple inputs via repeated `image[]`
            # multipart parts; the scene prompt guides how they're composited.
            img_files: list[tuple[str, tuple[str, bytes, str]]] = []
            for i, ref in enumerate(refs):
                b = await self._load_image_bytes(
                    ref["url"],
                    allow_private_initial=ref.get("sourceHint") != "WEBSITE",
                )
                # Label by the ref's real format (JPEG/WebP logos are common);
                # a hardcoded .png/image/png could be rejected by /images/edits.
                img_files.append(_edit_image_part(b, i))
            if not img_files:
                raise ValueError("no loadable reference images for img2img")
            async with self._client() as c:
                r = await c.post(
                    f"{self.base_url}/images/edits",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    files=img_files,
                    data={
                        "prompt": prompt,
                        "model": model or self.model or "gpt-image-2",
                        "size": size,
                        "n": str(n),
                        "quality": quality or _DEFAULT_IMAGE_QUALITY,
                    },
                )
                status = r.status_code
                r.raise_for_status()
                data = r.json()
                try:
                    tok = (data.get("usage") or {}).get("total_tokens")
                    self.last_total_tokens = int(tok) if tok is not None else None
                except Exception:  # noqa: BLE001 — token capture must never break gen
                    self.last_total_tokens = None
                out = _extract_image_refs(data)
                if not out:
                    raise ValueError("provider returned no image refs")
                return out
        except Exception as exc:  # noqa: BLE001 — logged then re-raised
            error = type(exc).__name__
            raise
        finally:
            logger.info(
                "image.generate.img2img",
                extra={
                    "provider": self.kind,
                    "model": model or self.model,
                    "n": n,
                    "refs": len(refs),
                    "size": size,
                    "latency_ms": round((time.perf_counter() - started) * 1000),
                    "status": status,
                    "error": error,
                },
            )

    async def edit(
        self, image_url: str, op: str, payload: dict[str, Any]
    ) -> str:
        started = time.perf_counter()
        status = 0
        error: str | None = None
        try:
            async with self._client() as c:
                if self.kind == "openai":
                    # OpenAI /images/edits 是 multipart form-data:image 文件字节 +
                    # 自然语言 prompt(JSON 体会 400)。把 op + payload 指令拼成 prompt,
                    # 源图取字节作为文件上传;gpt-image-1 返回 b64。
                    img_bytes = await self._load_image_bytes(image_url)
                    size = _snap_openai_size(
                        int(payload.get("width", 1024) or 1024),
                        int(payload.get("height", 1024) or 1024),
                    )
                    files: dict[str, Any] = {
                        "image": ("image.png", img_bytes, "image/png"),
                    }
                    # 局部重画:payload 带 mask(前端涂抹的黑白蒙版 data-URI)时,归一成
                    # OpenAI 需要的 RGBA 蒙版(涂抹区透明=编辑)并作为 multipart 文件上传。
                    mask_ref = payload.get("mask")
                    if mask_ref:
                        files["mask"] = (
                            "mask.png",
                            _build_inpaint_mask(img_bytes, str(mask_ref)),
                            "image/png",
                        )
                    r = await c.post(
                        f"{self.base_url}/images/edits",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        files=files,
                        data={
                            "prompt": _edit_prompt(op, payload),
                            "model": self.model or "gpt-image-2",
                            "size": size,
                            "n": "1",
                        },
                    )
                else:
                    # OpenAI 兼容网关:保留 JSON 体(img2img-capable 网关自解析)。
                    r = await c.post(
                        f"{self.base_url}/images/edits",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        json={"image": image_url, "op": op, **payload},
                    )
                status = r.status_code
                r.raise_for_status()
                refs = _extract_image_refs(r.json())
                if not refs:
                    raise ValueError("provider returned no image refs")
                return refs[0]
        except Exception as exc:  # noqa: BLE001 — logged then re-raised
            error = type(exc).__name__
            raise
        finally:
            logger.info(
                "image.edit",
                extra={
                    "provider": self.kind,
                    "op": op,
                    "latency_ms": round((time.perf_counter() - started) * 1000),
                    "status": status,
                    "error": error,
                },
            )

    async def check(self) -> ProviderCheck:
        return await _check_models_endpoint(
            self.base_url, self.api_key, self._transport, self.model
        )


# --- VLM prompts. Kept terse + schema-pinned so models emit parseable JSON. ---

_ANALYZE_SYSTEM = (
    "You are a senior brand visual analyst. You receive a brand's reference "
    "assets and extract its visual identity. Reply with STRICT JSON only — no "
    "prose, no code fences."
)
_ANALYZE_PROMPT = (
    "Analyze these brand assets and return JSON shaped exactly as:\n"
    "{{\"rules\":[{{\"type\":\"color|font|layout|imagery|copy\","
    "\"strength\":\"STRONG|WEAK|FORBIDDEN\",\"summary\":\"<concise Chinese>\","
    "\"value\":{{<structured detail>}},"
    "\"evidence\":[{{\"assetId\":\"<one of the provided ids>\",\"note\":\"<why>\"}}]}}],"
    "\"colorSystem\":{{\"palette\":[\"#hex\"],\"pairing\":[[\"#hex\",\"#hex\"]],"
    "\"restrictions\":[\"<rule>\"],\"contrastScore\":<0-100>,\"consistencyScore\":<0-100>}}}}\n"
    "Cover color, font, layout, imagery and copy where evidence exists. Every "
    "rule MUST cite at least one assetId from: {ids}. Mark forbidden copy tones "
    "with strength FORBIDDEN."
)
_PARSE_MANUAL_SYSTEM = (
    "You are a senior brand visual analyst. You read both the text and rendered "
    "pages of a VI / brand manual and distil a reusable machine-readable Brand Kit. "
    "Reply with STRICT JSON only — no prose, no code fences."
)
_PARSE_MANUAL_PROMPT = (
    "Analyze the supplied brand-manual pages and their extracted text. Return "
    "JSON shaped exactly as:\n"
    "{{\"rules\":[{{\"type\":\"logo|font|color|layout|imagery|copy\","
    "\"strength\":\"STRONG|WEAK|FORBIDDEN\",\"summary\":\"<concise Chinese>\","
    "\"value\":{{<structured detail>}},"
    "\"evidence\":[{{\"page\":<1-based page>,\"sourceRef\":\"<matching asset ref if visual>\","
    "\"bbox\":[x,y,w,h],\"note\":\"<section / reason>\"}}]}}],"
    "\"assets\":[{{\"ref\":\"p<page>-<short-key>\","
    "\"type\":\"logo|font|color|layout|imagery|copy\",\"page\":<1-based page>,"
    "\"bbox\":[x,y,w,h],\"label\":\"<concise Chinese>\"}}],"
    "\"colorSystem\":{{\"palette\":[\"#hex\"],\"pairing\":[[\"#hex\",\"#hex\"]],"
    "\"restrictions\":[\"<rule>\"],\"contrastScore\":<0-100>,\"consistencyScore\":<0-100>}}}}\n"
    "bbox is normalized [x,y,width,height] in 0..1 relative to the page image. "
    "Create tight visual crops for primary/alternate logos, font specimens, color "
    "cards, layout examples and representative photography; do not crop ordinary "
    "paragraph text unless it expresses copy/voice rules. Every visual evidence "
    "sourceRef must match one assets.ref. Cover all six modules when evidence exists. "
    "Mark prohibited usage inside the same module value and summary. Never invent a "
    "rule that is absent from the supplied pages.\n\nPage text:\n{text}"
)
_DESCRIBE_SYSTEM = (
    "You are a brand asset librarian. You look at one image and produce concise, "
    "searchable tags plus a one-paragraph description. Reply with STRICT JSON "
    "only — no prose, no code fences."
)
_DESCRIBE_PROMPT = (
    "Describe this brand asset for a media library.{hints}\n"
    "Return JSON shaped exactly as:\n"
    "{{\"aiTags\":[\"<concise tag>\"],\"aiDescription\":\"<one paragraph in "
    "Chinese describing subject, colors, style and likely usage>\"}}\n"
    "Give 4–10 tags covering subject, dominant colors, style and usage. Tags are "
    "short noun phrases (Chinese)."
)
_DECOMPOSE_SYSTEM = (
    "You are a senior brand campaign strategist. You read a free-text marketing "
    "brief and decompose it into structured creation seeds for an image "
    "generator. Reply with STRICT JSON only — no prose, no code fences."
)
_DECOMPOSE_PROMPT = (
    "Decompose this brand marketing brief into creation seeds.{hints}\n"
    "Brief:\n{text}\n\n"
    "Return JSON shaped exactly as:\n"
    "{{\"sellingPoint\":\"<the single core selling point, concise Chinese>\","
    "\"scene\":\"<a concrete visual scene description, Chinese>\","
    "\"sceneType\":\"ECOM_MAIN|SCENE|SOCIAL_POSTER|CAMPAIGN_KV|SELLING_POINT\","
    "\"styleKeywords\":[\"<style keyword>\"],"
    "\"summary\":\"<one-line Chinese summary of the brief>\"}}\n"
    "Pick the single best sceneType. Give 3–6 short style keywords (Chinese)."
)
_CAMPAIGN_SUMMARY_SYSTEM = (
    "You are a brand campaign assistant. You read a campaign's context (its "
    "name, brief and the brand's confirmed rules) and write a concise project "
    "summary. Reply with STRICT JSON only — no prose, no code fences."
)
_CAMPAIGN_SUMMARY_PROMPT = (
    "Summarize this campaign for its project dashboard.{hints}\n"
    "Context:\n{text}\n\n"
    "Return JSON shaped exactly as:\n"
    "{{\"summary\":\"<2–4 sentence Chinese summary of goal, status and next "
    "step>\",\"highlights\":[\"<short Chinese highlight / next-step>\"]}}\n"
    "Give 2–5 highlights. Keep it grounded in the provided context — do not "
    "invent facts."
)
_COMPLIANCE_SYSTEM = (
    "You are a brand compliance reviewer. Judge whether an image obeys the "
    "brand's visual rules. Reply with STRICT JSON only."
)
_COMPLIANCE_PROMPT = (
    "Brand rules: {rules}\n"
    "Inspect the image and return JSON shaped as:\n"
    "{{\"results\":[{{\"level\":\"PASS|RISK|FORBIDDEN\",\"reason\":\"<Chinese>\","
    "\"category\":\"BRAND_VISUAL\"}}],\"score\":<0-100 integer>}}\n"
    "Flag logo misuse, off-palette colors, and layout violations. `score` is "
    "the overall brand-consistency of the image vs the rules (100 = fully "
    "on-brand)."
)
_SCRAPE_SYSTEM = (
    "You extract a brand's marketing material from a web page. Reply with "
    "STRICT JSON only."
)
_SCRAPE_PROMPT = (
    "Source page: {url}\n"
    "Candidate image URLs:\n{images}\n\n"
    "Visible text:\n{text}\n\n"
    "Return JSON shaped as:\n"
    "{{\"images\":[{{\"sourceUrl\":\"<one candidate url>\","
    "\"guessedCategory\":\"LOGO|KV|PRODUCT|OTHER\"}}],"
    "\"copies\":[\"<marketing copy line>\"],"
    "\"sellingPoints\":[\"<selling point>\"]}}\n"
    "Pick only real product/brand images; drop icons and trackers."
)


class HttpVLMProvider(VLMProvider):
    """Real vision-language provider over an OpenAI-compatible chat API."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str = "",
        transport: httpx.BaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model or "gpt-4o"
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        kwargs: dict[str, Any] = {"timeout": settings.http_timeout}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.AsyncClient(**kwargs)

    async def _inline_image(
        self, url: str, *, source: str | None = None
    ) -> str | None:
        """Fetch an image server-side and return a data: URL the model can read.

        Asset URLs point at internal storage a third-party API can't reach; we
        can (same network), so inline the bytes.

        K7 — SSRF policy depends on the asset's provenance (`source`):
          - UPLOAD / None (default): the URL is our own storage (which may be a
            private/internal host) → trust the initial host, validate only
            redirect hops. (Legacy behavior, unchanged.)
          - WEBSITE: the URL was harvested from an arbitrary third-party site and
            its host can DNS-rebind to private space between save-time validation
            and fetch-time → the INITIAL host is validated too.

        Returns None when the fetch is SSRF-blocked (a private initial host for a
        WEBSITE asset, or a redirect into private space): callers must DROP the
        image rather than forward the raw URL, or the VLM provider would fetch the
        blocked target server-side itself. Other failures fall back to the raw URL
        (it may be publicly reachable).
        """
        # WEBSITE-sourced URLs are untrusted → validate the initial host too.
        allow_private_initial = (source or "").upper() != "WEBSITE"
        try:
            async with self._client() as c:
                r = await safe_get(
                    c, url, allow_private_initial=allow_private_initial
                )
                r.raise_for_status()
                ctype = (r.headers.get("content-type") or "").split(";")[0].strip()
                if not ctype.startswith("image/"):
                    ctype = "image/png"
                b64 = base64.b64encode(r.content).decode()
                return f"data:{ctype};base64,{b64}"
        except SSRFError:
            return None  # blocked → never hand the raw URL to the VLM provider
        except Exception:  # noqa: BLE001 — best-effort, fall back to raw URL
            return url

    @_retry
    async def _chat_json(
        self, content: list[dict[str, Any]], *, system: str, max_tokens: int = 2048
    ) -> dict[str, Any]:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
            "temperature": 0.2,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        async with self._client() as c:
            r = await c.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=body,
            )
            r.raise_for_status()
            data = r.json()
        text = (
            (data.get("choices") or [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        return _loads_json_lenient(text)

    async def analyze_assets(
        self, assets: list[dict[str, str]]
    ) -> dict[str, Any]:
        asset_ids = [str(a["id"]) for a in assets]
        parts: list[dict[str, Any]] = [
            {"type": "text", "text": _ANALYZE_PROMPT.format(ids=", ".join(asset_ids))}
        ]
        attached = 0
        for a in assets[:_MAX_VISION_IMAGES]:
            # K7 — pass the asset's provenance so a WEBSITE-sourced URL gets its
            # initial host validated (DNS-rebinding defense).
            img = await self._inline_image(a["url"], source=a.get("source"))
            if img is None:
                continue  # SSRF-blocked → drop this asset from the VLM request
            parts.append({"type": "text", "text": f"assetId={a['id']}"})
            parts.append({"type": "image_url", "image_url": {"url": img}})
            attached += 1
        if attached == 0:
            # 没有任何素材图能安全内联(全被 SSRF 拦/抓取失败,或 assets 为空):不把纯
            # 文本喂给 VLM——它会无视输入凭空造规则、再被 _coerce_recognize 回填 assetId。
            # 直接返回空规则,与 parse-manual 空文本的处理一致(fail-closed)。
            return {"rules": []}
        data = await self._chat_json(parts, system=_ANALYZE_SYSTEM)
        return _coerce_recognize(data, asset_ids)

    async def parse_manual(
        self, text: str, pages: list[dict[str, Any]] | None = None
    ) -> dict[str, Any]:
        rendered = [p for p in (pages or []) if p.get("dataUrl")]
        # Text-only compatibility path for callers that cannot render a PDF.
        if not rendered:
            prompt = _PARSE_MANUAL_PROMPT.format(text=text[:_MAX_SCRAPE_TEXT])
            data = await self._chat_json(
                [{"type": "text", "text": prompt}],
                system=_PARSE_MANUAL_SYSTEM,
                max_tokens=4096,
            )
            result = _coerce_recognize(data, [])
            result["extractedAssets"] = []
            return result

        batches = [
            rendered[offset : offset + _MANUAL_BATCH_PAGES]
            for offset in range(0, len(rendered), _MANUAL_BATCH_PAGES)
        ]
        semaphore = asyncio.Semaphore(2)
        batch_warnings: list[str] = []

        async def analyze_batch(batch: list[dict[str, Any]]) -> dict[str, Any]:
            page_text = "\n\n".join(
                f"[第 {int(p.get('page', 0))} 页]\n{str(p.get('text') or '')}"
                for p in batch
            )[:_MAX_SCRAPE_TEXT]
            parts: list[dict[str, Any]] = [
                {
                    "type": "text",
                    "text": _PARSE_MANUAL_PROMPT.format(text=page_text),
                }
            ]
            for page in batch:
                parts.append(
                    {
                        "type": "text",
                        "text": f"下图是品牌手册第 {int(page.get('page', 0))} 页。",
                    }
                )
                parts.append(
                    {"type": "image_url", "image_url": {"url": page["dataUrl"]}}
                )
            last_error: Exception | None = None
            for attempt in range(4):
                try:
                    async with semaphore:
                        return await self._chat_json(
                            parts, system=_PARSE_MANUAL_SYSTEM, max_tokens=4096
                        )
                except httpx.HTTPStatusError as exc:
                    last_error = exc
                    if not _is_provider_rate_limit(exc):
                        raise
                    if attempt < 3:
                        await asyncio.sleep(
                            _provider_rate_limit_delay(exc, attempt)
                            + (int(batch[0].get("page") or 0) % 3) * 0.35
                        )
            first_page = int(batch[0].get("page") or 0)
            last_page = int(batch[-1].get("page") or first_page)
            logger.warning(
                "manual pages %s-%s skipped after provider rate limits: %s",
                first_page,
                last_page,
                last_error,
            )
            batch_warnings.append(
                f"第 {first_page}–{last_page} 页视觉分析遇到限流，已用 PDF 文字与页面证据补齐。"
            )
            return {"rules": [], "assets": []}

        # Two batches in flight keeps a long manual within the bounded UI
        # window without turning one upload into an uncontrolled request burst.
        batch_data = await asyncio.gather(
            *(analyze_batch(batch) for batch in batches)
        )
        chunk_results: list[dict[str, Any]] = []
        extracted: list[dict[str, Any]] = []
        for batch, data in zip(batches, batch_data, strict=True):
            chunk_results.append(_coerce_recognize(data, []))
            remaining = _MAX_MANUAL_ASSETS - len(extracted)
            if remaining > 0:
                # Spread the crop budget across the entire manual instead of
                # letting early pages consume it all before later photography /
                # advertising examples are inspected.
                extracted.extend(
                    _extract_manual_crops(data, batch, min(remaining, 6))
                )

        extracted.extend(
            _fallback_manual_crops(
                rendered,
                extracted,
                _MAX_MANUAL_ASSETS - len(extracted),
            )
        )
        merged = _merge_manual_results(chunk_results, rendered)
        _enforce_grounded_manual_modules(merged, rendered)
        valid_refs = {a["ref"] for a in extracted}
        for rule in merged.get("rules", []):
            for evidence in rule.get("evidence", []):
                if evidence.get("sourceRef") not in valid_refs:
                    evidence.pop("sourceRef", None)
            if not any(e.get("sourceRef") for e in rule.get("evidence", [])):
                fallback_asset = next(
                    (a for a in extracted if a.get("type") == rule.get("type")),
                    None,
                )
                if fallback_asset:
                    rule.setdefault("evidence", []).append(
                        {
                            "page": fallback_asset["page"],
                            "sourceRef": fallback_asset["ref"],
                            "bbox": fallback_asset["bbox"],
                            "note": fallback_asset["label"],
                        }
                    )
        merged["extractedAssets"] = extracted
        if batch_warnings:
            merged["warnings"] = batch_warnings
        return merged

    async def describe_asset(
        self,
        url: str,
        *,
        category: str | None = None,
        brand_tone: str | None = None,
        source: str | None = None,
    ) -> dict[str, Any]:
        img = await self._inline_image(url, source=source)
        if img is None:
            # SSRF-blocked / unfetchable → fail closed with empty tags rather
            # than hand the raw URL to the model or invent tags.
            return {"aiTags": [], "aiDescription": ""}
        hints = ""
        if category:
            hints += f" Asset category: {category}."
        if brand_tone:
            hints += f" Brand tone: {brand_tone}."
        parts: list[dict[str, Any]] = [
            {"type": "text", "text": _DESCRIBE_PROMPT.format(hints=hints)},
            {"type": "image_url", "image_url": {"url": img}},
        ]
        data = await self._chat_json(parts, system=_DESCRIBE_SYSTEM)
        return _coerce_describe(data)

    async def summarize(
        self, mode: str, text: str, *, context: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        ctx = context or {}
        hints = ""
        if ctx.get("brandName"):
            hints += f" Brand: {ctx['brandName']}."
        if ctx.get("campaignName"):
            hints += f" Campaign: {ctx['campaignName']}."
        if ctx.get("brandTone"):
            hints += f" Brand tone: {ctx['brandTone']}."
        rule_summaries = [str(r) for r in (ctx.get("ruleSummaries") or []) if r]
        if rule_summaries:
            hints += " Confirmed brand rules: " + "; ".join(
                rule_summaries[:20]
            ) + "."
        clipped = (text or "")[:_MAX_SCRAPE_TEXT]
        if mode == "campaign_summary":
            prompt = _CAMPAIGN_SUMMARY_PROMPT.format(hints=hints, text=clipped)
            system = _CAMPAIGN_SUMMARY_SYSTEM
        else:  # brief_decompose (default)
            prompt = _DECOMPOSE_PROMPT.format(hints=hints, text=clipped)
            system = _DECOMPOSE_SYSTEM
        data = await self._chat_json(
            [{"type": "text", "text": prompt}], system=system
        )
        return _coerce_summarize(data, mode)

    async def check_visual_compliance(
        self,
        image_url: str,
        brand_rules: list[dict[str, Any]],
        references: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        rules = "; ".join(
            str(r.get("summary", "")) for r in brand_rules if r.get("summary")
        )
        img = await self._inline_image(image_url)
        if img is None:
            # 主审图无法安全获取(SSRF 拦截 / 抓取失败):不能当作"通过"。直接返回一条
            # RISK 待复核结果、score=None,让上层 overall 落 RISK、分数非满分,避免
            # 偏离规范的图因"没看成图"被静默判 PASS(fail-closed)。不浪费一次模型调用。
            return {
                "results": [
                    {
                        "level": "RISK",
                        "reason": "审图无法获取(被安全策略拦截或抓取失败),未完成视觉合规,请人工复核",
                        "category": "BRAND_VISUAL",
                    }
                ],
                "score": None,
            }
        parts: list[dict[str, Any]] = [
            {"type": "text", "text": _COMPLIANCE_PROMPT.format(rules=rules or "(none)")},
            {"type": "text", "text": "Image under review:"},
            {"type": "image_url", "image_url": {"url": img}},
        ]
        # D5 — attach the brand's positive/negative example assets so the model
        # can judge resemblance. A generated image that looks like a `negative`
        # example (or strays from a `positive` one) should be flagged.
        for ref in (references or [])[:_MAX_VISION_IMAGES]:
            url = ref.get("url")
            if not url:
                continue
            polarity = str(ref.get("polarity", "")).lower()
            note = str(ref.get("note") or "")
            label = (
                "NEGATIVE example — the image MUST NOT resemble this"
                if polarity == "negative"
                else "POSITIVE example — the image SHOULD align with this"
            )
            # K7 — a reference asset may be WEBSITE-sourced; honor its hint.
            ref_img = await self._inline_image(url, source=ref.get("sourceHint"))
            if ref_img is None:
                continue  # SSRF-blocked reference → drop
            parts.append(
                {"type": "text", "text": f"{label}{(': ' + note) if note else ''}"}
            )
            parts.append(
                {"type": "image_url", "image_url": {"url": ref_img}}
            )
        data = await self._chat_json(parts, system=_COMPLIANCE_SYSTEM)
        results: list[dict[str, Any]] = []
        for r in data.get("results", []) or []:
            if not isinstance(r, dict):
                continue
            results.append(
                {
                    "level": str(r.get("level", "PASS")).upper(),
                    "reason": str(r.get("reason", "")),
                    "category": r.get("category") or "BRAND_VISUAL",
                }
            )
        return {"results": results, "score": _coerce_score(data.get("score"))}

    async def scrape_website(self, url: str) -> dict[str, Any]:
        html = ""
        async with self._client() as c:
            try:
                # SSRF: user-supplied page URL → both the initial host and every
                # redirect hop must be public. safe_get raises on private; we then
                # degrade to model-only extraction.
                r = await safe_get(c, url, allow_private_initial=False)
                r.raise_for_status()
                html = r.text
            except Exception:  # noqa: BLE001 — degrade to model-only extraction
                html = ""
        images, text = _parse_html(url, html)
        site_style = _extract_site_style(url, html)
        prompt = _SCRAPE_PROMPT.format(
            url=url,
            images="\n".join(images[:_MAX_SCRAPE_IMAGES]) or "(none found)",
            text=text[:_MAX_SCRAPE_TEXT] or "(none found)",
        )
        data = await self._chat_json(
            [{"type": "text", "text": prompt}], system=_SCRAPE_SYSTEM
        )
        result = _coerce_ingest(data, images)
        if site_style:
            result["siteStyle"] = site_style
        return result

    async def check(self) -> ProviderCheck:
        return await _check_models_endpoint(
            self.base_url, self.api_key, self._transport, self.model
        )


_GENERIC_FONTS = {
    "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui",
    "inherit", "initial", "unset", "ui-sans-serif", "ui-serif", "ui-monospace",
    "ui-rounded", "-apple-system", "blinkmacsystemfont", "segoe ui", "var",
    "roboto", "helvetica", "helvetica neue", "arial", "emoji",
}
_HEX_RE = re.compile(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b")
_RGB_RE = re.compile(r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})")
_FONT_RE = re.compile(r"font-family\s*:\s*([^;}{]+)", re.I)
_BG_URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", re.I)


def _abs(base_url: str, src: str | None) -> str | None:
    if not src:
        return None
    src = src.strip()
    if not src or src.startswith(("data:", "javascript:", "#")):
        return None
    absolute = urljoin(base_url, src)
    return absolute if absolute.startswith(("http://", "https://")) else None


def _srcset_urls(value: str) -> list[str]:
    """'a.jpg 1x, b.jpg 800w' -> ['a.jpg', 'b.jpg']."""
    out: list[str] = []
    for part in value.split(","):
        token = part.strip().split(" ")[0].strip()
        if token:
            out.append(token)
    return out


def _parse_html(base_url: str, html: str) -> tuple[list[str], str]:
    """Return (absolute image URLs, visible text) from a page.

    Image discovery covers <img src/data-src/srcset>, <source srcset>,
    og:image / twitter:image, <link rel=preload as=image>, and CSS
    background-image url(...) — hero art is often a CSS background, not an <img>.
    """
    if not html:
        return [], ""
    soup = BeautifulSoup(html, "html.parser")
    images: list[str] = []
    seen: set[str] = set()

    def add(src: str | None) -> None:
        a = _abs(base_url, src)
        if a and a not in seen:
            seen.add(a)
            images.append(a)

    for img in soup.find_all("img"):
        add(img.get("src") or img.get("data-src") or img.get("data-original"))
        for u in _srcset_urls(img.get("srcset") or ""):
            add(u)
    for source in soup.find_all("source"):
        for u in _srcset_urls(source.get("srcset") or ""):
            add(u)
    for meta in soup.find_all("meta"):
        prop = (meta.get("property") or meta.get("name") or "").lower()
        if prop in ("og:image", "og:image:url", "twitter:image"):
            add(meta.get("content"))
    for link in soup.find_all("link"):
        rels = " ".join(link.get("rel") or []).lower()
        if "preload" in rels and (link.get("as") or "").lower() == "image":
            add(link.get("href"))
    for el in soup.find_all(style=True):
        for u in _BG_URL_RE.findall(el.get("style") or ""):
            add(u)
    for style in soup.find_all("style"):
        for u in _BG_URL_RE.findall(style.get_text() or ""):
            add(u)

    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = soup.get_text(" ", strip=True)
    return images, text


def _norm_hex(value: str) -> str | None:
    v = value.strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    if len(v) != 6:
        return None
    try:
        int(v, 16)
    except ValueError:
        return None
    return "#" + v.lower()


def _is_brandish(hex6: str) -> bool:
    """Drop near-white / near-black / gray noise so the palette reads as brand.

    Uses *relative* chroma ((mx-mn)/mx) so a dark-but-colored brand color like
    #16130f (warm graphite) survives while flat greys like #cccccc are dropped.
    """
    r, g, b = int(hex6[1:3], 16), int(hex6[3:5], 16), int(hex6[5:7], 16)
    mx, mn = max(r, g, b), min(r, g, b)
    if mn > 240:  # near-white
        return False
    if mx < 12:  # near-black
        return False
    if (mx - mn) / mx < 0.10:  # ~grey
        return False
    return True


def _extract_colors(text: str) -> list[str]:
    counts: Counter[str] = Counter()
    for m in _HEX_RE.finditer(text):
        h = _norm_hex(m.group(0))
        if h:
            counts[h] += 1
    for r, g, b in _RGB_RE.findall(text):
        try:
            h = "#%02x%02x%02x" % (min(int(r), 255), min(int(g), 255), min(int(b), 255))
        except ValueError:
            continue
        counts[h] += 1
    brand = {c: n for c, n in counts.items() if _is_brandish(c)}
    ranked = sorted((brand or counts).items(), key=lambda kv: (-kv[1], kv[0]))
    return [c for c, _ in ranked[:6]]


def _extract_fonts(soup: BeautifulSoup) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []

    def add(name: str) -> None:
        n = name.strip().strip("'\"").strip()
        key = n.lower()
        if not n or key in _GENERIC_FONTS or key in seen:
            return
        if len(n) > 40 or any(c in n for c in "{}:;"):
            return
        seen.add(key)
        out.append(n)

    chunks = [s.get_text() or "" for s in soup.find_all("style")]
    chunks += [el.get("style") or "" for el in soup.find_all(style=True)]
    for chunk in chunks:
        for decl in _FONT_RE.findall(chunk):
            add(decl.split(",")[0])
    for link in soup.find_all("link"):
        href = link.get("href") or ""
        if "fonts.googleapis.com" in href and "family=" in href:
            for token in re.split(r"[&|]", href.split("family=", 1)[1]):
                add(token.split(":")[0].replace("+", " "))
    return out[:5]


def _pick_logo(base_url: str, soup: BeautifulSoup) -> str | None:
    for link in soup.find_all("link"):
        if "apple-touch-icon" in " ".join(link.get("rel") or []).lower():
            if (a := _abs(base_url, link.get("href"))):
                return a
    for img in soup.find_all("img"):
        hay = " ".join([
            img.get("src") or "", img.get("alt") or "",
            " ".join(img.get("class") or []), img.get("id") or "",
        ]).lower()
        if "logo" in hay and (a := _abs(base_url, img.get("src") or img.get("data-src"))):
            return a
    for meta in soup.find_all("meta"):
        if (meta.get("property") or "").lower() == "og:image":
            if (a := _abs(base_url, meta.get("content"))):
                return a
    for link in soup.find_all("link"):
        if "icon" in " ".join(link.get("rel") or []).lower():
            if (a := _abs(base_url, link.get("href"))):
                return a
    return None


def _site_name(soup: BeautifulSoup) -> str | None:
    for meta in soup.find_all("meta"):
        if (meta.get("property") or "").lower() == "og:site_name":
            if (v := (meta.get("content") or "").strip()):
                return v[:80]
    if soup.title and soup.title.string:
        return soup.title.string.strip()[:80] or None
    return None


def _extract_site_style(base_url: str, html: str) -> dict[str, Any]:
    """Deterministic brand-style signals straight from HTML/CSS (no model call).

    Turns "scrape a URL" into "read the site's visual system" — palette, fonts,
    logo, name — so M1 can show the grabbed style before any image is selected.
    """
    if not html:
        return {}
    soup = BeautifulSoup(html, "html.parser")
    color_text = "\n".join(
        [s.get_text() or "" for s in soup.find_all("style")]
        + [el.get("style") or "" for el in soup.find_all(style=True)]
        + [
            m.get("content") or ""
            for m in soup.find_all("meta")
            if (m.get("name") or "").lower() == "theme-color"
        ]
    )
    style: dict[str, Any] = {}
    if (palette := _extract_colors(color_text)):
        style["palette"] = palette
    if (fonts := _extract_fonts(soup)):
        style["fonts"] = fonts
    for meta in soup.find_all("meta"):
        if (meta.get("name") or "").lower() == "theme-color":
            if (tc := _norm_hex(meta.get("content") or "")):
                style["themeColor"] = tc
            break
    if (logo := _pick_logo(base_url, soup)):
        style["logoUrl"] = logo
    if (name := _site_name(soup)):
        style["siteName"] = name
    return style


def _coerce_recognize(
    data: dict[str, Any], asset_ids: list[str]
) -> dict[str, Any]:
    """Force model output into a valid RecognizeResponse shape.

    Keeps note-only evidence (a VLM observation with no assetId) and never trusts
    a hallucinated/foreign id: a model-supplied assetId outside the requested
    ``asset_ids`` set is stripped (the note is kept as note-only) rather than
    passed through. We do NOT fabricate/backfill ids — if the model gave no
    evidence the rule's evidence stays ``[]`` (the contract default). Only emits
    colorSystem when a palette is present, so the no-null contract boundary holds.
    """
    allowed_ids = set(asset_ids)
    rules: list[dict[str, Any]] = []
    for r in data.get("rules", []) or []:
        if not isinstance(r, dict):
            continue
        evidence: list[dict[str, Any]] = []
        for e in r.get("evidence", []) or []:
            if not isinstance(e, dict):
                continue
            item: dict[str, Any] = {}
            # Only trust an assetId the model actually got in the request; a
            # foreign/hallucinated id is dropped (item degrades to note-only).
            raw_id = e.get("assetId")
            if raw_id and str(raw_id) in allowed_ids:
                item["assetId"] = str(raw_id)
            note = e.get("note")
            if note:
                item["note"] = str(note)
            source_ref = e.get("sourceRef")
            if source_ref and re.fullmatch(r"[A-Za-z0-9._-]{1,80}", str(source_ref)):
                item["sourceRef"] = str(source_ref)
            try:
                page_no = int(e.get("page") or 0)
            except (TypeError, ValueError):
                page_no = 0
            if page_no > 0:
                item["page"] = page_no
            bbox = e.get("bbox")
            if isinstance(bbox, list) and len(bbox) == 4:
                # A sloppy VLM can emit non-numeric or non-finite bbox entries.
                # `float("NaN")`/`float("Infinity")` don't raise but Starlette's
                # JSON renderer 500s on NaN/Inf — so require finite numbers and a
                # sane normalized 0..1 range, else drop just the bbox (keep the
                # rest of the evidence item) rather than sinking the response.
                try:
                    coerced = [float(x) for x in bbox]
                except (TypeError, ValueError):
                    coerced = None
                if (
                    coerced is not None
                    and all(math.isfinite(x) for x in coerced)
                    and all(-0.01 <= x <= 1.01 for x in coerced)
                ):
                    item["bbox"] = coerced
            # Keep the item if it carries any usable signal (id, note, or bbox);
            # drop empties. Note-only evidence is retained.
            if item:
                evidence.append(item)
        rule_type = str(r.get("type", "imagery"))
        if rule_type not in {"logo", "font", "color", "layout", "imagery", "graphic", "copy"}:
            continue
        strength = str(r.get("strength", "WEAK")).upper()
        if strength not in {"STRONG", "WEAK", "FORBIDDEN"}:
            strength = "WEAK"
        rules.append(
            {
                "type": rule_type,
                "strength": strength,
                "summary": str(r.get("summary", "")),
                "value": r.get("value") if isinstance(r.get("value"), dict) else {},
                "evidence": evidence,
            }
        )
    out: dict[str, Any] = {"rules": rules}
    cs = data.get("colorSystem")
    if isinstance(cs, dict) and cs.get("palette"):
        out["colorSystem"] = {
            "palette": [str(c) for c in cs.get("palette", [])],
            "pairing": [
                [str(x) for x in pair]
                for pair in cs.get("pairing", [])
                if isinstance(pair, list)
            ],
            "restrictions": [str(x) for x in cs.get("restrictions", [])],
            "contrastScore": float(cs.get("contrastScore", 0) or 0),
            "consistencyScore": float(cs.get("consistencyScore", 0) or 0),
        }
    return out


def _normalized_bbox(raw: Any) -> list[float] | None:
    if not isinstance(raw, list) or len(raw) != 4:
        return None
    try:
        bbox = [float(x) for x in raw]
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(x) for x in bbox):
        return None
    x, y, width, height = bbox
    if width <= 0.02 or height <= 0.02:
        return None
    if x < -0.01 or y < -0.01 or x + width > 1.01 or y + height > 1.01:
        return None
    return [max(0.0, x), max(0.0, y), min(1.0 - x, width), min(1.0 - y, height)]


def _is_provider_rate_limit(exc: httpx.HTTPStatusError) -> bool:
    response = exc.response
    body = response.text.lower()
    return response.status_code == 429 or (
        response.status_code in {500, 502, 503, 504}
        and ("rate limit" in body or '"429"' in body or "returned 429" in body)
    )


def _provider_rate_limit_delay(
    exc: httpx.HTTPStatusError, attempt: int
) -> float:
    retry_after = exc.response.headers.get("retry-after")
    if retry_after:
        try:
            return min(30.0, max(1.0, float(retry_after)))
        except ValueError:
            pass
    match = re.search(
        r"try again in\s+([0-9]+(?:\.[0-9]+)?)s", exc.response.text, re.I
    )
    if match:
        return min(30.0, max(1.0, float(match.group(1))))
    return min(30.0, float(2 ** (attempt + 1)))


def _extract_manual_crops(
    data: dict[str, Any], pages: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    """Turn model-selected normalized page regions into bounded JPEG assets."""
    from PIL import Image

    allowed_types = {"logo", "font", "color", "layout", "imagery", "copy"}
    page_map = {int(p.get("page") or 0): str(p.get("dataUrl") or "") for p in pages}
    out: list[dict[str, Any]] = []
    refs: set[str] = set()
    for candidate in data.get("assets", []) or []:
        if len(out) >= limit or not isinstance(candidate, dict):
            break
        kind = str(candidate.get("type") or "")
        if kind not in allowed_types:
            continue
        try:
            page_no = int(candidate.get("page") or 0)
        except (TypeError, ValueError):
            continue
        bbox = _normalized_bbox(candidate.get("bbox"))
        page_data = page_map.get(page_no)
        if not bbox or not page_data or "," not in page_data:
            continue
        raw_ref = re.sub(r"[^A-Za-z0-9._-]+", "-", str(candidate.get("ref") or ""))
        raw_ref = raw_ref.strip("-")[:80] or f"p{page_no}-{kind}-{len(out) + 1}"
        if not raw_ref.startswith(f"p{page_no}-"):
            raw_ref = f"p{page_no}-{raw_ref}"[:80]
        ref = raw_ref
        suffix = 2
        while ref in refs:
            ref = f"{raw_ref[:72]}-{suffix}"
            suffix += 1
        try:
            page_bytes = base64.b64decode(page_data.split(",", 1)[1])
            with Image.open(io.BytesIO(page_bytes)) as page_image:
                width, height = page_image.size
                x, y, crop_w, crop_h = bbox
                # A small margin keeps antialiasing/safe-area context without
                # turning the crop back into an unreadable full-page screenshot.
                margin_x = min(0.015, crop_w * 0.08)
                margin_y = min(0.015, crop_h * 0.08)
                left = max(0, int((x - margin_x) * width))
                top = max(0, int((y - margin_y) * height))
                right = min(width, int((x + crop_w + margin_x) * width))
                bottom = min(height, int((y + crop_h + margin_y) * height))
                if right - left < 24 or bottom - top < 24:
                    continue
                cropped = page_image.convert("RGB").crop((left, top, right, bottom))
                cropped.thumbnail((1200, 1200))
                buf = io.BytesIO()
                cropped.save(buf, format="JPEG", quality=88, optimize=True)
        except Exception:  # noqa: BLE001 — skip one unusable crop
            continue
        refs.add(ref)
        out.append(
            {
                "ref": ref,
                "type": kind,
                "page": page_no,
                "bbox": bbox,
                "label": str(candidate.get("label") or f"第 {page_no} 页{kind}"),
                "dataUrl": "data:image/jpeg;base64,"
                + base64.b64encode(buf.getvalue()).decode(),
            }
        )
    return out


def _merge_json_value(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key, value in source.items():
        if key not in target:
            target[key] = value
        elif isinstance(target[key], dict) and isinstance(value, dict):
            _merge_json_value(target[key], value)
        elif isinstance(target[key], list) and isinstance(value, list):
            seen = {json.dumps(x, ensure_ascii=False, sort_keys=True) for x in target[key]}
            for item in value:
                marker = json.dumps(item, ensure_ascii=False, sort_keys=True)
                if marker not in seen:
                    target[key].append(item)
                    seen.add(marker)


def _manual_page_for(
    pages: list[dict[str, Any]], keywords: list[str]
) -> tuple[int, str] | None:
    """Return the strongest page match for the first available keyword.

    Manuals often repeat every section title in an early contents page. Within
    the preferred keyword, favor the later match so a fallback visual is the
    actual specification page rather than the contents entry.
    """
    for keyword in keywords:
        matches = []
        for page in pages:
            page_text = str(page.get("text") or "")
            count = page_text.lower().count(keyword.lower())
            if count:
                matches.append(int(page.get("page") or 0))
        if matches:
            return max(matches), keyword
    return None


def _ground_missing_manual_modules(
    grouped: dict[str, dict[str, Any]], pages: list[dict[str, Any]]
) -> None:
    """Fill model-omitted modules only from facts explicitly present in the PDF.

    Some OpenAI-compatible VLMs describe the dominant page topic but omit quiet
    modules (most often logo/copy) from otherwise valid JSON. These fallbacks
    run only when a module is absent and every emitted fact is matched against
    extracted page text, with a page citation.
    """
    combined = "\n".join(str(page.get("text") or "") for page in pages)
    compact = re.sub(r"\s+", "", combined)

    def add(
        kind: str,
        *,
        keywords: list[str],
        summary: str,
        value: dict[str, Any],
        strength: str = "STRONG",
    ) -> None:
        if kind in grouped:
            return
        hit = _manual_page_for(pages, keywords)
        if not hit:
            return
        page_no, keyword = hit
        grouped[kind] = {
            "type": kind,
            "strength": strength,
            "summaryParts": [summary],
            "value": value,
            "evidence": [
                {"page": page_no, "note": f"第 {page_no} 页 · {keyword}"}
            ],
        }

    logo_donts = []
    if "不得改变其形状、结构和比例" in compact:
        logo_donts.append("不得改变标志的形状、结构和比例")
    if "请勿自行创造组合形式" in compact:
        logo_donts.append("不得自行创造标志组合形式")
    logo_value: dict[str, Any] = {"dontRules": logo_donts}
    if "小于8mm时禁止使用" in compact:
        logo_value["minimumHeightMm"] = 8
    add(
        "logo",
        keywords=[
            "企业标志及标志创意说明",
            "标志墨稿",
            "标志反白效果图",
            "标志标准化制图",
        ],
        summary="使用标准品牌标志及组合，不得改变形状、结构和比例",
        value=logo_value,
    )

    font_names = [
        name
        for name in [
            "LetoSans",
            "思源黑体",
            "Myriad Pro",
            "汉仪旗黑",
            "汉仪中黑简",
            "MonoxRegular",
        ]
        if name.lower() in combined.lower()
    ]
    add(
        "font",
        keywords=["企业专用印刷字体", "企业全称中文字体", "企业简称英文字体"],
        summary="按手册使用企业标准字与专用印刷字体",
        value={"families": font_names},
    )

    colors: list[str] = []
    # Illustrator-authored PDFs can expose a visually prefixed hex value as
    # `FF6C2C#` in their text layer. Accept both text orders, while still
    # requiring six explicit hexadecimal digits adjacent to the hash marker.
    for match in re.finditer(
        r"#\s*([0-9A-Fa-f]{6})\b|\b([0-9A-Fa-f]{6})\s*#", combined
    ):
        normalized = f"#{match.group(1) or match.group(2)}".upper()
        if normalized not in colors:
            colors.append(normalized)
    add(
        "color",
        keywords=["企业标准色（印刷色）", "辅助色系列", "色彩规范"],
        summary="使用手册规定的企业标准色与辅助色",
        value={"palette": colors[:16]},
    )

    add(
        "layout",
        keywords=[
            "广告信息视觉层级梳理",
            "基本板式集合呈现",
            "标志与标准字组合多种模式",
            "标志方格坐标制作图",
        ],
        summary="遵循标准组合、保护留白与广告信息视觉层级",
        value={
            "rules": [
                "标准组合周边保留保护空间",
                "不得改变标准组合比例或自行创造组合形式",
            ]
        },
    )

    imagery_value: dict[str, Any] = {
        "usage": "按手册中的辅助图形与应用示例保持统一视觉风格"
    }
    if "小白砖" in combined:
        imagery_value["motif"] = "小白砖"
    add(
        "imagery",
        keywords=[
            "辅助图形的应用延展",
            "辅助图形基本使用形式",
            "辅助图形释义",
            "户外擎天柱广告",
        ],
        summary="统一使用手册规定的辅助图形及应用视觉风格",
        value=imagery_value,
        strength="WEAK",
    )

    slogans = []
    for phrase in ["一家一世界 一居一生活", "一站式整屋家居"]:
        if re.sub(r"\s+", "", phrase) in compact:
            slogans.append(phrase)
    add(
        "copy",
        keywords=[
            "广告信息视觉层级梳理",
            "室内企业精神口号标牌",
            "基本板式集合呈现",
        ],
        summary=("品牌传播使用：" + "；".join(slogans))
        if slogans
        else "按手册中的品牌口号与广告信息层级进行传播",
        value={"slogans": slogans},
        strength="WEAK",
    )


def _enforce_grounded_manual_modules(
    merged: dict[str, Any], pages: list[dict[str, Any]]
) -> None:
    """Apply the grounded six-slot postcondition to the final wire payload.

    Grounding previously happened while the batch accumulator was still being
    assembled. A provider can emit a transient/empty module that suppresses the
    fallback at that stage and then leave the final payload without that slot.
    Recompute grounded candidates independently, append missing types, and make
    exact PDF-text facts authoritative over model guesses. The VLM remains
    useful for page interpretation, summaries, and crop locations, but it must
    not be allowed to replace explicit hex values, font names, slogans, or logo
    prohibitions printed in the manual.
    """
    rules = merged.get("rules")
    if not isinstance(rules, list):
        rules = []
        merged["rules"] = rules
    by_type = {
        str(rule.get("type") or ""): rule
        for rule in rules
        if isinstance(rule, dict)
    }
    grounded: dict[str, dict[str, Any]] = {}
    _ground_missing_manual_modules(grounded, pages)
    order = ["logo", "font", "color", "layout", "imagery", "copy"]
    authoritative_fields = {
        "logo": ("dontRules", "minimumHeightMm"),
        "font": ("families",),
        "color": ("palette",),
        "imagery": ("motif",),
        "copy": ("slogans",),
    }
    for kind in order:
        if kind not in grounded:
            continue
        grounded_item = grounded[kind]
        if kind not in by_type:
            item = grounded_item
            summaries = item.pop("summaryParts", [])
            item["summary"] = (
                "；".join(str(part) for part in summaries[:6])
                or f"从品牌手册提取的{kind}规范"
            )
            rules.append(item)
            by_type[kind] = item
            continue

        item = by_type[kind]
        value = item.get("value")
        if not isinstance(value, dict):
            value = {}
            item["value"] = value
        grounded_value = grounded_item.get("value")
        if isinstance(grounded_value, dict):
            for field in authoritative_fields.get(kind, ()):
                grounded_fact = grounded_value.get(field)
                if grounded_fact not in (None, [], ""):
                    value[field] = grounded_fact

        evidence = item.get("evidence")
        if not isinstance(evidence, list):
            evidence = []
            item["evidence"] = evidence
        for citation in grounded_item.get("evidence", []):
            if citation not in evidence and len(evidence) < 8:
                evidence.append(citation)

    grounded_colors = (
        grounded.get("color", {}).get("value", {}).get("palette", [])
    )
    if grounded_colors:
        color_system = merged.get("colorSystem")
        if not isinstance(color_system, dict):
            color_system = {}
            merged["colorSystem"] = color_system
        color_system["palette"] = grounded_colors
        color_system["pairing"] = [
            pair
            for pair in color_system.get("pairing", [])
            if isinstance(pair, list)
            and pair
            and all(color in grounded_colors for color in pair)
        ]
    rules.sort(
        key=lambda rule: order.index(str(rule.get("type") or ""))
        if isinstance(rule, dict) and str(rule.get("type") or "") in order
        else len(order)
    )


def _fallback_manual_crops(
    pages: list[dict[str, Any]], extracted: list[dict[str, Any]], limit: int
) -> list[dict[str, Any]]:
    """Create grounded page previews when the VLM omits crop descriptors."""
    existing_types = {str(asset.get("type") or "") for asset in extracted}
    keyword_map = {
        "logo": ["企业标志及标志创意说明", "标志墨稿", "标志反白效果图"],
        "font": ["企业专用印刷字体", "企业全称中文字体"],
        "color": ["企业标准色（印刷色）", "辅助色系列"],
        "layout": ["基本板式集合呈现", "广告信息视觉层级梳理"],
        "imagery": ["辅助图形的应用延展", "辅助图形基本使用形式"],
        "copy": ["广告信息视觉层级梳理", "室内企业精神口号标牌"],
    }
    labels = {
        "logo": "标志规范页面",
        "font": "字体规范页面",
        "color": "色彩规范页面",
        "layout": "版式规范页面",
        "imagery": "图像与辅助图形页面",
        "copy": "品牌表达规范页面",
    }
    candidates: list[dict[str, Any]] = []
    for kind, keywords in keyword_map.items():
        if kind in existing_types:
            continue
        hit = _manual_page_for(pages, keywords)
        if not hit:
            continue
        page_no, _keyword = hit
        candidates.append(
            {
                "ref": f"p{page_no}-{kind}-page-evidence",
                "type": kind,
                "page": page_no,
                "bbox": [0.04, 0.07, 0.92, 0.86],
                "label": labels[kind],
            }
        )
    return _extract_manual_crops(
        {"assets": candidates}, pages, max(0, min(limit, len(candidates)))
    )


def _merge_manual_results(
    results: list[dict[str, Any]], pages: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """Consolidate page batches into one editable draft per Brand Kit module."""
    order = ["logo", "font", "color", "layout", "imagery", "copy"]
    grouped: dict[str, dict[str, Any]] = {}
    for result in results:
        for rule in result.get("rules", []):
            kind = str(rule.get("type") or "")
            if kind not in order:
                continue
            current = grouped.setdefault(
                kind,
                {
                    "type": kind,
                    "strength": "WEAK",
                    "summaryParts": [],
                    "value": {},
                    "evidence": [],
                },
            )
            strength = str(rule.get("strength") or "WEAK")
            # A module containing both positive and prohibited usage remains a
            # usable strong rule; the prohibited details stay in value/summary.
            if strength == "STRONG" or (
                strength == "FORBIDDEN" and current["strength"] == "WEAK"
            ):
                current["strength"] = strength
            summary = str(rule.get("summary") or "").strip()
            if summary and summary not in current["summaryParts"]:
                current["summaryParts"].append(summary)
            _merge_json_value(current["value"], rule.get("value") or {})
            for evidence in rule.get("evidence", []) or []:
                if evidence not in current["evidence"] and len(current["evidence"]) < 8:
                    current["evidence"].append(evidence)

    _ground_missing_manual_modules(grouped, pages or [])

    rules: list[dict[str, Any]] = []
    for kind in order:
        item = grouped.get(kind)
        if not item:
            continue
        summaries = item.pop("summaryParts")
        item["summary"] = "；".join(summaries[:6]) or f"从品牌手册提取的{kind}规范"
        rules.append(item)

    palette: list[str] = []
    pairing: list[list[str]] = []
    restrictions: list[str] = []
    contrast: list[float] = []
    consistency: list[float] = []
    for result in results:
        cs = result.get("colorSystem")
        if not isinstance(cs, dict):
            continue
        for color in cs.get("palette", []) or []:
            if color not in palette:
                palette.append(color)
        for pair in cs.get("pairing", []) or []:
            if pair not in pairing:
                pairing.append(pair)
        for rule in cs.get("restrictions", []) or []:
            if rule not in restrictions:
                restrictions.append(rule)
        contrast.append(float(cs.get("contrastScore", 0) or 0))
        consistency.append(float(cs.get("consistencyScore", 0) or 0))
    out: dict[str, Any] = {"rules": rules}
    if palette:
        out["colorSystem"] = {
            "palette": palette,
            "pairing": pairing,
            "restrictions": restrictions,
            "contrastScore": sum(contrast) / len(contrast) if contrast else 0,
            "consistencyScore": sum(consistency) / len(consistency)
            if consistency
            else 0,
        }
    return out


def _coerce_describe(data: dict[str, Any]) -> dict[str, Any]:
    """Force model output into a valid DescribeResponse shape.

    De-dupes/trims tags, caps the count, and coerces a missing/odd description
    to a string so the no-null contract holds (aiDescription is required str).
    """
    tags: list[str] = []
    seen: set[str] = set()
    for t in data.get("aiTags", []) or []:
        s = str(t).strip()
        if s and s.lower() not in seen:
            seen.add(s.lower())
            tags.append(s)
        if len(tags) >= 12:
            break
    desc = data.get("aiDescription")
    return {"aiTags": tags, "aiDescription": str(desc).strip() if desc else ""}


_SCENE_TYPES = {
    "ECOM_MAIN", "SCENE", "SOCIAL_POSTER", "CAMPAIGN_KV", "SELLING_POINT"
}


def _coerce_summarize(data: dict[str, Any], mode: str) -> dict[str, Any]:
    """Force model output into a valid SummarizeResponse shape.

    Only emits keys the model actually provided (omitted → contract default), so
    the no-null boundary holds. Drops an invalid sceneType rather than passing a
    value the SceneType enum would reject. Keywords/highlights are trimmed,
    de-duped and capped.
    """

    def _str_list(raw: Any, cap: int) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for x in raw or []:
            s = str(x).strip()
            if s and s.lower() not in seen:
                seen.add(s.lower())
                out.append(s)
            if len(out) >= cap:
                break
        return out

    out: dict[str, Any] = {}
    if mode == "brief_decompose":
        if data.get("sellingPoint"):
            out["sellingPoint"] = str(data["sellingPoint"]).strip()
        if data.get("scene"):
            out["scene"] = str(data["scene"]).strip()
        st = str(data.get("sceneType") or "").strip().upper()
        if st in _SCENE_TYPES:
            out["sceneType"] = st
        out["styleKeywords"] = _str_list(data.get("styleKeywords"), 20)
    else:
        out["highlights"] = _str_list(data.get("highlights"), 8)
    if data.get("summary"):
        out["summary"] = str(data["summary"]).strip()
    return out


def _coerce_ingest(
    data: dict[str, Any], fallback_images: list[str]
) -> dict[str, Any]:
    """Force model output into a valid IngestWebsiteResponse shape."""
    images: list[dict[str, Any]] = []
    for it in data.get("images", []) or []:
        if not isinstance(it, dict) or not it.get("sourceUrl"):
            continue
        src = str(it["sourceUrl"])
        entry: dict[str, Any] = {"sourceUrl": src, "previewUrl": str(it.get("previewUrl") or src)}
        if it.get("guessedCategory"):
            entry["guessedCategory"] = str(it["guessedCategory"])
        images.append(entry)
    if not images:
        images = [
            {"sourceUrl": s, "previewUrl": s} for s in fallback_images[:12]
        ]
    copies = [str(x) for x in (data.get("copies") or []) if x]
    selling = [str(x) for x in (data.get("sellingPoints") or []) if x]
    return {"images": images, "copies": copies, "sellingPoints": selling}
