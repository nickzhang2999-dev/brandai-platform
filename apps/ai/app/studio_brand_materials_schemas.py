"""Mirrors of the brand material BFF wire contracts, not public AI APIs."""
from typing import Literal
from pydantic import BaseModel, Field, field_validator, model_validator
from .schemas import StudioMaterial, NativeProjectId


class StrictOptionalModel(BaseModel):
    model_config = {"extra": "forbid", "strict": True}

    @model_validator(mode="before")
    @classmethod
    def omitted_not_null(cls, value):
        if isinstance(value, dict) and any(v is None for v in value.values()):
            # nextCursor is deliberately nullable; optional fields are not.
            if any(v is None and k != "nextCursor" for k, v in value.items()):
                raise ValueError("Optional fields may be omitted, not null")
        if isinstance(value, dict) and any(isinstance(v, str) and "\n" in v for k, v in value.items()
                                           if k in ("assetId", "taskId", "projectId", "url")):
            raise ValueError("Invalid resource identity")
        return value


class StudioBrandMaterialsQuery(StrictOptionalModel):
    search: str | None = Field(default=None, max_length=200)
    cursor: str | None = Field(default=None, min_length=1, max_length=512)
    limit: int = Field(default=24, ge=1, le=60)
    libraryKind: Literal["MATERIAL", "TEMPLATE", "GENERATED", "ALL"] = "ALL"

    @field_validator("search", mode="before")
    @classmethod
    def trim_search(cls, value):
        return value.strip() if isinstance(value, str) else value


class StudioBrandMaterialVerifyInput(StrictOptionalModel):
    operation: Literal["verify"]


class StudioBrandMaterialLinkInput(StrictOptionalModel):
    operation: Literal["link"]
    projectId: NativeProjectId
    assetSha256: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}$")


class StudioBrandMaterialEntry(StrictOptionalModel):
    assetId: NativeProjectId
    fileName: str = Field(min_length=1, max_length=255)
    mimeType: Literal["image/png", "image/jpeg", "image/webp"]
    sizeBytes: int = Field(ge=0)
    libraryKind: Literal["MATERIAL", "TEMPLATE", "GENERATED"]
    createdAt: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
    url: str = Field(pattern=r"^/api/workspaces/[a-zA-Z0-9_-]+/assets/[a-zA-Z0-9_-]+/raw$")
    material: StudioMaterial | None = None

    @field_validator("createdAt")
    @classmethod
    def valid_utc_time(cls, value):
        from datetime import datetime
        if "\n" in value:
            raise ValueError("Invalid timestamp")
        datetime.fromisoformat(value[:-1] + "+00:00")
        return value

    @field_validator("assetId", "url")
    @classmethod
    def no_identity_newline(cls, value):
        if "\n" in value:
            raise ValueError("Invalid resource identity")
        return value


class StudioBrandMaterialsPage(StrictOptionalModel):
    items: list[StudioBrandMaterialEntry] = Field(max_length=60)
    nextCursor: str | None = Field(max_length=512)


class StudioBrandMaterialVerification(StrictOptionalModel):
    assetId: NativeProjectId
    taskId: NativeProjectId | None = None
    status: Literal["UNVERIFIED", "PENDING", "RUNNING", "SUCCEEDED", "FAILED"]
    material: StudioMaterial | None = None
    error: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def truthful_receipt(self):
        if (self.status == "SUCCEEDED") != (self.material is not None):
            raise ValueError("Only verified assets carry a material")
        if self.status == "FAILED" and not self.error:
            raise ValueError("Failed verification requires an error")
        return self
