import base64
import io
import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .config import settings
from .ssrf import SSRFError, safe_get

logger = logging.getLogger("brandai.ai")
from .providers import resolve_image_provider, resolve_vlm_provider
from .providers.base import ImageProvider, VLMProvider
from .providers.http_providers import (
    _DEFAULT_IMAGE_QUALITY,
    _estimate_cost_usd,
    _snap_openai_size,
)
from .schemas import (
    ComplianceCheckRequest,
    ComplianceCheckResponse,
    ComplianceReport,
    ComplianceResult,
    DescribeRequest,
    DescribeResponse,
    EditRequest,
    EditResponse,
    GenerateRequest,
    GenerateResponse,
    GenerateUsage,
    GeneratedVersion,
    IngestWebsiteRequest,
    IngestWebsiteResponse,
    ParseManualRequest,
    ParseManualResponse,
    RecognizeRequest,
    RecognizeResponse,
    SummarizeRequest,
    SummarizeResponse,
)


def _call_cost(kind: str, width: int, height: int, n: int) -> float | None:
    """T-conn-b — best-effort USD for one generate call. openai sizes are snapped
    to the priced set; other vendors use the literal canvas; mock/unpriced → None."""
    size = _snap_openai_size(width, height) if kind == "openai" else f"{width}x{height}"
    return _estimate_cost_usd(kind, size, _DEFAULT_IMAGE_QUALITY, n)

async def _probe_image_size(image_ref: str) -> tuple[int, int] | None:
    """K5 — decode the actual pixel W×H of a generated image.

    Handles both ``data:`` URLs (gpt-image-1 returns base64) and hosted http(s)
    URLs (fetched SSRF-guarded — these are our own generator output, so the
    initial host is trusted; redirect hops are validated). Best-effort: returns
    None on any failure so a probe miss never breaks generation — the worker
    simply keeps the requested size as the only recorded dimensions.
    """
    from PIL import Image

    try:
        if image_ref.startswith("data:"):
            raw = base64.b64decode(image_ref.split(",", 1)[1])
        elif image_ref.startswith(("http://", "https://")):
            async with httpx.AsyncClient(timeout=settings.http_timeout) as c:
                r = await safe_get(c, image_ref, allow_private_initial=True)
                r.raise_for_status()
                raw = r.content
        else:
            return None
        with Image.open(io.BytesIO(raw)) as im:
            w, h = im.size
        if w > 0 and h > 0:
            return int(w), int(h)
        return None
    except (SSRFError, Exception):  # noqa: BLE001 — best-effort; never break gen
        return None


app = FastAPI(title="OpenVisual AI Service", version="0.1.0")


@app.exception_handler(httpx.HTTPError)
async def _provider_http_error(_request, exc: httpx.HTTPError):
    """Translate any upstream provider failure into a clean, readable error
    instead of an opaque 500 — this is what surfaces as the generation's failure
    reason in the UI. Covers HTTP status errors (e.g. OpenAI 401 bad key) AND
    transport errors like ReadTimeout (slow image model)."""
    resp = getattr(exc, "response", None)
    if resp is not None:
        body = (resp.text or "")[:300]
        return JSONResponse(
            status_code=502,
            content={"detail": f"AI provider returned {resp.status_code}: {body}"},
        )
    if isinstance(exc, httpx.TimeoutException):
        return JSONResponse(
            status_code=504,
            content={
                "detail": (
                    f"AI provider timed out after {settings.http_timeout:.0f}s "
                    f"({type(exc).__name__}). The image model may be slow — "
                    "retry, or raise AI_HTTP_TIMEOUT_SECONDS."
                )
            },
        )
    return JSONResponse(
        status_code=502,
        content={"detail": f"AI provider request failed: {type(exc).__name__}: {exc}"},
    )

_SCENE_SIZES = {
    "ECOM_MAIN": (1024, 1024),
    "SCENE": (1280, 960),
    "SOCIAL_POSTER": (1080, 1350),
    "CAMPAIGN_KV": (1920, 1080),
    "SELLING_POINT": (1080, 1080),
}

