import httpx
import pytest
from app.ai_failure import failure_response


@pytest.mark.parametrize("stage,expected", [("source","SOURCE_UNAVAILABLE"), ("unknown","AI_REQUEST_FAILED"), ("private-stage","AI_REQUEST_FAILED")])
def test_download_429_is_not_misdiagnosed_as_model_throttling(stage, expected, caplog):
    request=httpx.Request("GET","https://private.invalid/?token=secret")
    exc=httpx.HTTPStatusError("private-token",request=request,response=httpx.Response(429,request=request,text="private-body"))
    exc._novart_failure_stage=stage
    status, body=failure_response(exc,"private-id")
    assert status == 502 and body["error"]["code"] == expected
    assert "private" not in str(body) + caplog.text


def test_only_safe_task_identity_is_logged(caplog):
    exc=httpx.ReadTimeout("private-token")
    exc._novart_failure_stage="provider"
    request_id="sgr_" + "a"*32
    status, body=failure_response(exc, request_id)
    assert status == 504 and body["error"]["code"] == "PROVIDER_TIMEOUT"
    assert request_id in caplog.text and "private" not in caplog.text
