"""Pydantic mirrors of @brandai/contracts AI schemas. Keep in sync."""
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


class IngestWebsiteRequest(BaseModel):
    url: str


class IngestImage(BaseModel):
    sourceUrl: str
    previewUrl: str
    guessedCategory: Optional[str] = None


class SiteStyle(BaseModel):
    """Deterministic brand-style signals read straight from the page HTML/CSS."""

    palette: list[str] = []
    fonts: list[str] = []
    themeColor: Optional[str] = None
    logoUrl: Optional[str] = None
    siteName: Optional[str] = None


class IngestWebsiteResponse(BaseModel):
    images: list[IngestImage]
    copies: list[str]
    sellingPoints: list[str]
    siteStyle: Optional[SiteStyle] = None


class AssetRef(BaseModel):
    id: str
    url: str
    # K7 — provenance hint for SSRF policy. "UPLOAD" (default) trusts the initial
    # host (our own storage may be private); "WEBSITE" re-validates the initial
    # host too (defense against DNS rebinding of a harvested third-party URL).
    source: Optional[str] = None


class RecognizeRequest(BaseModel):
    assets: list[AssetRef]


class DescribeRequest(BaseModel):
    """POST /v1/describe — E9/E10 asset auto-tagging by image URL."""

    url: str
    category: Optional[str] = None
    brandTone: Optional[str] = None
    # K7 — provenance hint for SSRF policy (see AssetRef.source).
    source: Optional[str] = None


class DescribeResponse(BaseModel):
    aiTags: list[str] = Field(default_factory=list)
    aiDescription: str = ""


class SummarizeContext(BaseModel):
    brandName: Optional[str] = None
    brandTone: Optional[str] = None
    campaignName: Optional[str] = None
    ruleSummaries: list[str] = Field(default_factory=list)


class SummarizeRequest(BaseModel):
    """POST /v1/summarize — B2/C8 text-only VLM endpoint, two modes."""

    mode: str  # "brief_decompose" | "campaign_summary"
    text: str
    context: Optional[SummarizeContext] = None


class SummarizeResponse(BaseModel):
    """Mirror of @brandai/contracts SummarizeResponse. Every field optional /
    default-empty so response_model_exclude_none keeps the no-null wire shape
    (Zod .optional() rejects null)."""

    # brief_decompose
    sellingPoint: Optional[str] = None
    scene: Optional[str] = None
    sceneType: Optional[str] = None
    styleKeywords: list[str] = Field(default_factory=list)
    # shared / campaign_summary
    summary: Optional[str] = None
    highlights: list[str] = Field(default_factory=list)


class ParseManualRequest(BaseModel):
    """POST /v1/parse-manual — a brand/VI manual PDF asset URL to parse."""

    url: str


class Evidence(BaseModel):
    # assetId is optional for note-only evidence (a VLM observation not tied to a
    # specific requested asset). Like every other optional here it serializes via
    # response_model_exclude_none=True → OMITTED, never null (Zod .optional()
    # rejects null). A foreign/hallucinated assetId is stripped in
    # _coerce_recognize, so any value present belongs to the requested set.
    assetId: Optional[str] = None
    bbox: Optional[list[float]] = None
    note: Optional[str] = None
    thumbnailUrl: Optional[str] = None


class RecognizedRule(BaseModel):
    type: str
    strength: str
    summary: str
    value: dict[str, Any]
    evidence: list[Evidence] = []


class ColorSystem(BaseModel):
    palette: list[str]
    pairing: list[list[str]] = []
    restrictions: list[str] = []
    contrastScore: float
    consistencyScore: float


class RecognizeResponse(BaseModel):
    rules: list[RecognizedRule]
    colorSystem: Optional[ColorSystem] = None


class BrandRuleIn(BaseModel):
    id: str
    type: str
    strength: str
    status: str
    summary: str
    value: dict[str, Any] = {}
    evidence: list[Evidence] = []


class HardBlock(BaseModel):
    reason: str
    source: str


class ReferenceImage(BaseModel):
    """D5 mirror of @brandai/contracts ReferenceImage — a positive/negative
    example asset (resolved URL) the AI service can use as a visual reference."""

    url: str
    polarity: str  # "positive" | "negative"
    source: str
    # V0.0.7+/V0.0.8 — "STRICT" (100%-use → image-to-image input path, must not
    # silently degrade to a text steer) | "INSPIRATION" (text steer only).
    # Absent → INSPIRATION (unchanged behavior).
    mode: Optional[str] = None
    note: Optional[str] = None
    # K7 — provenance of the URL for SSRF policy ("UPLOAD" | "WEBSITE").
    sourceHint: Optional[str] = None


