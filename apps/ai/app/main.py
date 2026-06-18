import io
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse

from .config import settings
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
    EditRequest,
    EditResponse,
    GenerateRequest,
    GenerateResponse,
    GenerateUsage,
    GeneratedVersion,
    IngestWebsiteRequest,
    IngestWebsiteResponse,
    ParseManualRequest,
    RecognizeRequest,
    RecognizeResponse,
)


def _call_cost(kind: str, width: int, height: int, n: int) -> float | None:
    """T-conn-b — best-effort USD for one generate call. openai sizes are snapped
    to the priced set; other vendors use the literal canvas; mock/unpriced → None."""
    size = _snap_openai_size(width, height) if kind == "openai" else f"{width}x{height}"
    return _estimate_cost_usd(kind, size, _DEFAULT_IMAGE_QUALITY, n)

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
    return {"status": "ok"}


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


async def _fetch_pdf_text(url: str) -> str:
    """Download a PDF server-side (internal storage) and extract its text.

    Asset URLs point at internal object storage a third-party model can't
    reach — but we're on the internal network, so fetch the bytes here and
    extract the text with pypdf. Returns "" on any failure so the provider
    still emits a (possibly empty) valid RecognizeResponse rather than 500.
    """
    from pypdf import PdfReader

    async with httpx.AsyncClient(timeout=settings.http_timeout) as c:
        r = await c.get(url, follow_redirects=True)
        r.raise_for_status()
        content = r.content
    reader = PdfReader(io.BytesIO(content))
    parts = [page.extract_text() or "" for page in reader.pages]
    return "\n".join(p for p in parts if p).strip()


@app.post("/v1/parse-manual", response_model=RecognizeResponse, response_model_exclude_none=True)
async def parse_manual(
    req: ParseManualRequest,
    vlm: VLMProvider = Depends(resolve_vlm_provider),
):
    """Parse a brand/VI manual PDF into DRAFT brand rules.

    Reuses the recognition contract end-to-end: extract the PDF text, hand it
    to the VLM's `parse_manual`, and return the same RecognizeResponse shape the
    confirm workbench already consumes.
    """
    text = await _fetch_pdf_text(req.url)
    data = await vlm.parse_manual(text)
    return RecognizeResponse(**data)


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
    # above is the portable signal.
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

    # T-conn-b — usage/cost for the dashboard. `kind`/`model` are read off the
    # resolved provider (absent on mock).
    kind = getattr(provider, "kind", "mock")
    model = getattr(provider, "model", "") or None

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
            urls = await provider.generate(
                prompt,
                width=t.width,
                height=t.height,
                n=1,
                negative=negative or None,
                extra=provider_extra or None,
            )
            versions.append(
                GeneratedVersion(
                    imageUrl=urls[0],
                    width=t.width,
                    height=t.height,
                    params=_echo_params(
                        {"targetKey": t.key, "targetLabel": t.label}
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
    urls = await provider.generate(
        prompt,
        width=w,
        height=h,
        n=req.versionCount,
        negative=negative or None,
        extra=provider_extra or None,
    )
    usage = GenerateUsage(
        provider=kind,
        model=model,
        size=f"{w}x{h}",
        imageCount=len(urls),
        costUsd=_call_cost(kind, w, h, len(urls)),
        latencyMs=int((time.perf_counter() - started) * 1000),
        totalTokens=getattr(provider, "last_total_tokens", None),
    )
    return GenerateResponse(
        versions=[
            GeneratedVersion(
                imageUrl=u,
                width=w,
                height=h,
                params=_echo_params(),
            )
            for u in urls
        ],
        usage=usage,
    )


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
