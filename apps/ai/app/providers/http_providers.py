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
import base64
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

# gpt-image-1 only accepts these three sizes (plus "auto"); any other W×H is a
# hard 400. We snap the requested canvas to the nearest by aspect ratio.
_OPENAI_SIZES = ("1024x1024", "1024x1536", "1536x1024")
_DEFAULT_IMAGE_QUALITY = "medium"

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


# 改图 op → 自然语言 prompt 前缀(OpenAI /images/edits 只吃文字 prompt)。
_EDIT_OP_PROMPTS = {
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
    async def _load_image_bytes(self, image_url: str) -> bytes:
        """取源图字节:data: URL 直接 base64 解码;http(s) 经 SSRF 安全取流。"""
        if image_url.startswith("data:"):
            return base64.b64decode(image_url.split(",", 1)[1])
        async with self._client() as c:
            r = await safe_get(c, image_url, allow_private_initial=True)
            r.raise_for_status()
            return r.content

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
                    r = await c.post(
                        f"{self.base_url}/images/edits",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        files={"image": ("image.png", img_bytes, "image/png")},
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
    "You are a senior brand visual analyst. You read a brand's VI / brand "
    "manual (the extracted text of a PDF) and distil its visual identity. "
    "Reply with STRICT JSON only — no prose, no code fences."
)
_PARSE_MANUAL_PROMPT = (
    "Read this brand/VI manual text and return JSON shaped exactly as:\n"
    "{{\"rules\":[{{\"type\":\"color|font|layout|imagery|copy\","
    "\"strength\":\"STRONG|WEAK|FORBIDDEN\",\"summary\":\"<concise Chinese>\","
    "\"value\":{{<structured detail>}},"
    "\"evidence\":[{{\"note\":\"<which section / page of the manual>\"}}]}}],"
    "\"colorSystem\":{{\"palette\":[\"#hex\"],\"pairing\":[[\"#hex\",\"#hex\"]],"
    "\"restrictions\":[\"<rule>\"],\"contrastScore\":<0-100>,\"consistencyScore\":<0-100>}}}}\n"
    "Cover color, font, layout, imagery and copy where the manual states rules. "
    "Mark forbidden usages (禁用) with strength FORBIDDEN. Cite the manual "
    "section in each evidence note.\n\nManual text:\n{text}"
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

    async def parse_manual(self, text: str) -> dict[str, Any]:
        prompt = _PARSE_MANUAL_PROMPT.format(text=text[:_MAX_SCRAPE_TEXT])
        data = await self._chat_json(
            [{"type": "text", "text": prompt}], system=_PARSE_MANUAL_SYSTEM
        )
        # No image assetId to backfill — manual evidence is textual (note only),
        # the web worker stamps the VI_DOC assetId onto each rule's evidence.
        return _coerce_recognize(data, [])

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
        rules.append(
            {
                "type": str(r.get("type", "imagery")),
                "strength": str(r.get("strength", "WEAK")).upper(),
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
