import pytest
from pydantic import ValidationError
from app.schemas import StudioMaterialUploadInput, StudioMaterialUploadQuery, StudioMaterialUploadView

MUTATION = "831a0280-2cf1-41ba-ac94-621053c4a4c6"
RECEIPT = {"taskId": "task", "projectId": "project", "mutationId": MUTATION, "status": "PENDING", "progress": 0, "expiresAt": "2026-10-09T00:06:00.000Z"}
MATERIAL = {"id": "asset", "assetId": "asset", "assetSha256": "a" * 64, "fileName": "image.png", "mimeType": "image/png", "sizeBytes": 123, "width": 2, "height": 3, "url": "/api/workspaces/w/assets/asset/raw", "kind": "image"}

def test_upload_identity_and_pending_receipt():
    StudioMaterialUploadInput.model_validate({"projectId": "project", "mutationId": MUTATION})
    StudioMaterialUploadView.model_validate(RECEIPT)
    StudioMaterialUploadQuery.model_validate({"projectId": "project"})
    for bad in ({"projectId": "project", "taskId": None}, {"projectId": "project", "userId": "victim"}):
        with pytest.raises(ValidationError):
            StudioMaterialUploadQuery.model_validate(bad)

@pytest.mark.parametrize("extra", [{"material": MATERIAL}, {"status": "SUCCEEDED"}, {"status": "FAILED"}, {"material": None}, {"error": None}, {"progress": True}])
def test_upload_rejects_untruthful_or_null_receipts(extra):
    with pytest.raises(ValidationError):
        StudioMaterialUploadView.model_validate({**RECEIPT, **extra})

def test_success_and_failure_are_explicit():
    StudioMaterialUploadView.model_validate({**RECEIPT, "status": "SUCCEEDED", "material": MATERIAL})
    StudioMaterialUploadView.model_validate({**RECEIPT, "status": "FAILED", "error": "Upload expired"})

@pytest.mark.parametrize("url", ["blob:temp", "data:image/png;base64,a", "https://object.invalid/a", "/api/workspaces/w/assets/asset/raw\n"])
def test_only_authenticated_relative_material_urls(url):
    with pytest.raises(ValidationError):
        StudioMaterialUploadView.model_validate({**RECEIPT, "status": "SUCCEEDED", "material": {**MATERIAL, "url": url}})
