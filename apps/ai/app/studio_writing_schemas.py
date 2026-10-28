"""Mirror packages/contracts/src/studio-writing.ts; no provider credentials."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator

Id = Annotated[str, Field(min_length=1, max_length=128)]
Revision = Annotated[int, Field(strict=True, ge=0, le=2**31-1)]
MutationId = Annotated[str, Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="after")
    def javascript_string_limits(self):
        for name, info in type(self).model_fields.items():
            value = getattr(self, name)
            if isinstance(value, str):
                for constraint in info.metadata:
                    maximum = getattr(constraint, "max_length", None)
                    if maximum is not None and len(value.encode("utf-16-le")) // 2 > maximum:
                        raise ValueError("String exceeds UTF-16 length boundary")
        return self


class StudioWritingSelection(Strict):
    start: Revision
    end: Revision
    text: str = Field(min_length=1, max_length=20000)

    @model_validator(mode="after")
    def exact_span(self):
        if self.end <= self.start or self.end-self.start != len(self.text.encode("utf-16-le"))//2:
            raise ValueError("Selection range does not match text")
        return self


class StudioWritingCitation(Strict):
    referenceId: Id
    segmentId: Id
    pageNumber: Annotated[int, Field(strict=True, ge=1, le=200)] | None
    label: str = Field(max_length=200)


class StudioWritingSegment(Strict):
    id: Id
    pageNumber: Annotated[int, Field(strict=True, ge=1, le=200)] | None
    label: str = Field(max_length=200)
    text: str = Field(max_length=3000)


class WritingExample(Strict):
    title: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=6000)

    @field_validator("title", "text", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value


class StudioWritingStyleContent(Strict):
    rules: list[Annotated[str, Field(min_length=1, max_length=1000)]] = Field(max_length=20)
    examples: list[WritingExample] = Field(max_length=5)

    @field_validator("rules", mode="before")
    @classmethod
    def trim_rules(cls, value):
        if not isinstance(value, list): return value
        result = [item.strip() if isinstance(item, str) else item for item in value]
        if any(isinstance(item, str) and len(item.encode("utf-16-le"))//2 > 1000 for item in result):
            raise ValueError("Rule exceeds UTF-16 boundary")
        return result


class StudioWritingStyle(StudioWritingStyleContent):
    revision: Revision
    confirmedAt: str | None


class StudioWritingDocument(Strict):
    id: Id
    title: str = Field(max_length=200)
    text: str = Field(max_length=60000)
    revision: Revision
    updatedAt: str | None


class StudioWritingVersion(Strict):
    id: Id
    revision: Revision
    title: str = Field(max_length=200)
    text: str = Field(max_length=60000)
    operation: Literal["SAVE", "REPLACE", "RESTORE"]
    createdAt: str


class WritingSave(Strict):
    mutationId: MutationId
    expectedRevision: Revision
    operation: Literal["SAVE"]
    title: str = Field(max_length=200)
    text: str = Field(max_length=60000)


class WritingReplace(Strict):
    mutationId: MutationId
    expectedRevision: Revision
    operation: Literal["REPLACE"]
    selection: StudioWritingSelection
    replacement: str = Field(max_length=20000)


class WritingRestore(Strict):
    mutationId: MutationId
    expectedRevision: Revision
    operation: Literal["RESTORE"]
    versionId: Id


StudioWritingSaveInput = Annotated[WritingSave | WritingReplace | WritingRestore, Field(discriminator="operation")]


class StudioWritingGenerateInput(Strict):
    mutationId: MutationId
    expectedRevision: Revision
    prompt: str = Field(min_length=1, max_length=4000)
    mode: Literal["GENERATE", "REWRITE", "CONTINUE", "SELECTION", "CHAT"]
    referenceIds: list[Id] = Field(max_length=12)
    styleRevision: Revision | None
    selection: StudioWritingSelection | None = None

    @field_validator("prompt", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="before")
    @classmethod
    def optional_not_null(cls, value):
        if isinstance(value, dict) and "selection" in value and value["selection"] is None:
            raise ValueError("Omit optional selection instead of null")
        return value

    @model_validator(mode="after")
    def selection_and_unique_sources(self):
        if (self.mode == "SELECTION") != (self.selection is not None) or len(set(self.referenceIds)) != len(self.referenceIds):
            raise ValueError("Invalid selection or duplicate references")
        return self


class StudioWritingStyleSaveInput(StudioWritingStyleContent):
    mutationId: MutationId
    expectedRevision: Revision
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_true(cls, value):
        if value is not True: raise ValueError("Explicit confirmation required")
        return value


class StudioWritingStyleExtractInput(Strict):
    mutationId: MutationId
    referenceIds: list[Id] = Field(min_length=1, max_length=12)
    prompt: str = Field(default="", max_length=2000)

    @field_validator("prompt", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def unique_references(self):
        if len(set(self.referenceIds)) != len(self.referenceIds):
            raise ValueError("Duplicate references")
        return self


class StudioWritingAssetReferenceInput(Strict):
    mutationId: MutationId
    assetId: Id
    assetSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value


class StudioWritingReference(Strict):
    id: Id
    name: str = Field(max_length=200)
    mimeType: str = Field(max_length=128)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    sizeBytes: Annotated[int, Field(strict=True, ge=0, le=10*1024*1024)]
    kind: Literal["IMAGE", "DOCUMENT"]
    status: Literal["PENDING", "RUNNING", "READY", "FAILED"]
    error: str | None
    segments: list[StudioWritingSegment] = Field(max_length=200)
    truncated: bool
    imageUrl: str | None
    createdAt: str


class StudioWritingResult(Strict):
    text: str = Field(max_length=20000)
    scope: Literal["DOCUMENT", "SELECTION", "CHAT", "STYLE_DRAFT", "REFERENCE"]
    baseRevision: Revision
    citations: list[StudioWritingCitation] = Field(max_length=30)
    styleDraft: StudioWritingStyleContent | None
    model: str = Field(max_length=200)
    inputTokens: Annotated[int, Field(strict=True, ge=0)]
    outputTokens: Annotated[int, Field(strict=True, ge=0)]
    latencyMs: Annotated[int, Field(strict=True, ge=0)]


class StudioWritingTask(Strict):
    id: Id
    mutationId: MutationId
    operation: Literal["GENERATE", "STYLE_EXTRACT", "REFERENCE_PARSE"]
    input: StudioWritingGenerateInput | StudioWritingStyleExtractInput | None
    status: Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]
    progress: Annotated[int, Field(strict=True, ge=0, le=100)]
    createdAt: str
    expiresAt: str
    error: str | None
    result: StudioWritingResult | None


class StudioWritingMessage(Strict):
    id: Id
    role: Literal["user", "assistant"]
    text: str = Field(max_length=20000)
    taskId: Id
    citations: list[StudioWritingCitation] = Field(max_length=30)
    createdAt: str


class StudioWritingState(Strict):
    enabled: bool
    document: StudioWritingDocument
    versions: list[StudioWritingVersion] = Field(max_length=20)
    messages: list[StudioWritingMessage] = Field(max_length=50)
    references: list[StudioWritingReference] = Field(max_length=30)
    style: StudioWritingStyle
    tasks: list[StudioWritingTask] = Field(max_length=30)


class StudioWritingVersions(Strict):
    versions: list[StudioWritingVersion] = Field(max_length=20)
    hasMore: bool


class StudioWritingMessages(Strict):
    messages: list[StudioWritingMessage] = Field(max_length=50)
    hasMore: bool


class StudioWritingReferenceAccepted(Strict):
    reference: StudioWritingReference
    task: StudioWritingTask


class StudioWritingTaskLookup(Strict):
    task: StudioWritingTask | None


class StudioWritingSaveResult(Strict):
    document: StudioWritingDocument
    version: StudioWritingVersion


class StudioWritingError(Strict):
    error: str
    code: Literal["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "INVALID_INPUT", "TOO_LARGE", "RATE_LIMITED", "UNAVAILABLE"]


class StudioWritingParseRequest(Strict):
    fileName: str = Field(min_length=1, max_length=200)
    mimeType: str = Field(max_length=128)
    contentBase64: str = Field(min_length=1, max_length=((10*1024*1024+2)//3)*4)


class StudioWritingParseResponse(Strict):
    segments: list[StudioWritingSegment] = Field(max_length=200)
    truncated: bool
    parserRevision: Literal["studio-writing-text-v1"]
