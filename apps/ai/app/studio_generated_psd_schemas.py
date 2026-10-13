"""Generated PSD receipt mirror. No provider endpoint is exposed."""
from typing import Literal
from pydantic import Field, model_validator
from .studio_workflow_schemas import StrictModel, ProjectId
from .studio_generation_schemas import StudioGenerationRetryInput
from .studio_decomposition_schemas import StudioDecompositionView

StudioGeneratedPsdQuery = StudioGenerationRetryInput

class StudioGeneratedPsdView(StrictModel):
    projectId: ProjectId
    requestId: ProjectId
    requested: bool
    status: Literal["NOT_REQUESTED", "PENDING", "RUNNING", "READY", "FAILED"]
    error: str | None = Field(max_length=1000)
    decomposition: StudioDecompositionView | None
    downloadUrl: str | None = Field(pattern=r"^/api/workspaces/[A-Za-z0-9_-]{1,128}/studio/decomposition/[A-Za-z0-9_-]{1,128}/export\?projectId=[A-Za-z0-9_-]{1,128}&format=psd\z")

    @model_validator(mode="after")
    def consistent_state(self):
        if self.requested != (self.status != "NOT_REQUESTED"):
            raise ValueError("PSD intent and state must agree")
        if self.status == "READY" and (not self.downloadUrl or not self.decomposition or self.decomposition.status != "SUCCEEDED" or self.decomposition.projectId != self.projectId):
            raise ValueError("PSD needs complete persisted scoped layers")
        if self.status != "READY" and self.downloadUrl:
            raise ValueError("An unfinished PSD cannot be downloaded")
        if self.status == "NOT_REQUESTED" and (self.error or self.decomposition):
            raise ValueError("Unrequested PSD has no job or failure")
        return self
