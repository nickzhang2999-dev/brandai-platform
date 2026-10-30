"""Boundary fixtures, not evidence of provider image quality."""
from copy import deepcopy
import pytest
from app.studio_layer_assessment_schemas import LayerAssessment
from app.omni_asset_workflow_schemas import OmniAssetWorkflow

def assessment(kind="CONTINUOUS_TEXTURE", action="INFER_BACKGROUND"):
    return {"occlusions": [{"target": "草地", "kind": kind, "action": action, "evidence": "周边草纹连续", "reason": "可合理推断纹理"}],
            "preserve": ["保留原图白线与足球"], "shadowPolicy": "KEEP_WITH_SUBJECT", "shadowEvidence": "投影与主体相连"}

@pytest.mark.parametrize("kind", ["CONTINUOUS_TEXTURE", "REGULAR_STRUCTURE"])
def test_background_inference_is_a_proposal(kind):
    assert LayerAssessment.model_validate(assessment(kind)).occlusions[0].action == "INFER_BACKGROUND"

@pytest.mark.parametrize("kind", ["IDENTITY_OR_PRODUCT", "TEXT_OR_LOGO", "ATTACHED_OBJECTS", "TRANSPARENCY_OR_REFLECTION"])
def test_hidden_identity_and_exact_information_are_not_background(kind):
    with pytest.raises(ValueError):
        LayerAssessment.model_validate(assessment(kind))
    assert LayerAssessment.model_validate(assessment(kind, "REFERENCE_REQUIRED")).occlusions

def test_empty_or_oversized_utf16_and_duplicate_targets_rejected():
    for value in ["\ufeff", "😀" * 151]:
        with pytest.raises(ValueError):
            LayerAssessment.model_validate({**assessment(), "preserve": [value]})
    value = assessment()
    value["occlusions"] *= 2
    with pytest.raises(ValueError):
        LayerAssessment.model_validate(value)

def workflow():
    return {"schema_version": 1, "source": {"asset_id": "fixture-asset", "revision": 2, "sha256": "a" * 64},
            "analysis": {"status": "completed", "job_id": "analysis-1", "model_version": "fixture"},
            "ai_review": {"status": "completed", "suggestion": "accept", "policy_version": "review-r1", "job_id": "review-1"},
            "human_review": {"status": "unknown", "reviewer_id": None, "decided_at": None},
            "permissions": {"analysis": "allowed", "display": "unknown", "export": "unknown"}, "publication": "draft"}

def test_model_success_never_mutates_human_or_permission_state():
    original = workflow()
    assert OmniAssetWorkflow.model_validate(deepcopy(original)).model_dump() == original
    original["human_review"] = {"status": "approved", "reviewer_id": "fixture-reviewer", "decided_at": "2026-10-30T12:00:00+08:00"}
    assert OmniAssetWorkflow.model_validate(original).human_review.status == "approved"

@pytest.mark.parametrize("patch", [
    {"schema_version": True}, {"token": "forbidden-field"},
    {"human_review": {"status": "approved", "reviewer_id": None, "decided_at": None}},
    {"ai_review": {"status": "running", "suggestion": "accept", "policy_version": "review-r1", "job_id": "review-1"}},
    {"ai_review": {"status": "completed", "suggestion": "accept", "policy_version": None, "job_id": "review-1"}},
    {"analysis": {"status": "completed", "job_id": "analysis-1", "model_version": None}},
])
def test_model_and_review_records_require_actual_evidence(patch):
    with pytest.raises(ValueError):
        OmniAssetWorkflow.model_validate({**workflow(), **patch})
