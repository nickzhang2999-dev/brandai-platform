"""Internal whole-image edit transport; the public product request has no URL."""
import base64
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .schemas import GenerateRequest, SizeSpec

STUDIO_EDIT_REVISION = "studio-whole-image-edit-r1"
STUDIO_EDIT_MAX_BYTES = 32 * 1024 * 1024
STUDIO_EDIT_MAX_IMAGES = 16
_MAX_DATA_LENGTH = ((STUDIO_EDIT_MAX_BYTES + 2) // 3) * 4 + 64
_DATA = re.compile(r"^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$")


def studio_data_bytes(value: str) -> bytes:
    if not isinstance(value, str) or len(value) > _MAX_DATA_LENGTH:
        raise ValueError("A bounded static PNG/JPEG/WebP data URI is required")
    match = _DATA.fullmatch(value)
    if not match or len(match[2]) % 4:
        raise ValueError("A bounded static PNG/JPEG/WebP data URI is required")
    body = base64.b64decode(match[2], validate=True)
    if not body or len(body) > STUDIO_EDIT_MAX_BYTES or base64.b64encode(body).decode() != match[2]:
        raise ValueError("Invalid or oversized canonical image data URI")
    return body


class StudioEditSize(SizeSpec):
    model_config = ConfigDict(extra="forbid")
    width: int = Field(strict=True, gt=0, le=8192)
    height: int = Field(strict=True, gt=0, le=8192)


class StudioEditGeneration(GenerateRequest):
    model_config = ConfigDict(extra="forbid")
    providerRetryPolicy: Literal["never"] = Field(...)
    versionCount: Literal[1] = Field(...)
    targets: list[StudioEditSize] = Field(min_length=1, max_length=1)
    textMode: Literal["direct", "layered"] = "direct"

    @field_validator("versionCount", mode="before")
    @classmethod
    def strict_one(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError("Exactly one edited image is required")
        return value


class StudioEditRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    imageUrl: str = Field(max_length=_MAX_DATA_LENGTH)
    generation: StudioEditGeneration

    @model_validator(mode="after")
    def private_images_only(self):
        refs = self.generation.aiConstraints.referenceImages if self.generation.aiConstraints else []
        if len(refs) + 1 > STUDIO_EDIT_MAX_IMAGES:
            raise ValueError("Source plus references exceed the image limit")
        total = len(studio_data_bytes(self.imageUrl))
        for ref in refs:
            if ref.polarity not in {"positive", "negative"} or ref.mode not in {None, "STRICT", "INSPIRATION"}:
                raise ValueError("Unsupported reference semantics")
            total += len(studio_data_bytes(ref.url))
        if total > STUDIO_EDIT_MAX_BYTES:
            raise ValueError("Combined source and references exceed 32 MiB")
        return self
