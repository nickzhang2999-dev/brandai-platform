"""Mirror the explicit BFF Brand Kit intake contracts (not model settings)."""
from pydantic import BaseModel, Field, field_validator
from typing import Literal
BrandKitTargetType = Literal["logo", "color", "font", "layout", "imagery", "copy", "graphic"]

class BrandKitImportBase(BaseModel):
    targetType: BrandKitTargetType | None = None
    mutationId: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    @field_validator("targetType", "mutationId", mode="before")
    @classmethod
    def reject_null(cls, value):
        if value is None: raise ValueError("Optional fields must be omitted, not null")
        return value

class BrandKitRecognizeInput(BrandKitImportBase):
    assetIds: list[str] = Field(min_length=1, max_length=50)

    @field_validator("assetIds")
    @classmethod
    def nonempty_ids(cls, value):
        if any(not item for item in value): raise ValueError("Empty asset id")
        return value

class BrandKitParseManualInput(BrandKitImportBase):
    assetId: str = Field(min_length=1)