# Baseline ad-compliance lexicon (M5 owner extends this).
_RISK_LEXICON = {
    "ABSOLUTE": ["第一", "最佳", "顶级", "唯一", "最", "极致"],
    "EFFICACY": ["必瘦", "根治", "永久有效", "速效", "包治"],
    "EXAGGERATION": ["稳赚", "100%", "暴涨", "秒杀全网"],
    "AUTHORITY": ["官方认证", "国家级", "行业第一", "权威推荐"],
}


@app.get("/health")
async def health():
    # Exposed only through the authenticated/web health aggregator. The parser
    # revision makes cross-branch CDS routing mistakes observable without
    # exposing provider credentials or the internal AI API publicly.
    return {"status": "ok", "parserRevision": "grounded-six-slot-r6"}


@app.post("/v1/diag")
async def diag(
    image: ImageProvider = Depends(resolve_image_provider),
    vlm: VLMProvider = Depends(resolve_vlm_provider),
):
    """Cheap self-check for the resolved image + vlm providers.

    Runs each provider's `.check()` (a `GET /models` auth probe, or the mock's
    placeholder). Always returns a structured `{ ok, detail }` per provider —
    never 500 — so the admin settings page can show the REAL per-item error
    (bad key 401, unreachable endpoint, etc.) in seconds."""
    img = await image.check()
    vis = await vlm.check()
    return {
        "image": {"ok": img.ok, "detail": img.detail},
        "vlm": {"ok": vis.ok, "detail": vis.detail},
    }


@app.post("/v1/ingest/website", response_model=IngestWebsiteResponse, response_model_exclude_none=True)
async def ingest_website(
    req: IngestWebsiteRequest,
    vlm: VLMProvider = Depends(resolve_vlm_provider),
):
    data = await vlm.scrape_website(req.url)
    return IngestWebsiteResponse(**data)


@app.post("/v1/recognize", response_model=RecognizeResponse, response_model_exclude_none=True)
async def recognize(
    req: RecognizeRequest,
    vlm: VLMProvider = Depends(resolve_vlm_provider),
):
    data = await vlm.analyze_assets(
        [a.model_dump() for a in req.assets]
    )
    return RecognizeResponse(**data)


@app.post("/v1/describe", response_model=DescribeResponse, response_model_exclude_none=True)
async def describe(
    req: DescribeRequest,
    vlm: VLMProvider = Depends(resolve_vlm_provider),
):
    """E9/E10 — auto-tag one image asset (tags + description) for the library."""
    data = await vlm.describe_asset(
        req.url,
        category=req.category,
        brand_tone=req.brandTone,
        source=req.source,
    )
    return DescribeResponse(**data)


@app.post("/v1/summarize", response_model=SummarizeResponse, response_model_exclude_none=True)
async def summarize(
    req: SummarizeRequest,
    vlm: VLMProvider = Depends(resolve_vlm_provider),
):
    """B2/C8 — text-only VLM (chat) over a brand brief / campaign context.

    mode="brief_decompose": decompose a free-text brief into creation seeds.
    mode="campaign_summary": condense a campaign's context into a summary.
    """
    data = await vlm.summarize(
        req.mode,
        req.text,
        context=req.context.model_dump() if req.context else None,
    )
    return SummarizeResponse(**data)


_MAX_MANUAL_PAGES = 120
_MANUAL_RENDER_MAX_EDGE = 1400


def _page_data_url(image) -> str:
    """Encode a rendered PDF page as bounded JPEG for multimodal analysis."""
    image = image.convert("RGB")
    image.thumbnail((_MANUAL_RENDER_MAX_EDGE, _MANUAL_RENDER_MAX_EDGE))
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=82, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()


