import pytest
from pydantic import ValidationError
from app.studio_copywriting_schemas import StudioCopywritingInput, StudioCopywritingResult

def test_copywriting_input_and_rewrite():
    value = {"mutationId": "23d272a3-acce-49a0-9c20-32a31c3a2837", "prompt": "写文案"}
    assert StudioCopywritingInput(**value).mode == "GENERATE"
    with pytest.raises(ValidationError):
        StudioCopywritingInput(**value, mode="REWRITE")
    with pytest.raises(ValidationError):
        StudioCopywritingInput(**value, url="https://foreign.test")
    with pytest.raises(ValidationError):
        StudioCopywritingInput(**value, image=None)

def test_copywriting_result_requires_content_and_usage():
    result = StudioCopywritingResult(candidates=[{"title": "标题", "body": "正文"}], model="qwen3.7-plus", inputTokens=10, outputTokens=20, latencyMs=5)
    assert result.outputTokens == 20
    with pytest.raises(ValidationError):
        StudioCopywritingResult(candidates=[], model="qwen3.7-plus", inputTokens=0, outputTokens=0, latencyMs=0)
