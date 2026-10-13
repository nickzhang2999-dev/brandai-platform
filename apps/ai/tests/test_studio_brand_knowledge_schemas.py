import pytest
from pydantic import ValidationError
from app.studio_brand_knowledge_schemas import StudioBrandDraftImportInput, StudioBrandDraftImportResult, StudioBrandDraftImportState

MUTATION = "71ae8509-1766-4730-a660-c7d927f173a6"

def test_import_revision_is_positive_and_client_content_cannot_replace_saved_draft():
    assert StudioBrandDraftImportInput(mutationId=MUTATION, expectedDraftRevision=4).expectedDraftRevision == 4
    for bad in [0, True, "4"]:
        with pytest.raises(ValidationError):
            StudioBrandDraftImportInput(mutationId=MUTATION, expectedDraftRevision=bad)
    with pytest.raises(ValidationError):
        StudioBrandDraftImportInput(mutationId=MUTATION, expectedDraftRevision=4, colors=["#ffffff"])

def test_empty_state_and_two_rule_receipt_mirror():
    assert not StudioBrandDraftImportState(available=False, draftRevision=0, importableTypes=[], hasNotes=False).available
    result = StudioBrandDraftImportResult(mutationId=MUTATION, draftRevision=4, ruleIds=["a", "b"], created=2, replayed=False, notesPreserved=True)
    assert result.ruleIds == ["a", "b"]
    with pytest.raises(ValidationError):
        StudioBrandDraftImportResult(**{**result.model_dump(), "ruleIds": ["", "b"]})