async def _fetch_pdf_manual(
    url: str,
) -> tuple[str, list[dict[str, Any]], int, list[str]]:
    """Fetch and inspect a brand manual through text + rendered-page channels.

    Text extraction alone misses scanned manuals and every visual rule shown in
    logos, color cards, typography specimens and photography examples. PDFium
    renders those pages so the VLM sees the actual manual; pypdf still provides
    page-labelled text for exact names, hex values and prose constraints.
    """
    from pypdf import PdfReader
    import pypdfium2 as pdfium

    warnings: list[str] = []
    try:
        async with httpx.AsyncClient(timeout=settings.http_timeout) as c:
            r = await safe_get(c, url, allow_private_initial=True)
            r.raise_for_status()
            content = r.content

        reader = PdfReader(io.BytesIO(content))
        page_count = len(reader.pages)
        text_parts: list[str] = []
        page_texts: list[str] = []
        for index, page in enumerate(reader.pages):
            try:
                page_text = (page.extract_text() or "").strip()
            except Exception:  # noqa: BLE001 — one malformed page must not sink all
                page_text = ""
            page_texts.append(page_text)
            if page_text:
                text_parts.append(f"[第 {index + 1} 页]\n{page_text}")

        rendered: list[dict[str, Any]] = []
        document = pdfium.PdfDocument(content)
        render_count = min(len(document), _MAX_MANUAL_PAGES)
        if len(document) > _MAX_MANUAL_PAGES:
            warnings.append(
                f"手册共 {len(document)} 页；为保证任务有界，本次视觉解析前 {_MAX_MANUAL_PAGES} 页。"
            )
        for index in range(render_count):
            try:
                page = document[index]
                # PDF points are usually ~600–900px at scale 1.5. Keep a hard
                # edge cap during JPEG encoding to bound provider payload size.
                bitmap = page.render(scale=1.5)
                data_url = _page_data_url(bitmap.to_pil())
                rendered.append(
                    {
                        "page": index + 1,
                        "dataUrl": data_url,
                        "text": page_texts[index] if index < len(page_texts) else "",
                    }
                )
            except Exception as exc:  # noqa: BLE001 — retain other pages
                logger.warning("manual page %s render failed: %s", index + 1, exc)
        return "\n\n".join(text_parts).strip(), rendered, page_count, warnings
    except Exception as exc:  # noqa: BLE001 — fail closed, never invent a kit
        logger.warning("manual fetch/extraction failed: %s", exc)
        return "", [], 0, ["PDF 无法读取或文件已损坏，请检查后重试。"]


async def _fetch_pdf_text(url: str) -> str:
    """Compatibility helper retained for direct extraction tests/callers."""
    text, _pages, _count, _warnings = await _fetch_pdf_manual(url)
    return text


@app.post("/v1/parse-manual", response_model=ParseManualResponse, response_model_exclude_none=True)
async def parse_manual(
    req: ParseManualRequest,
    vlm: VLMProvider = Depends(resolve_vlm_provider),
):
    """Parse a brand/VI manual PDF into DRAFT brand rules.

    The VLM receives page-labelled text and rendered page images, then returns
    editable rules plus cropped visual evidence for the six Brand Kit modules.
    """
    text, pages, page_count, warnings = await _fetch_pdf_manual(req.url)
    # Fail closed only when neither channel yielded evidence. A scanned manual
    # legitimately has no text but is still analyzable through rendered pages.
    if not text.strip() and not pages:
        return ParseManualResponse(
            rules=[], pageCount=page_count, warnings=warnings
        )
    data = await vlm.parse_manual(text, pages=pages)
    provider_warnings = data.pop("warnings", [])
    return ParseManualResponse(
        **data,
        pageCount=page_count,
        warnings=[*warnings, *provider_warnings],
    )


