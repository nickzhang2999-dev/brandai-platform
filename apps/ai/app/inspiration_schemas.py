"""Mirrors packages/contracts/src/inspiration.ts; BFF-only, no AI endpoint."""
from typing import Literal, Annotated
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from uuid import UUID
from datetime import datetime
import re
InspirationId = Annotated[str, Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')]

class InspirationImage(BaseModel):
    imageId: InspirationId
    url: str

class InspirationSource(BaseModel):
    sourceId: InspirationId
    url: str

class InspirationClaim(BaseModel):
    claimId: InspirationId
    kind: Literal['author_statement', 'media_statement', 'visual_observation', 'analysis_inference']
    text: str
    sourceIds: list[InspirationId]
    imageIds: list[InspirationId]

class InspirationCaseCard(BaseModel):
    caseId: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
    revision: int = Field(gt=0)
    title: str
    summary: str
    brandOrTeam: str
    analysisAllowed: bool
    tags: dict[str, list[str]]
    contentType: Literal['advertisement', 'reference', 'unknown'] | None = None
    taxonomyStatus: Literal['reviewed', 'provided', 'legacy'] | None = None
    images: list[InspirationImage]
    sources: list[InspirationSource]
    claims: list[InspirationClaim]

    @model_validator(mode='before')
    @classmethod
    def omit_optional_taxonomy_fields(cls, value):
        if isinstance(value, dict) and any(k in value and value[k] is None for k in ('contentType', 'taxonomyStatus')):
            raise ValueError('Omit optional fields instead of null')
        return value

class InspirationReleaseView(BaseModel):
    id: str
    sequence: int
    createdAt: str

class InspirationSyncChannel(BaseModel):
    state: Literal['disabled', 'unconfigured', 'unknown', 'healthy', 'stale', 'error']
    lastAttemptAt: str | None
    lastSuccessAt: str | None
    lastFailureAt: str | None
    error: str | None

    @field_validator('lastAttemptAt', 'lastSuccessAt', 'lastFailureAt')
    @classmethod
    def valid_timestamp(cls, value):
        if value is not None:
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z', value):
                raise ValueError('Expected UTC timestamp')
            datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value

class InspirationSyncStatus(BaseModel):
    content: InspirationSyncChannel
    withdrawals: InspirationSyncChannel
    activeManifestHash: Annotated[str, Field(pattern=r'^[a-f0-9]{64}$')] | None
    withdrawalHash: Annotated[str, Field(pattern=r'^[a-f0-9]{64}$')] | None

class InspirationListResponse(BaseModel):
    enabled: bool
    syncConfigured: bool
    activeRelease: InspirationReleaseView | None
    caseCount: int
    withdrawalSequence: int
    lastSyncAt: str | None
    error: str | None
    cases: list[InspirationCaseCard]
    searchMode: Literal['keyword-tags', 'hybrid']
    syncStatus: InspirationSyncStatus | None = None

    @model_validator(mode='before')
    @classmethod
    def omit_missing_sync_status(cls, value):
        if isinstance(value, dict) and 'syncStatus' in value and value['syncStatus'] is None:
            raise ValueError('Omit optional fields instead of null')
        return value

class InspirationSelectedImage(BaseModel):
    model_config = ConfigDict(extra='forbid')
    caseId: InspirationId
    imageId: InspirationId
    revision: int = Field(gt=0)

class InspirationChatInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    requestId: str
    question: str = Field(min_length=1, max_length=3000)
    conversationId: str | None = None
    caseIds: list[InspirationId] | None = Field(default=None, max_length=8)
    selectedImages: list[InspirationSelectedImage] | None = Field(default=None, max_length=2)

    @field_validator('requestId', 'conversationId')
    @classmethod
    def valid_uuid(cls, value):
        if value is not None:
            UUID(value)
        return value

    @field_validator('question', mode='before')
    @classmethod
    def trim_question(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode='before')
    @classmethod
    def no_null_optional(cls, value):
        if isinstance(value, dict) and any(k in value and value[k] is None for k in ('conversationId', 'caseIds', 'selectedImages')):
            raise ValueError('Omit optional fields instead of null')
        return value

class InspirationChatState(BaseModel):
    id: str
    conversationId: str
    status: Literal['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']
    question: str
    answer: str | None
    citations: list[InspirationCaseCard]
    error: str | None
    createdAt: str

class InspirationBookmarkInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    caseId: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
    revision: int = Field(gt=0)
    projectId: str | None = Field(default=None, min_length=1, max_length=128)
    note: str = Field(default='', max_length=2000)

    @field_validator('note', mode='before')
    @classmethod
    def trim_note(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode='before')
    @classmethod
    def no_null_optional(cls, value):
        if isinstance(value, dict) and 'projectId' in value and value['projectId'] is None:
            raise ValueError('Omit optional fields instead of null')
        return value

class InspirationBookmark(BaseModel):
    id: str
    caseId: str
    revision: int = Field(gt=0)
    projectId: str | None
    note: str
    case: InspirationCaseCard | None
    unavailable: bool


InspirationFeedbackKind = Literal['IRRELEVANT', 'ANALYSIS_ERROR', 'UNSUPPORTED_CITATION', 'BROKEN_IMAGE']


class InspirationFeedbackInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    caseId: InspirationId
    revision: int = Field(gt=0)
    kind: InspirationFeedbackKind
    note: str = Field(default='', max_length=1000)

    @field_validator('note', mode='before')
    @classmethod
    def trim_note(cls, value):
        return value.strip() if isinstance(value, str) else value


class InspirationFeedback(BaseModel):
    id: str
    caseId: InspirationId
    revision: int = Field(gt=0)
    kind: InspirationFeedbackKind
    note: str
    status: Literal['OPEN', 'RESOLVED']
    createdAt: str
    caseTitle: str | None
    unavailable: bool


class InspirationFeedbackList(BaseModel):
    items: list[InspirationFeedback]
    scope: Literal['mine', 'review']
    canReview: bool


class InspirationFeedbackUpdate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    status: Literal['OPEN', 'RESOLVED']


class InspirationActivityItem(BaseModel):
    id: str
    conversationId: str
    status: Literal['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED']
    createdAt: str
    updatedAt: str
    expiresAt: str
    expired: bool


class InspirationActivity(BaseModel):
    enabled: bool
    items: list[InspirationActivityItem] = Field(max_length=20)
