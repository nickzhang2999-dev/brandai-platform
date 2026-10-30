"""Mirror parity and planner instructions only; no external/provider calls."""
import json
import pytest
from pydantic import ValidationError
from app.studio_project_context_schemas import StudioProjectContextSaveInput, StudioProjectContextSnapshot
from app.studio_conversation_schemas import StudioConversationInput
from app.studio_conversation_model import ConversationModelRequest, run_conversation_model

FACTS = {"goal": "推广", "audience": "用户", "approvedCopy": "标题", "visualRequirements": "绿色"}
SOURCE = {"assetId": "asset", "assetSha256": "a" * 64}
SAVE = {"mutationId": "831a0280-2cf1-41ba-ac94-621053c4a4c6", "expectedRevision": 0, "facts": FACTS,
        "materials": [{**SOURCE, "role": "PRODUCT"}], "master": None}

def test_context_contract_and_no_permissions_from_roles():
    assert StudioProjectContextSaveInput.model_validate(SAVE).materials[0].role == "PRODUCT"
    for role in ["PRODUCT", "BRAND", "COPY", "STYLE"]:
        StudioProjectContextSaveInput.model_validate({**SAVE, "materials": [{**SOURCE, "role": role}]})
    for patch in [{"role": "EXACT"}, {"role": "STYLE", "availableForGeneration": True}, {"role": "STYLE", "url": "https://unit.invalid"}]:
        with pytest.raises(ValidationError):
            StudioProjectContextSaveInput.model_validate({**SAVE, "materials": [{**SOURCE, **patch}]})

@pytest.mark.parametrize("patch", [{"expectedRevision": -1}, {"expectedRevision": 1.5}, {"materials": [SAVE["materials"][0]] * 2},
                                  {"master": {**SOURCE, "shapeId": "shape:master"}}, {"master": {**SOURCE, "url": "https://unit.invalid"}}])
def test_invalid_intake(patch):
    with pytest.raises(ValidationError):
        StudioProjectContextSaveInput.model_validate({**SAVE, **patch})

def test_opt_in_and_no_browser_snapshot():
    value = {"mutationId": SAVE["mutationId"], "text": "做海报", "references": [], "documentRevision": 0, "workflowRevision": 0,
             "sizeSelection": {"ratioKey": "1:1", "resolutionTier": "1K"}}
    assert StudioConversationInput.model_validate(value).projectContextRevision is None
    assert StudioConversationInput.model_validate({**value, "projectContextRevision": 0}).projectContextRevision == 0
    for patch in [{"projectContextRevision": None}, {"projectContext": {"facts": FACTS}}]:
        with pytest.raises(ValidationError):
            StudioConversationInput.model_validate({**value, **patch})

def test_timestamps_and_no_invented_planner_references():
    with pytest.raises(ValidationError):
        StudioProjectContextSnapshot.model_validate({"projectId": "p", "revision": 0, "facts": FACTS, "materials": [], "master": None, "updatedAt": "invalid"})
    value = {"schemaVersion": 2, "text": "海报", "references": [], "quickEditTargetId": None, "previousResultReferenceId": None, "history": [], "selectedReferenceIds": [],
             "projectContext": {"revision": 1, "facts": FACTS, "materials": [], "masterReferenceId": None}}
    ConversationModelRequest.model_validate(value)
    with pytest.raises(ValidationError):
        ConversationModelRequest.model_validate({**value, "projectContext": {**value["projectContext"], "masterReferenceId": "forged"}})

@pytest.mark.asyncio
async def test_planner_receives_known_facts_as_task_data_with_current_user_priority():
    captured = {}
    class FixtureModel:
        async def _chat_json(self, parts, **kwargs):
            captured.update(parts=parts, **kwargs)
            return {"action": "generate", "targetReferenceId": None, "referenceIds": [], "confidence": .95,
                    "clarification": None, "imagePrompt": "本轮海报背景蓝色，标题保留", "options": []}
    value = ConversationModelRequest.model_validate({"schemaVersion": 2, "text": "本轮背景蓝色", "references": [], "quickEditTargetId": None,
        "previousResultReferenceId": None, "history": [], "selectedReferenceIds": [],
        "projectContext": {"revision": 1, "facts": FACTS, "materials": [{"role": "COPY", "name": "文字截图", "referenceId": None}], "masterReferenceId": None}})
    await run_conversation_model(value, FixtureModel())
    assert json.loads(captured["parts"][0]["text"])["projectContext"]["facts"] == FACTS
    assert "Current explicit user requirements" in captured["system"]
    assert "not sufficient visual-style evidence" in captured["system"]