@app.post("/v1/generate", response_model=GenerateResponse, response_model_exclude_none=True)
async def generate(
    req: GenerateRequest,
    provider: ImageProvider = Depends(resolve_image_provider),
):
    base_w, base_h = _SCENE_SIZES.get(req.sceneType, (1024, 1024))
    rule_summary = "; ".join(
        r.summary for r in req.brandRules if r.status == "CONFIRMED"
    )
    # P1.2 — fold compiled promptAdditions into the prompt and machineRules
    # into width/height where possible.
    prompt_parts = [
        f"[{req.sceneType}] {req.sellingPoint}. Scene: {req.scene}.",
        f"Brand rules: {rule_summary}",
    ]
    negative: list[str] = []
    machine_rules: dict[str, Any] = {}
    prompt_additions: list[str] = []
    # D5 — positive/negative example assets (resolved URLs) the web worker
    # compiled from the workspace's prohibition rules.
    reference_images: list[dict[str, Any]] = []
    positive_refs: list[dict[str, Any]] = []
    negative_refs: list[dict[str, Any]] = []
    strict_refs: list[dict[str, Any]] = []
    if req.aiConstraints is not None:
        negative = list(req.aiConstraints.negativePrompt or [])
        prompt_additions = list(req.aiConstraints.promptAdditions or [])
        machine_rules = dict(req.aiConstraints.machineRules or {})
        if prompt_additions:
            prompt_parts.append("Additions: " + " | ".join(prompt_additions))
        reference_images = [
            r.model_dump(exclude_none=True)
            for r in req.aiConstraints.referenceImages
        ]
        positive_refs = [r for r in reference_images if r.get("polarity") == "positive"]
        negative_refs = [r for r in reference_images if r.get("polarity") == "negative"]
        strict_refs = [
            r
            for r in positive_refs
            if str(r.get("mode") or "").upper() == "STRICT"
            or str(r.get("note") or "").startswith("STRICT_USE:")
        ]
        if len(strict_refs) > 1:
            raise HTTPException(
                status_code=400,
                detail=(
                    "V0.0.8 currently supports one STRICT reference asset per "
                    "generation. Keep one mandatory asset and set the others to "
                    "INSPIRATION."
                ),
            )
        if positive_refs:
            prompt_parts.append(
                "Match the visual style, palette, composition and treatment of "
                f"the {len(positive_refs)} provided positive reference example(s)."
            )
        if negative_refs:
            prompt_parts.append(
                "Do NOT resemble the provided negative reference example(s); "
                "avoid the treatment they illustrate."
            )
            # Fold each negative example's note (the prohibition description)
            # into the negative prompt so even providers that cannot read image
            # references still receive the textual avoidance signal.
            for r in negative_refs:
                note = r.get("note")
                if note and note not in negative:
                    negative.append(note)

    # M3 — layered text mode. Steer the model to produce a CLEAN background with
    # generous negative space and NO baked-in text; the web client overlays the
    # real, crisp, editable text afterwards. `direct` (default) is untouched.
    if req.textMode == "layered":
        prompt_parts.append(
            "Clean composition with generous empty negative space for a "
            "headline; do NOT render any text, letters, words, captions or "
            "logos in the image."
        )
        _layered_negatives = [
            "text",
            "letters",
            "words",
            "caption",
            "watermark",
            "typography",
        ]
        # Merge with any existing negatives, preserving order and de-duping.
        for term in _layered_negatives:
            if term not in negative:
                negative.append(term)

    prompt = " ".join(prompt_parts)

    # V0.0.7+ — positive refs the caller marked STRICT (100% 调用). Their pixels
    # must reach the model via image-to-image (resolved once provider kind is
    # known, below); INSPIRATION refs stay a text steer only. Carry sourceHint
    # so the provider applies the K7 SSRF policy per reference (WEBSITE → strict
    # initial-host check).
    strict_refs = [
        {**r, "sourceHint": r.get("sourceHint")}
        for r in positive_refs
        if r.get("mode") == "STRICT" and r.get("url")
    ]

    # aspect_ratio override: "W:H" → derive a matched (w,h) keeping base area.
    w, h = base_w, base_h
    ar = machine_rules.get("aspect_ratio")
    if isinstance(ar, str) and ":" in ar:
        try:
            aw, ah = ar.split(":")
            ratio_w, ratio_h = int(aw), int(ah)
            if ratio_w > 0 and ratio_h > 0:
                # Keep the longer edge of the base size; scale the other axis.
                if ratio_w >= ratio_h:
                    w = base_w
                    h = max(1, int(round(base_w * ratio_h / ratio_w)))
                else:
                    h = base_h
                    w = max(1, int(round(base_h * ratio_w / ratio_h)))
        except ValueError:
            pass

    # D5 — forward reference image URLs to the provider via `extra`. The basic
    # OpenAI images endpoint drops them (best-effort, like negative_prompt); an
    # img2img-capable gateway can read `reference_images`. The textual steer
    # above is the portable signal. V0.0.8 handles STRICT references separately
    # below with provider.edit(), so STRICT no longer silently degrades here.
    provider_extra: dict[str, Any] = dict(machine_rules)
    if reference_images:
        provider_extra["reference_images"] = [r["url"] for r in reference_images]
        if positive_refs:
            provider_extra["positive_reference_images"] = [
                r["url"] for r in positive_refs
            ]
        if negative_refs:
            provider_extra["negative_reference_images"] = [
                r["url"] for r in negative_refs
            ]

    def _echo_params(extra: dict[str, Any] | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {
            "prompt": prompt,
            "sceneType": req.sceneType,
            "textMode": req.textMode,
            "appliedRules": [
                r.id for r in req.brandRules if r.status == "CONFIRMED"
            ],
        }
        # M3 — when layered, surface the no-text negatives that were applied so
        # callers (and L3) can prove the model was steered away from rendering
        # text. (In direct mode no extra negatives are added by text mode.)
        if req.textMode == "layered":
            params["appliedTextModeNegatives"] = negative
        if req.aiConstraints is not None:
            # Mock provider echo — L3 asserts these keys round-trip from the
            # web worker through the AI service into GenerationVersion.params.
            params["appliedNegativePrompt"] = negative
            params["appliedPromptAdditions"] = prompt_additions
            params["machineRulesApplied"] = machine_rules
            # D5 — echo the positive/negative example assets that shaped the
            # image so the worker/L3 can prove they rode through.
            params["appliedReferenceImages"] = reference_images
            # Legacy provider-style keys for raw-response inspection.
            params["negative_prompt"] = negative
            params["machine_rules"] = machine_rules
            params["prompt_additions"] = prompt_additions
        if extra:
            params.update(extra)
        return params

    strict_ref = strict_refs[0] if strict_refs else None

    async def _strict_edit_version(
        *,
        width: int,
        height: int,
        extra_params: dict[str, Any] | None = None,
    ) -> GeneratedVersion:
        if not strict_ref:
            raise RuntimeError("STRICT reference missing")
        strict_prompt = (
            "Use the input image as a mandatory locked asset. Preserve the "
            "input asset's identity, shape, marks, product details and visible "
            "content exactly. You may only resize, reposition, preserve aspect "
            "ratio, and apply requested color treatment. Do not replace, redraw, "
            "reinterpret, omit, crop away, or invent a substitute for the input "
            f"asset.\n\nGeneration brief: {prompt}"
        )
        if negative:
            strict_prompt += "\n\nAvoid: " + "; ".join(s for s in negative if s)
        if kind == "openai" and hasattr(provider, "generate_with_references"):
            urls = await provider.generate_with_references(
                strict_prompt,
                [strict_ref],
                width=width,
                height=height,
                n=1,
                quality=(provider_extra or {}).get("quality"),
                model=(provider_extra or {}).get("model"),
            )
            if not urls:
                raise HTTPException(
                    status_code=502,
                    detail="AI provider returned no image for STRICT reference",
                )
            image_url = urls[0]
        else:
            image_url = await provider.edit(
                strict_ref["url"],
                "STRICT_REFERENCE_GENERATE",
                {
                    "prompt": strict_prompt,
                    "width": width,
                    "height": height,
                },
            )
        actual = await _probe_image_size(image_url)
        params_extra: dict[str, Any] = {
            "generationPath": "strict_image_input",
            "strictReferenceImage": strict_ref,
            "strictReferencePolicy": "provider.edit image input; no text-only fallback",
            **(
                {"actualWidth": actual[0], "actualHeight": actual[1]}
                if actual
                else {}
            ),
        }
        if extra_params:
            params_extra.update(extra_params)
        return GeneratedVersion(
            imageUrl=image_url,
            width=width,
            height=height,
            actualWidth=actual[0] if actual else None,
            actualHeight=actual[1] if actual else None,
            params=_echo_params(params_extra),
        )

    # T-conn-b — usage/cost for the dashboard. `kind`/`model` are read off the
    # resolved provider (absent on mock).
    kind = getattr(provider, "kind", "mock")
    model = getattr(provider, "model", "") or None

    async def _emit(gw: int, gh: int, gn: int) -> list[str]:
        return await provider.generate(
            prompt,
            width=gw,
            height=gh,
            n=gn,
            negative=negative or None,
            extra=provider_extra or None,
        )

    # P2.0 — multi-size fan-out. When targets are present, ignore versionCount
    # and the sceneType default size: emit exactly one image per target at its
    # own W×H, stamping targetKey/targetLabel into params.
    if req.targets:
        versions: list[GeneratedVersion] = []
        started = time.perf_counter()
        total_cost = 0.0
        any_cost = False
        tok_sum = 0
        any_tok = False
        for t in req.targets:
            if strict_ref:
                versions.append(
                    await _strict_edit_version(
                        width=t.width,
                        height=t.height,
                        extra_params={"targetKey": t.key, "targetLabel": t.label},
                    )
                )
            else:
                urls = await _emit(t.width, t.height, 1)
            # A provider may return no image for a target (filtered/empty
            # response). Surface a controlled 502 with the failing target rather
            # than an opaque 500 IndexError on urls[0].
                if not urls:
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            f"AI provider returned no image for target "
                            f"{t.key} ({t.width}x{t.height})"
                        ),
                    )
                actual = await _probe_image_size(urls[0])
                versions.append(
                    GeneratedVersion(
                        imageUrl=urls[0],
                        width=t.width,
                        height=t.height,
                        actualWidth=actual[0] if actual else None,
                        actualHeight=actual[1] if actual else None,
                        params=_echo_params(
                            {
                                "targetKey": t.key,
                                "targetLabel": t.label,
                                **(
                                    {"actualWidth": actual[0], "actualHeight": actual[1]}
                                    if actual
                                    else {}
                                ),
                            }
                        ),
                    )
                )
            c = _call_cost(kind, t.width, t.height, 1)
            if c is not None:
                total_cost += c
                any_cost = True
            tok = getattr(provider, "last_total_tokens", None)
            if tok is not None:
                tok_sum += tok
                any_tok = True
        usage = GenerateUsage(
            provider=kind,
            model=model,
            size=f"multi×{len(req.targets)}",
            imageCount=len(versions),
            costUsd=round(total_cost, 4) if any_cost else None,
            latencyMs=int((time.perf_counter() - started) * 1000),
            totalTokens=tok_sum if any_tok else None,
        )
        return GenerateResponse(versions=versions, usage=usage)

    started = time.perf_counter()
    if strict_ref:
        versions = [
            await _strict_edit_version(width=w, height=h)
            for _ in range(req.versionCount)
        ]
        return GenerateResponse(
            versions=versions,
            usage=GenerateUsage(
                provider=kind,
                model=model,
                size=f"{w}x{h}",
                imageCount=len(versions),
                costUsd=_call_cost(kind, w, h, len(versions)),
                latencyMs=int((time.perf_counter() - started) * 1000),
                totalTokens=getattr(provider, "last_total_tokens", None),
            ),
        )
    urls = await _emit(w, h, req.versionCount)
    usage = GenerateUsage(
        provider=kind,
        model=model,
        size=f"{w}x{h}",
        imageCount=len(urls),
        costUsd=_call_cost(kind, w, h, len(urls)),
        latencyMs=int((time.perf_counter() - started) * 1000),
        totalTokens=getattr(provider, "last_total_tokens", None),
    )
    versions = []
    for u in urls:
        actual = await _probe_image_size(u)
        versions.append(
            GeneratedVersion(
                imageUrl=u,
                width=w,
                height=h,
                actualWidth=actual[0] if actual else None,
                actualHeight=actual[1] if actual else None,
                params=_echo_params(
                    {"actualWidth": actual[0], "actualHeight": actual[1]}
                    if actual
                    else {}
                ),
            )
        )
    return GenerateResponse(versions=versions, usage=usage)


