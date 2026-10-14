import pytest
from pydantic import ValidationError
from app.schemas import StudioMaterialUploadInput, StudioMaterial
from app.studio_brand_materials_schemas import StudioBrandMaterialsQuery, StudioBrandMaterialsPage, StudioBrandMaterialVerification, StudioBrandMaterialLinkInput
from app.studio_brand_upload_schemas import StudioBrandMaterialUploadInput, StudioBrandMaterialUploadView

MATERIAL = {"id": "a", "assetId": "a", "assetSha256": "a" * 64, "fileName": "产品.png", "mimeType": "image/png", "sizeBytes": 50,
            "width": 1, "height": 1, "url": "/api/workspaces/w/assets/a/raw", "kind": "image"}
MUTATION = "831a0280-2cf1-41ba-ac94-621053c4a4c6"


def test_legacy_upload_and_new_optional_identity():
    StudioMaterialUploadInput.model_validate({"projectId": "p", "mutationId": MUTATION})
    assert StudioMaterialUploadInput.model_validate({"projectId": "p", "mutationId": MUTATION, "attachToProject": False}).attachToProject is False
    StudioMaterial.model_validate({**MATERIAL, "versionId": "v"})
    for bad in ({"projectId": "p", "mutationId": MUTATION, "attachToProject": None}, {"projectId": "p", "mutationId": MUTATION, "attachToProject": "false"}):
        with pytest.raises(ValidationError):
            StudioMaterialUploadInput.model_validate(bad)
    with pytest.raises(ValidationError):
        StudioMaterial.model_validate({**MATERIAL, "versionId": None})


def test_brand_page_and_trimmed_query():
    assert StudioBrandMaterialsQuery.model_validate({"search": " 商品 "}).search == "商品"
    StudioBrandMaterialsPage.model_validate({"items": [], "nextCursor": None})
    StudioBrandMaterialLinkInput.model_validate({"operation": "link", "projectId": "p", "assetSha256": "a" * 64})


@pytest.mark.parametrize("bad", [{"limit": 61}, {"limit": True}, {"limit": "24"}, {"search": None}, {"cursor": ""}, {"workspaceId": "foreign"}])
def test_brand_query_is_strict_and_bounded(bad):
    with pytest.raises(ValidationError):
        StudioBrandMaterialsQuery.model_validate(bad)


def test_truthful_verification_receipt():
    StudioBrandMaterialVerification.model_validate({"assetId": "a", "status": "SUCCEEDED", "material": MATERIAL})
    StudioBrandMaterialVerification.model_validate({"assetId": "a", "status": "FAILED", "error": "校验失败"})
    for bad in ({"assetId": "a", "status": "SUCCEEDED"}, {"assetId": "a", "status": "PENDING", "material": MATERIAL}, {"assetId": "a", "status": "FAILED"}, {"assetId": "a", "status": "UNVERIFIED", "material": None}):
        with pytest.raises(ValidationError):
            StudioBrandMaterialVerification.model_validate(bad)


def test_projectless_brand_intake_has_no_project_identity():
    assert StudioBrandMaterialUploadInput.model_validate({"mutationId": MUTATION}).mutationId == MUTATION
    receipt = {"context": "brand-library", "workspaceId": "w", "taskId": "task", "mutationId": MUTATION,
               "status": "PENDING", "progress": 0, "expiresAt": "2026-10-14T00:00:00.000Z"}
    assert StudioBrandMaterialUploadView.model_validate(receipt).context == "brand-library"
    completed = StudioBrandMaterialUploadView.model_validate({**receipt, "status": "SUCCEEDED", "progress": 100, "material": MATERIAL})
    assert completed.material.assetId == "a"
    StudioBrandMaterialUploadView.model_validate({**receipt, "status": "FAILED", "error": "原文件校验失败"})
    for bad in ({"mutationId": MUTATION, "projectId": "brand-library"}, {"mutationId": MUTATION, "projectId": None},
                {"mutationId": MUTATION, "attachToProject": False}):
        with pytest.raises(ValidationError):
            StudioBrandMaterialUploadInput.model_validate(bad)
    for changes in ({"projectId": "fake"}, {"projectId": None}, {"context": "project"}, {"workspaceId": "w\n"},
                    {"progress": True}, {"status": "SUCCEEDED"}, {"material": MATERIAL}, {"material": None},
                    {"status": "FAILED"}, {"expiresAt": "2026-99-14T00:00:00.000Z"}):
        with pytest.raises(ValidationError):
            StudioBrandMaterialUploadView.model_validate({**receipt, **changes})
