import pytest
from pydantic import TypeAdapter, ValidationError
from app.schemas import AsyncTaskKind, NotificationKind, StudioGenerationComplianceInput, StudioGenerationComplianceView

def receipt():
    return dict(taskId="task",versionId="version",status="PENDING",progress=0,expiresAt="2026-10-09T12:06:00Z",checkedImageSha256=None,report=None,error=None,canRetry=False)

def report():
    return dict(overall="RISK",textResults=[],visualResults=[dict(level="RISK",reason="Brand color differs")],checkedAt="2026-10-09T12:01:00Z",score=82.5)

def test_check_identity_and_mirrored_task_kinds():
    assert StudioGenerationComplianceInput.model_validate(dict(projectId="project",versionId="version")).versionId == "version"
    assert TypeAdapter(AsyncTaskKind).validate_python("STUDIO_COMPLIANCE") == "STUDIO_COMPLIANCE"
    assert TypeAdapter(NotificationKind).validate_python("STUDIO_GENERATION") == "STUDIO_GENERATION"
    for extra in [dict(userId="other"),dict(report=report()),dict(versionId="version\n")]:
        with pytest.raises(ValidationError): StudioGenerationComplianceInput.model_validate(dict(projectId="project",versionId="version") | extra)

def test_completed_risk_is_distinct_from_unfinished_check():
    assert StudioGenerationComplianceView.model_validate(receipt()).report is None
    completed = receipt() | dict(status="SUCCEEDED",progress=100,report=report(),checkedImageSha256="a"*64)
    assert StudioGenerationComplianceView.model_validate(completed).report.overall == "RISK"
    assert StudioGenerationComplianceView.model_validate(receipt() | dict(status="FAILED",error="Unavailable",canRetry=True)).report is None
    assert StudioGenerationComplianceView.model_validate(receipt() | dict(status="NOT_REQUESTED",taskId=None,expiresAt=None)).taskId is None

@pytest.mark.parametrize("change",[
    dict(status="SUCCEEDED"),dict(status="FAILED"),dict(status="FAILED",error="failed",report=report()),
    dict(checkedImageSha256="a"*64),dict(status="NOT_REQUESTED"),dict(taskId=None),dict(expiresAt=None),
    dict(progress=100.5),dict(checkedImageSha256="not-a-digest"),
])
def test_reject_misleading_check_state(change):
    with pytest.raises(ValidationError): StudioGenerationComplianceView.model_validate(receipt() | change)
