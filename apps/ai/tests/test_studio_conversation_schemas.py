import pytest
from pydantic import ValidationError
from app.studio_conversation_schemas import StudioConversationInput, StudioConversationDraftInput, StudioConversationPixels

def body():
    return {"mutationId": "831a0280-2cf1-41ba-ac94-621053c4a4c6", "text": " 生成海报 ", "references": [], "documentRevision": 1,
            "workflowRevision": 0, "sizeSelection": {"ratioKey": "1:1", "resolutionTier": "1K"}}

def reference():
    return {"referenceId": "shape:image1", "shapeId": "shape:image1", "name": "图片1", "assetId": "asset1", "assetSha256": "a" * 64, "width": 1080, "height": 1920}

def test_input_matches_optional_defaults_and_trim():
    value = StudioConversationInput.model_validate(body())
    assert value.text == "生成海报"
    assert value.quickEditTargetId is None
    assert "revision" not in value.model_dump(exclude_none=True)

@pytest.mark.parametrize("extra", [{"workspaceId": "foreign"}, {"userId": "foreign"}, {"requestedSize": None}, {"outputFrameId": None}, {"revision": 0}, {"text": "  "}, {"documentRevision": 0.5}])
def test_invalid_requests_rejected(extra):
    with pytest.raises(ValidationError):
        StudioConversationInput.model_validate({**body(), **extra})

def test_ordered_refs_and_quick_edit_target():
    ref = reference()
    value = StudioConversationInput.model_validate({**body(), "references": [ref], "quickEditTargetId": ref["referenceId"]})
    assert value.references[0].purpose == "REFERENCE"
    with pytest.raises(ValidationError):
        StudioConversationInput.model_validate({**body(), "references": [ref, ref]})
    with pytest.raises(ValidationError):
        StudioConversationInput.model_validate({**body(), "references": [ref], "quickEditTargetId": "missing"})

@pytest.mark.parametrize("size", [{"width": 8192, "height": 8192}, {"width": 32, "height": 1080}, {"width": 32.5, "height": 32}])
def test_pixels_bounded(size):
    with pytest.raises(ValidationError):
        StudioConversationPixels.model_validate(size)

def test_blank_draft_is_valid():
    assert StudioConversationDraftInput.model_validate({"revision": 0, "text": "", "references": [], "sizeSelection": body()["sizeSelection"]}).text == ""
