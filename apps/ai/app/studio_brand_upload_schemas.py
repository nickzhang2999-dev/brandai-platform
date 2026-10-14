"""Projectless brand intake is distinct from project-bound upload receipts."""
from typing import Literal
from pydantic import Field, model_validator
from .schemas import NativeProjectId, StudioMaterial
from .studio_brand_materials_schemas import StrictOptionalModel


class StudioBrandMaterialUploadInput(StrictOptionalModel):
    mutationId: str = Field(min_length=36, max_length=36, pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


class StudioBrandMaterialUploadView(StudioBrandMaterialUploadInput):
    context: Literal["brand-library"]
    workspaceId: NativeProjectId
    taskId: NativeProjectId
    status: Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]
    progress: int = Field(ge=0, le=100)
    expiresAt: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
    material: StudioMaterial | None = None
    error: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def truthful_receipt(self):
        from datetime import datetime
        if "\n" in self.expiresAt or "\n" in self.workspaceId:
            raise ValueError("Invalid identity or expiry")
        datetime.fromisoformat(self.expiresAt[:-1] + "+00:00")
        if (self.status == "SUCCEEDED") != (self.material is not None):
            raise ValueError("Only a completed upload carries a material")
        if self.status == "FAILED" and not self.error:
            raise ValueError("Failed uploads require an error")
        return self
