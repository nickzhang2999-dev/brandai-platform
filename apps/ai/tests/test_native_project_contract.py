import pytest
from pydantic import ValidationError
from app.schemas import NativeProjectSaveInput, NativeProjectListInput, NativeProjectRenameInput, NativeProjectQueryInput


PAYLOAD = {"projectId": "p", "canvas": "SHAKKERDATA://encoded", "version": "novart-7"}


def test_native_project_defaults_and_optional_wire():
    assert NativeProjectListInput().model_dump(exclude_none=True) == {"page": 1, "pageSize": 20}
    assert NativeProjectSaveInput(**PAYLOAD).model_dump(exclude_none=True) == PAYLOAD
    assert NativeProjectRenameInput(projectId="p", projectName=" Name ").projectName == "Name"
    NativeProjectSaveInput(**{**PAYLOAD, "version": "novart-2147483646", "canvasV2Gray": False})


@pytest.mark.parametrize("model, payload", [
    (NativeProjectQueryInput, {"projectId": "p"}),
    (NativeProjectListInput, {}),
    (NativeProjectRenameInput, {"projectId": "p", "projectName": "Name"}),
    (NativeProjectSaveInput, PAYLOAD),
])
def test_captured_native_correlation_metadata(model, payload):
    assert model(**{**payload, "cid": "1791452226131qfvxtohg"}).cid == "1791452226131qfvxtohg"
    for cid in [None, "", 123, "x" * 129]:
        with pytest.raises(ValidationError):
            model(**{**payload, "cid": cid})


@pytest.mark.parametrize("extra", [
    {"version": "local-old"}, {"version": "novart-01"}, {"version": "novart-2147483647"},
    {"version": "novart-1\n"}, {"projectId": "../p"}, {"picCount": None}, {"picCount": True},
    {"sourceProjectId": "other"}, {"projectType": 5}, {"projectType": 3.0},
    {"canvasV2Gray": True}, {"canvasV2Gray": 0}, {"canvasEvidenceEnabled": True},
    {"canvasEvidenceWindowId": "x"}, {"projectName": "a\nb"},
])
def test_native_unsupported_inputs(extra):
    with pytest.raises(ValidationError):
        NativeProjectSaveInput(**{**PAYLOAD, **extra})
