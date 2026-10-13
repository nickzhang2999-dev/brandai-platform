import pytest
from pydantic import ValidationError
from app.schemas import StudioGeneratedPsdQuery, StudioGeneratedPsdView

def view():
    return dict(projectId="p", requestId="r", requested=False, status="NOT_REQUESTED", error=None, decomposition=None, downloadUrl=None)

def test_psd_receipt_and_query_are_strict_and_cannot_imply_unarchived_success():
    assert StudioGeneratedPsdView.model_validate(view()).status == "NOT_REQUESTED"
    assert StudioGeneratedPsdQuery.model_validate(dict(projectId="p", requestId="r")).requestId == "r"
    assert StudioGeneratedPsdView.model_validate(view() | dict(requested=True, status="FAILED", error="configuration missing")).error
    for change in [dict(requested=True), dict(status="READY", requested=True), dict(outputJson={}), dict(downloadUrl="https://provider.invalid/private")]:
        with pytest.raises(ValidationError): StudioGeneratedPsdView.model_validate(view() | change)
    for query in [dict(projectId="p"), dict(projectId="p", requestId=None), dict(projectId="p", requestId="r", provider="mock")]:
        with pytest.raises(ValidationError): StudioGeneratedPsdQuery.model_validate(query)

def test_unfinished_download_must_be_null():
    with pytest.raises(ValidationError):
        StudioGeneratedPsdView.model_validate(view() | dict(requested=True, status="PENDING", downloadUrl="/api/workspaces/w/studio/decomposition/d/export?projectId=p&format=psd"))
