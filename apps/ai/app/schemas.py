"""Pydantic mirrors of @brandai/contracts AI schemas. Keep in sync."""
from typing import Annotated, Any, Literal, Optional
from pydantic import BaseModel, Field, StringConstraints, field_validator, model_validator


NativeProjectId = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]
NativeProjectName = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=200, pattern=r"^[^\x00-\x1f\x7f]+$")]


class NativeProjectQueryInput(BaseModel):
    """Mirror of the native editor compatibility boundary; no AI endpoint."""
    model_config = {"extra": "forbid"}
    projectId: NativeProjectId


class NativeProjectListInput(BaseModel):
    model_config = {"extra": "forbid"}
    page: int = Field(default=1, ge=1, le=1000000, strict=True)
    pageSize: int = Field(default=20, ge=1, le=100, strict=True)


class NativeProjectRenameInput(NativeProjectQueryInput):
    projectName: NativeProjectName


class NativeProjectSaveInput(NativeProjectQueryInput):
    canvas: str = Field(strict=True, min_length=1, max_length=8 * 1024 * 1024, pattern=r"^SHAKKERDATA://")
    version: str = Field(strict=True, pattern=r"^novart-(0|[1-9][0-9]{0,9})$")
    projectName: NativeProjectName | None = None
    projectCoverList: list[Annotated[str, Field(strict=True, max_length=4096)]] | None = Field(default=None, max_length=20)
    picCount: int | None = Field(default=None, ge=0, le=1000000, strict=True)
    projectType: Literal[3] | None = None
    sessionId: str | None = Field(default=None, strict=True, max_length=128)
    canvasV2Gray: Literal[False] | None = None
    canvasEvidenceEnabled: Literal[False] | None = None

    @field_validator("version")
    @classmethod
    def revision_bound(cls, value):
        if int(value[7:]) > 2147483646:
            raise ValueError("Invalid document revision")
        return value

    @model_validator(mode="before")
    @classmethod
    def optional_is_not_nullable(cls, value):
        if isinstance(value, dict):
            if any(item is None for item in value.values()):
                raise ValueError("Optional fields must be omitted, not null")
            for key in ("canvasV2Gray", "canvasEvidenceEnabled"):
                if key in value and value[key] is not False:
                    raise ValueError("Incremental evidence is not supported")
            if "projectType" in value and (type(value["projectType"]) is not int or value["projectType"] != 3):
                raise ValueError("Only ordinary native projects are supported")
        return value


class EditorDocumentSaveInput(BaseModel):
    """Mirror of the web-only native document contract; not an AI endpoint."""
    model_config = {"extra": "forbid"}
    format: Literal["novart-native-v1"]
    canvas: str = Field(min_length=1, max_length=8 * 1024 * 1024, pattern=r"^SHAKKERDATA://")
    revision: int = Field(ge=0, le=2147483646, strict=True)
    mutationId: str = Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


class EditorDocumentView(BaseModel):
    model_config = {"extra": "forbid"}
    projectId: str = Field(min_length=1)
    workspaceId: str = Field(min_length=1)
    format: Literal["novart-native-v1"]
    canvas: str
    revision: int = Field(ge=0, strict=True)
    checksum: str | None = Field(pattern=r"^[a-f0-9]{64}$")
    updatedAt: str | None
    readOnly: bool


class SelectWorkbenchWorkspaceInput(BaseModel):
    model_config = {"extra": "forbid"}
    workspaceId: str = Field(min_length=1, max_length=128)


class WorkbenchSessionUser(BaseModel):
    model_config = {"extra": "forbid"}
    id: str
    name: str


class WorkbenchWorkspace(BaseModel):
    model_config = {"extra": "forbid"}
    id: str
    name: str
    role: Literal["OWNER", "EDITOR", "REVIEWER", "VIEWER"]


class WorkbenchSession(BaseModel):
    model_config = {"extra": "forbid"}
    user: WorkbenchSessionUser
    workspaces: list[WorkbenchWorkspace]
    activeWorkspaceId: str | None


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
    # parse-manual bridge: sourceRef is rewritten to a persisted Asset id by
    # the web worker; page remains as human-verifiable provenance.
    sourceRef: Optional[str] = None
    page: Optional[int] = None


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


class ManualExtractedAsset(BaseModel):
    ref: str
    type: str
    page: int
    bbox: Optional[list[float]] = None
    label: str
    dataUrl: str


class ParseManualResponse(RecognizeResponse):
    extractedAssets: list[ManualExtractedAsset] = Field(default_factory=list)
    pageCount: int = 0
    warnings: list[str] = Field(default_factory=list)


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
    # V0.0.20 — optional workbench size provenance. Legacy channel targets and
    # edit RESIZE payloads remain valid without these fields.
    ratioKey: Optional[
        Literal[
            "1:1",
            "4:5",
            "3:4",
            "2:3",
            "9:16",
            "5:4",
            "4:3",
            "3:2",
            "16:10",
            "16:9",
            "2.35:1",
            "3:1",
            "custom",
        ]
    ] = None
    resolutionTier: Optional[Literal["1K", "2K"]] = None
    requestedRatio: Optional[str] = Field(default=None, max_length=50)


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
    # V0.0.18 — branded_direct keeps the chat brief concise while prepending
    # the active Brand Kit as a mandatory boundary. direct remains the free
    # creation path when no confirmed Brand Kit rules exist.
    promptMode: Optional[Literal["branded", "direct", "branded_direct"]] = None


class GeneratedVersion(BaseModel):
    imageUrl: str
    width: int
    height: int
    # K5 — actual decoded pixel dimensions of the returned image. gpt-image-2
    # keeps validated literal sizes; legacy models/gateways may still differ.
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


DECOMPOSE_LAYER_MIN = 1
DECOMPOSE_LAYER_MAX = 10


class DecomposeRequest(BaseModel):
    """Mirror of contracts/ai.ts DecomposeRequest.

    Layer decomposition is an ACTION capability, not a selectable model: it
    needs an input image, ignores size / versionCount / sceneType, and returns
    a set of RGBA layers rather than a finished image.
    """

    imageUrl: str
    # 边界必须与 Zod 侧逐字对齐(1–10 / intent ≤500),不能只靠 provider 里那句
    # clamp 兜着:任何不经 web 路由直接打 FastAPI 的调用方,看到的会是另一套契约,
    # 能提交规范判为非法的请求。CLAUDE.md 明写「契约改动两边同时改」。
    layerCount: int = Field(default=4, ge=1, le=10)
    intent: Optional[str] = Field(default=None, max_length=500)


class DecomposedLayer(BaseModel):
    imageUrl: str
    # 与 Zod 侧 `z.number().int().positive()` 逐字对齐。裸 `int` 会放行 0 / 负数,
    # 而 web 侧读回来会拿它当画布落位的宽高——0 宽的图层框选不中、也导不出,
    # 症状出在前端,根因却在这条没对齐的边界上。
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class DecomposeResponse(BaseModel):
    layers: list[DecomposedLayer]
    # Upstream seed — the only handle on "can this split be reproduced?".
    # Kept on the wire so the web side can persist it with the layer set.
    seed: Optional[int] = None
    usage: Optional[GenerateUsage] = None


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