@app.post("/v1/edit", response_model=EditResponse, response_model_exclude_none=True)
async def edit(
    req: EditRequest,
    provider: ImageProvider = Depends(resolve_image_provider),
):
    url = await provider.edit(req.imageUrl, req.op, req.payload)
    w = int(req.payload.get("width", 1024))
    h = int(req.payload.get("height", 1024))
    return EditResponse(
        imageUrl=url, width=w, height=h, params={"op": req.op, **req.payload}
    )


def _scan_text(text: str, term_lib) -> list[ComplianceResult]:
    results: list[ComplianceResult] = []
    for t in term_lib:
        if t.term and t.term in text:
            results.append(
                ComplianceResult(
                    level="FORBIDDEN" if t.type == "FORBIDDEN" else "RISK",
                    span=t.term,
                    reason=t.reason,
                    replacement=t.replacement,
                    category="BRAND_TERM",
                )
            )
    for category, words in _RISK_LEXICON.items():
        for w in words:
            if w in text and not any(r.span == w for r in results):
                results.append(
                    ComplianceResult(
                        level="RISK",
                        span=w,
                        reason=f"{category} 风险表达，存在广告法合规风险",
                        replacement=None,
                        category=category,
                    )
                )
    return results


@app.post("/v1/compliance/check", response_model=ComplianceCheckResponse, response_model_exclude_none=True)
async def compliance_check(
    req: ComplianceCheckRequest,
    vlm: VLMProvider = Depends(resolve_vlm_provider),
):
    text_results = _scan_text(req.text or "", req.termLib)
    visual_results: list[ComplianceResult] = []
    score: int | None = None
    if req.imageUrl:
        # D5 — only pass `references` when present so providers/fakes with the
        # pre-D5 signature still work (the kwarg is additive).
        ref_kwargs: dict[str, Any] = {}
        if req.referenceImages:
            ref_kwargs["references"] = [
                r.model_dump(exclude_none=True) for r in req.referenceImages
            ]
        visual = await vlm.check_visual_compliance(
            req.imageUrl, [r.model_dump() for r in req.brandRules], **ref_kwargs
        )
        visual_results = [ComplianceResult(**r) for r in visual.get("results", [])]
        score = visual.get("score")

    levels = [r.level for r in text_results + visual_results]
    overall = (
        "FORBIDDEN"
        if "FORBIDDEN" in levels
        else "RISK"
        if "RISK" in levels
        else "PASS"
    )
    # Deterministic fallback so an image-checked version ALWAYS gets a brand
    # score, even when the VLM omits the numeric `score` from its JSON: start at
    # 100 and dock per visual issue (FORBIDDEN −40, RISK −15).
    if score is None and req.imageUrl:
        penalty = sum(
            40 if r.level == "FORBIDDEN" else 15 if r.level == "RISK" else 0
            for r in visual_results
        )
        score = max(0, 100 - penalty)
    report = ComplianceReport(
        overall=overall,
        textResults=text_results,
        visualResults=visual_results,
        checkedAt=datetime.now(timezone.utc).isoformat(),
        score=score,
    )
    return ComplianceCheckResponse(
        results=text_results + visual_results, report=report
    )
