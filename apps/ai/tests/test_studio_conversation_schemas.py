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

def test_r2_choices_are_identifier_only_and_preserve_original_options():
    ref = reference()
    value = {**body(), "references": [ref], "selectedReferenceIds": [ref["referenceId"]], "psdLayerMode": "MANUAL", "psdLayerCount": 4,
             "decision": {"sourceMessageId": "message1", "optionId": "edit", "kind": "clarification"}, "homeStart": True}
    parsed = StudioConversationInput.model_validate(value)
    assert parsed.psdLayerCount == 4 and parsed.decision.sourceMessageId == "message1"
    for change in ({"decision": {**value["decision"], "imagePrompt": "untrusted override"}}, {"selectedReferenceIds": ["foreign"]},
                   {"selectedReferenceIds": [ref["referenceId"], ref["referenceId"]]}, {"homeStart": 1}, {"decision": None},
                   {"psdLayerMode": "AUTO"}, {"selectedReferenceIds": None}):
        with pytest.raises(ValidationError):
            StudioConversationInput.model_validate({**value, **change})

def test_message_can_retain_original_input_but_not_server_only_context():
    from app.studio_conversation_schemas import StudioConversationMessage
    message = {"messageId": "m1", "mutationId": body()["mutationId"], "projectId": "p1", "text": "生成海报", "references": [],
               "status": "CLARIFICATION", "intent": None, "generation": None, "error": None, "clarification": "选择用途",
               "createdAt": "2026-10-19T00:00:00.000Z", "expiresAt": "2026-10-19T00:06:00.000Z", "originalInput": body()}
    assert StudioConversationMessage.model_validate(message).originalInput.text == "生成海报"
    with pytest.raises(ValidationError):
        StudioConversationMessage.model_validate({**message, "originalInput": {**body(), "history": []}})
