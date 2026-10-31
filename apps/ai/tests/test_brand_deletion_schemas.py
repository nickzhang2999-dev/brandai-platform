import pytest
from pydantic import ValidationError
from app.brand_deletion_schemas import BrandDeletionInput, BrandDeletionPreview, BrandDeletionResult

COUNTS = {"projects": 1, "assets": 2, "rules": 0, "terms": 0, "prohibitions": 0, "inspirationCases": 0, "members": 1}
PREVIEW = {"workspaceId": "w", "name": "品牌", "counts": COUNTS, "activeTasks": 0, "canDelete": True, "blockedReason": None, "confirmationToken": "a" * 64}
INPUT = {"confirmationName": "品牌", "confirmationToken": "a" * 64, "mutationId": "ad717f54-3ddd-4afd-8aca-392ab1624656"}

def test_precise_preview_and_local_destinations():
    BrandDeletionPreview.model_validate(PREVIEW)
    BrandDeletionInput.model_validate(INPUT)
    for next_id, path in [("next", "/studio?workspaceId=next#/home"), (None, "/studio")]:
        BrandDeletionResult.model_validate({"ok": True, "deletedWorkspaceId": "w", "nextWorkspaceId": next_id, "redirectTo": path})

@pytest.mark.parametrize("patch", [{"activeTasks": 1}, {"canDelete": False}, {"blockedReason": "blocked"}, {"counts": {**COUNTS, "projects": -1}}, {"counts": {**COUNTS, "assets": "2"}}, {"ownerId": "other"}, {"activeTasks": True}])
def test_rejects_inconsistent_preview(patch):
    with pytest.raises(ValidationError):
        BrandDeletionPreview.model_validate({**PREVIEW, **patch})

@pytest.mark.parametrize("patch", [{"confirmationName": ""}, {"confirmationToken": ""}, {"mutationId": "not-uuid"}, {"force": True}])
def test_rejects_unconfirmed_request(patch):
    with pytest.raises(ValidationError):
        BrandDeletionInput.model_validate({**INPUT, **patch})

@pytest.mark.parametrize("path", ["https://evil.invalid", "//evil.invalid", "/studio?workspaceId=other#/home", "/projects/old"])
def test_rejects_mismatched_destination(path):
    with pytest.raises(ValidationError):
        BrandDeletionResult.model_validate({"ok": True, "deletedWorkspaceId": "w", "nextWorkspaceId": "next", "redirectTo": path})

@pytest.mark.parametrize("value", [1, "true", False, None])
def test_result_requires_literal_boolean(value):
    with pytest.raises(ValidationError):
        BrandDeletionResult.model_validate({"ok": value, "deletedWorkspaceId": "w", "nextWorkspaceId": None, "redirectTo": "/studio"})
