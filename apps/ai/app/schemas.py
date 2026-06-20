"""Pydantic mirrors of @brandai/contracts AI schemas. Keep in sync."""
from typing import Any, Optional
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


class RecognizeRequest(BaseModel):
    assets: list[AssetRef]


class ParseManualRequest(BaseModel):
    """POST /v1/parse-manual — a brand/VI manual PDF asset URL to parse."""

    url: str


class Evidence(BaseModel):
    assetId: str
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
    note: Optional[str] = None


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
    width: int
    height: int


class GenerateRequest(BaseModel):
    sceneType: str
    sellingPoint: str
    scene: str
    brandRules: list[BrandRuleIn] = []
    versionCount: int = 2  # 与 packages/contracts 的 Zod GenerateRequest 默认(2)对齐
    aiConstraints: Optional[AIConstraints] = None
    # P2.0 — when present, produce one image per target (ignoring versionCount
    # and the sceneType default size). exclude_none keeps the legacy wire shape.
    targets: Optional[list[SizeSpec]] = None
    # M3 — text rendering strategy. "direct" (default) = model renders any text
    # itself (legacy). "layered" = steer the model to leave clean negative space
    # and render NO text, so the client overlays crisp editable text on top.
    textMode: str = "direct"


class GeneratedVersion(BaseModel):
    imageUrl: str
    width: int
    height: int
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
