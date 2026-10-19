"""Durable studio conversation wire mirror; safe-rules-v1 is not an LLM claim."""
from typing import Literal
from datetime import datetime
from pydantic import Field, field_validator, model_validator
from .studio_workflow_schemas import StrictModel, ProjectId, Sha256, ShapeId
from .studio_generation_schemas import MutationId, StudioGenerationSizeSelection, StudioGenerationView
from .studio_conversation_model import ConversationOption, ConversationModelUsage

class StudioConversationPixels(StrictModel):
    width: int = Field(ge=32, le=8192, strict=True)
    height: int = Field(ge=32, le=8192, strict=True)

    @model_validator(mode="after")
    def supported(self):
        if self.width * self.height > 16_777_216 or not 1 / 3 <= self.width / self.height <= 3:
            raise ValueError("unsupported pixel count or aspect ratio")
        return self

class StudioConversationReference(StrictModel):
    referenceId: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=255)
    shapeId: ShapeId | None = None
    assetId: ProjectId
    assetSha256: Sha256
    versionId: ProjectId | None = None
    width: int = Field(gt=0, le=16384, strict=True)
    height: int = Field(gt=0, le=16384, strict=True)
    purpose: Literal["REFERENCE", "ADAPTIVE", "EXACT"] = "REFERENCE"

    @model_validator(mode="before")
    @classmethod
    def no_null_optional(cls, value):
        if isinstance(value, dict) and any(key in value and value[key] is None for key in ("shapeId", "versionId")):
            raise ValueError("optional fields must be omitted, not null")
        return value

    @field_validator("name", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value

class StudioConversationFields(StrictModel):
    text: str = Field(max_length=4000)
    references: list[StudioConversationReference] = Field(max_length=8)
    quickEditTargetId: str | None = Field(default=None, min_length=1, max_length=200)
    sizeSelection: StudioGenerationSizeSelection
    psdLayerMode: Literal["AUTO", "MANUAL"] | None = None
    psdLayerCount: int | None = Field(default=None, ge=2, le=10, strict=True)

    @model_validator(mode="before")
    @classmethod
    def omitted_psd_options(cls, value):
        if isinstance(value, dict) and any(key in value and value[key] is None for key in ("psdLayerMode", "psdLayerCount")):
            raise ValueError("optional PSD fields must be omitted")
        return value

    @model_validator(mode="after")
    def valid_references(self):
        if len({ref.referenceId for ref in self.references}) != len(self.references) or len({ref.assetId for ref in self.references}) != len(self.references):
            raise ValueError("duplicate references")
        if self.quickEditTargetId is not None and not any(ref.referenceId == self.quickEditTargetId and ref.shapeId for ref in self.references):
            raise ValueError("quick target must be a shape reference")
        if (self.psdLayerMode == "MANUAL") != (self.psdLayerCount is not None):
            raise ValueError("manual PSD mode requires a bounded layer count")
        return self

class StudioConversationDraft(StudioConversationFields):
    revision: int = Field(ge=0, le=2147483647, strict=True)

class StudioConversationDraftInput(StudioConversationFields):
    revision: int = Field(ge=0, le=2147483646, strict=True)

class StudioConversationDecision(StrictModel):
    sourceMessageId: ProjectId
    optionId: str = Field(min_length=1, max_length=80)
    kind: Literal["clarification", "correction"]

class StudioConversationInput(StudioConversationFields):
    mutationId: MutationId
    text: str = Field(min_length=1, max_length=4000)
    documentRevision: int = Field(ge=0, le=2147483646, strict=True)
    workflowRevision: int = Field(ge=0, le=2147483646, strict=True)
    requestedSize: StudioConversationPixels | None = None
    outputFrameId: ShapeId | None = None
    homeStart: Literal[True] | None = None
    selectedReferenceIds: list[str] | None = Field(default=None, max_length=8)
    decision: StudioConversationDecision | None = None

    @model_validator(mode="before")
    @classmethod
    def no_optional_null_or_revision(cls, value):
        if isinstance(value, dict) and ("revision" in value or any(key in value and value[key] is None for key in ("requestedSize", "outputFrameId", "homeStart", "selectedReferenceIds", "decision"))):
            raise ValueError("unexpected revision or explicit null")
        if isinstance(value, dict) and "homeStart" in value and value["homeStart"] is not True:
            raise ValueError("homeStart must be true when supplied")
        return value

    @model_validator(mode="after")
    def valid_selection(self):
        ids = {ref.referenceId for ref in self.references}
        selected = self.selectedReferenceIds or []
        if len(set(selected)) != len(selected) or any(ref not in ids for ref in selected):
            raise ValueError("selected references must be unique frozen references")
        return self

    @field_validator("text", mode="before")
    @classmethod
    def trim_text(cls, value):
        return value.strip() if isinstance(value, str) else value

class StudioConversationIntent(StrictModel):
    action: Literal["generate", "modify", "clarify"]
    targetReferenceId: str | None
    referenceIds: list[str] = Field(max_length=8)
    prompt: str = Field(min_length=1, max_length=4000)
    clarification: str | None
    requestedSize: StudioConversationPixels | None
    sizeSource: Literal["dialog-pixels", "dialog-ratio", "control", "target", "default"]
    sizeSelection: StudioGenerationSizeSelection
    parser: Literal["safe-rules-v1", "structured-model-v1", "structured-model-v2"]
    modelStatus: Literal["UNAVAILABLE", "SUCCEEDED", "UNKNOWN"] | None = None
    imagePrompt: str | None = Field(default=None, min_length=1, max_length=4000)
    options: list[ConversationOption] | None = Field(default=None, max_length=3)
    correctionOptions: list[ConversationOption] | None = Field(default=None, max_length=3)
    modelUsage: ConversationModelUsage | None = None

    @model_validator(mode="before")
    @classmethod
    def no_null_model_status(cls, value):
        if isinstance(value, dict) and any(key in value and value[key] is None for key in ("modelStatus", "imagePrompt", "options", "correctionOptions", "modelUsage")):
            raise ValueError("optional model fields must be omitted")
        return value

    @field_validator("imagePrompt", mode="before")
    @classmethod
    def trim_image_prompt(cls, value):
        return value.strip() if isinstance(value, str) else value

class StudioConversationMessage(StrictModel):
    messageId: ProjectId
    mutationId: MutationId
    projectId: ProjectId
    text: str
    references: list[StudioConversationReference] = Field(max_length=8)
    status: Literal["PENDING", "RUNNING", "CLARIFICATION", "SUCCEEDED", "FAILED"]
    intent: StudioConversationIntent | None
    generation: StudioGenerationView | None
    error: str | None
    clarification: str | None
    createdAt: str
    expiresAt: str
    originalInput: StudioConversationInput | None = None

    @model_validator(mode="before")
    @classmethod
    def omitted_original_input(cls, value):
        if isinstance(value, dict) and "originalInput" in value and value["originalInput"] is None:
            raise ValueError("optional original input must be omitted")
        return value

    @field_validator("createdAt", "expiresAt")
    @classmethod
    def iso_utc(cls, value):
        if not value.endswith("Z"):
            raise ValueError("UTC ISO timestamp required")
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value

    @field_validator("references")
    @classmethod
    def ordered_unique_refs(cls, value):
        if len({ref.referenceId for ref in value}) != len(value) or len({ref.assetId for ref in value}) != len(value):
            raise ValueError("duplicate references")
        return value

class StudioConversationPage(StrictModel):
    messages: list[StudioConversationMessage]
    nextCursor: ProjectId | None
    draft: StudioConversationDraft | None

class StudioConversationQuery(StrictModel):
    messageId: ProjectId | None = None
    before: ProjectId | None = None
    limit: int = Field(default=20, ge=1, le=50)

    @model_validator(mode="before")
    @classmethod
    def no_null_optional(cls, value):
        if isinstance(value, dict) and any(key in value and value[key] is None for key in ("messageId", "before")):
            raise ValueError("optional query fields must be omitted")
        return value
