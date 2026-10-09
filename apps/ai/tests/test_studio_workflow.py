import copy
import math

import pytest
from pydantic import ValidationError
from app.studio_workflow_schemas import (
    StudioWorkflowAssets, StudioWorkflowIssue, StudioWorkflowSaveInput, StudioWorkflowView,
)

SHA = "a" * 64
REF = {"shapeId": "shape:image", "assetSha256": SHA, "purpose": "REFERENCE", "participates": True}
INPUT = {"projectId": "p", "revision": 0, "mode": "generate", "target": None, "references": [REF]}


def test_workflow_reference_and_target_semantics():
    assert StudioWorkflowSaveInput.model_validate(INPUT).model_dump() == INPUT
    modified = {**INPUT, "mode": "modify", "target": {"shapeId": "shape:image", "assetSha256": SHA}}
    StudioWorkflowSaveInput.model_validate(modified)
    disabled = {**INPUT, "references": [{**REF, "shapeId": None, "purpose": None, "participates": False}]}
    StudioWorkflowSaveInput.model_validate(disabled)
    for bad in [{**INPUT, "mode": "modify"}, {**INPUT, "target": modified["target"]},
                {**INPUT, "references": [{**REF, "purpose": None}]}]:
        with pytest.raises(ValidationError):
            StudioWorkflowSaveInput.model_validate(bad)


@pytest.mark.parametrize("extra", [{"cid": "c"}, {"workspaceId": "other"}, {"userId": "u"},
    {"references": [REF, REF]}, {"references": [{**REF, "shapeId": f"shape:{i}"} for i in range(9)]}])
def test_unknown_fields_and_reference_bounds(extra):
    with pytest.raises(ValidationError):
        StudioWorkflowSaveInput.model_validate({**INPUT, **extra})


@pytest.mark.parametrize("revision", [-1, 0.1, None, "0", True, 2147483647])
def test_save_revision_bounds(revision):
    with pytest.raises(ValidationError):
        StudioWorkflowSaveInput.model_validate({**INPUT, "revision": revision})


@pytest.mark.parametrize("field,value", [
    ("shapeId", "shape:"), ("shapeId", "shape:image\n"), ("shapeId", "shape:含中文"), ("shapeId", "shape:two words"),
    ("assetSha256", SHA.upper()), ("assetSha256", SHA + "\n"), ("assetSha256", "bad"),
])
def test_canonical_reference_ids(field, value):
    with pytest.raises(ValidationError):
        StudioWorkflowSaveInput.model_validate({**INPUT, "references": [{**REF, field: value}]})


@pytest.mark.parametrize("project_id", ["", "../p", "p\n", "x" * 129])
def test_canonical_project_id(project_id):
    with pytest.raises(ValidationError):
        StudioWorkflowSaveInput.model_validate({**INPUT, "projectId": project_id})


def test_explicit_nullable_and_optional_fields():
    view = {**INPUT, "revision": 2147483647, "updatedAt": None, "issues": []}
    StudioWorkflowView.model_validate(view)
    del view["updatedAt"]
    with pytest.raises(ValidationError):
        StudioWorkflowView.model_validate(view)
    issue = {"code": "MISSING", "scope": "reference", "shapeId": None, "assetSha256": SHA,
             "message": "图片缺失", "blocking": True}
    StudioWorkflowIssue.model_validate(issue)
    for index in [None, -1, 8, True]:
        with pytest.raises(ValidationError):
            StudioWorkflowIssue.model_validate({**issue, "index": index})


@pytest.mark.parametrize("width", [0, -1, "50", math.inf, math.nan, True])
def test_asset_dimensions(width):
    asset = {"shapeId": "shape:image", "assetSha256": SHA, "name": "图片", "width": width,
             "height": 50, "valid": True, "mime": "image/png"}
    with pytest.raises(ValidationError):
        StudioWorkflowAssets.model_validate({"projectId": "p", "assets": [asset], "issues": []})


def test_array_references_and_view_data_remain_unchanged():
    original = copy.deepcopy(INPUT)
    StudioWorkflowSaveInput.model_validate(INPUT)
    assert original == INPUT
    asset = {"shapeId": "shape:image", "assetSha256": SHA, "name": "图片", "width": None,
             "height": 50, "valid": True, "mime": "image/png"}
    StudioWorkflowAssets.model_validate({"projectId": "p", "assets": [asset], "issues": []})