class AIConstraints(BaseModel):
    """P1.2 mirror of @brandai/contracts AIConstraints.

    All fields optional / default-empty so untouched requests parse identically
    to the pre-P1.2 wire shape.
    """

    machineRules: Optional[dict[str, Any]] = None
    promptAdditions: list[str] = Field(default_factory=list)
    negativePrompt: list[str] = Field(default_factory=list)
    hardBlocks: list[HardBlock] = Field(default_factory=list)
    # D5 — positive/negative example assets compiled from prohibition rules.
    referenceImages: list[ReferenceImage] = Field(default_factory=list)


class SizeSpec(BaseModel):
    """P2.0 mirror of @brandai/contracts SizeSpec."""

    key: str
    label: str
    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=8192)


class GenerateRequest(BaseModel):
    sceneType: str
    sellingPoint: str
    scene: str
    brandRules: list[BrandRuleIn] = []
    # 与 packages/contracts 的 Zod GenerateRequest 对齐:默认 2、min(1)、max(8)。
    # 直连 /v1/generate 传 0 会被拒，避免返回零版本破坏调用方。
    versionCount: int = Field(default=2, ge=1, le=8)
    aiConstraints: Optional[AIConstraints] = None
    # P2.0 — when present, produce one image per target (ignoring versionCount
    # and the sceneType default size). exclude_none keeps the legacy wire shape.
    targets: Optional[list[SizeSpec]] = Field(default=None, max_length=12)
    # M3 — text rendering strategy. "direct" (default) = model renders any text
    # itself (legacy). "layered" = steer the model to leave clean negative space
    # and render NO text, so the client overlays crisp editable text on top.
    textMode: str = "direct"
    # V0.0.13 — admin-configured image system prompt (AppSetting.imageSystemPrompt
    # threaded through the web worker). Prepended verbatim to the prompt.
    # Frozen-additive: absent → prompt unchanged.
    systemPrompt: Optional[str] = None
    # V0.0.13g — "branded"(缺省,场景+品牌规则折叠) | "direct"(对话来源,仅用户 brief)
    promptMode: Optional[Literal["branded", "direct"]] = None


class GeneratedVersion(BaseModel):
    imageUrl: str
    width: int
    height: int
    # K5 — actual decoded pixel dimensions of the returned image (OpenAI snaps to
    # its supported size set, so this can differ from the requested width/height).
    # exclude_none keeps them omitted when undecodable / mock.
    actualWidth: Optional[int] = None
    actualHeight: Optional[int] = None
    params: dict[str, Any]


class GenerateUsage(BaseModel):
    """T-conn-b mirror — per-call usage/cost. exclude_none keeps the wire shape
    null-free when the provider is mock / unpriced."""

    provider: str
    model: Optional[str] = None
    size: Optional[str] = None
    imageCount: int = 0
    costUsd: Optional[float] = None
    latencyMs: Optional[int] = None
    # gpt-image-* is token-priced; surface the provider's reported total when
    # present (null otherwise — mock / non-OpenAI gateways don't report it).
    totalTokens: Optional[int] = None


class GenerateResponse(BaseModel):
    versions: list[GeneratedVersion]
    usage: Optional[GenerateUsage] = None


class EditRequest(BaseModel):
    imageUrl: str
    op: str
    payload: dict[str, Any] = {}


class EditResponse(BaseModel):
    imageUrl: str
    width: int
    height: int
    params: dict[str, Any] = {}


class TermIn(BaseModel):
    type: str
    term: str
    reason: str
    replacement: Optional[str] = None


class ComplianceCheckRequest(BaseModel):
    text: Optional[str] = None
    imageUrl: Optional[str] = None
    brandRules: list[BrandRuleIn] = []
    termLib: list[TermIn] = []
    # D5 — positive/negative example assets the VLM compares the image against.
    referenceImages: list[ReferenceImage] = Field(default_factory=list)


class ComplianceResult(BaseModel):
    level: str
    span: Optional[str] = None
    reason: str
    replacement: Optional[str] = None
    category: Optional[str] = None


class ComplianceReport(BaseModel):
    overall: str
    textResults: list[ComplianceResult] = []
    visualResults: list[ComplianceResult] = []
    checkedAt: str
    # 0–100 brand-consistency of the inspected image vs the brand rules
    # (100 = fully on-brand). None when no image was checked. The
    # /v1/compliance/check route runs with response_model_exclude_none=True,
    # so the no-null contract holds when absent.
    score: Optional[int] = None


class ComplianceCheckResponse(BaseModel):
    results: list[ComplianceResult]
    report: ComplianceReport
