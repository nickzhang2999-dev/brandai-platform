"""Contract parity only. No model/provider calls."""
import pytest
from pydantic import ValidationError
from app.studio_image_tool_schemas import StudioImageToolInput, StudioImageToolSpec, StudioLayerRepairContext

INPUT = {"projectId": "p", "mutationId": "831a0280-2cf1-41ba-ac94-621053c4a4c6", "documentRevision": 1, "workflowRevision": 0,
         "target": {"shapeId": "shape:source", "assetSha256": "a" * 64}, "operation": "inpaint", "mask": "data:image/png;base64,AAAA"}

def test_optional_lineage_stays_out_of_provider_spec():
    assert StudioImageToolInput.model_validate(INPUT).decompositionRequestId is None
    assert StudioImageToolInput.model_validate({**INPUT, "decompositionRequestId": "parent"}).decompositionRequestId == "parent"
    with pytest.raises(ValidationError):
        StudioImageToolSpec.model_validate({"operation": "inpaint", "mask": INPUT["mask"], "decompositionRequestId": "parent"})

@pytest.mark.parametrize("value", [None, "", "foreign/parent", " parent "])
def test_invalid_optional_lineage(value):
    with pytest.raises(ValidationError):
        StudioImageToolInput.model_validate({**INPUT, "decompositionRequestId": value})

def test_no_cutout_link_and_no_quality_claim():
    with pytest.raises(ValidationError):
        StudioImageToolInput.model_validate({**INPUT, "operation": "remove-background", "mask": None, "decompositionRequestId": "parent"})
    value = {"decompositionRequestId": "parent", "sourceShapeId": "shape:source", "assetId": "source", "assetSha256": "a" * 64,
             "width": 96, "height": 64, "mode": "inferred-completion", "independentQuality": "NOT_REVIEWED"}
    assert StudioLayerRepairContext.model_validate(value).model_dump() == value
    with pytest.raises(ValidationError):
        StudioLayerRepairContext.model_validate({**value, "independentQuality": "APPROVED"})
