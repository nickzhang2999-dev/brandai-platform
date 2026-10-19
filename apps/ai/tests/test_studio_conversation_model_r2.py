"""Bounded r2 context, untrusted plans and single paid-attempt HTTP fixtures."""
import base64
import io
import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from app.main import app
from app.providers import resolve_vlm_provider
from app.providers.http_providers import HttpVLMProvider
from app.studio_conversation_model import ConversationModelRequest, run_conversation_model


def thumbnail():
    body = io.BytesIO()
    Image.new("RGB", (8, 6), "blue").save(body, format="PNG")
    return {"dataUrl": "data:image/png;base64," + base64.b64encode(body.getvalue()).decode(), "width": 8, "height": 6}


def body(**extra):
    return {"schemaVersion": 2, "text": "把图片2背景换蓝色，保留文案‘夏日’", "references": [
        {"referenceId": "one", "name": "图片1", "editable": False, "thumbnail": thumbnail()},
        {"referenceId": "two", "name": "图片2", "editable": True}], "quickEditTargetId": None,
        "previousResultReferenceId": "two", "selectedReferenceIds": ["two"],
        "history": [{"role": "assistant", "text": "已经完成上一张", "resultReferenceId": "two"}],
        "providerRetryPolicy": "never", **extra}


def decision(**extra):
    return {"action": "modify", "targetReferenceId": "two", "referenceIds": ["one"], "confidence": .9,
        "clarification": None, "imagePrompt": "仅把图片2的背景替换为蓝色，保留主体和原有夏日文案。", "options": [], **extra}


def option(id="edit", **extra):
    return {"id": id, "label": "修改图片2", "action": "modify", "targetReferenceId": "two",
        "referenceIds": ["one"], "imagePrompt": "保留夏日文案，修改图片2的背景为蓝色。", **extra}


@pytest.fixture(autouse=True)
def overrides():
    original = app.dependency_overrides.copy()
    yield
    app.dependency_overrides.clear()
    app.dependency_overrides.update(original)


def configure(result=None, *, status=200, finish="stop", usage=None, raw=None):
    calls = []
    def handler(request):
        calls.append(json.loads(request.content))
        if status != 200:
            return httpx.Response(status, json={"error": "fixture secret upstream detail"})
        return httpx.Response(200, json={"choices": [{"finish_reason": finish, "message": {
            "content": raw if raw is not None else json.dumps(result if result is not None else decision())}}],
            **({"usage": usage} if usage is not None else {})})
    provider = HttpVLMProvider("https://fixture.invalid/v1", "fixture-key", model="openai/gpt-5.6-sol", transport=httpx.MockTransport(handler))
    app.dependency_overrides[resolve_vlm_provider] = lambda: provider
    return calls


def post(payload=None):
    return TestClient(app).post("/v1/studio/conversation-intent", json=body() if payload is None else payload)


def test_r2_image_parts_history_selection_and_usage_have_distinct_wire_fields(caplog):
    calls = configure(usage={"prompt_tokens": 123, "completion_tokens": 76, "total_tokens": 199,
                            "completion_tokens_details": {"reasoning_tokens": 18}, "private": "must not log"})
    with caplog.at_level(logging.INFO, logger="brandai.ai.intent"):
        response = post(body(lastResultImage={"name": "上次结果", "thumbnail": thumbnail()}))
    assert response.status_code == 200 and response.json()["revision"] == "structured-conversation-intent-r2"
    assert response.json()["usage"]["reasoningTokens"] == 18
    assert response.json()["usage"]["latencyMs"] >= 0
    assert len(calls) == 1 and calls[0]["max_completion_tokens"] == 2400
    assert calls[0]["reasoning_effort"] == "low"
    content = calls[0]["messages"][1]["content"]
    payload = json.loads(content[0]["text"])
    assert "data:image" not in content[0]["text"] and "providerRetryPolicy" not in payload
    assert payload["selectedReferenceIds"] == ["two"] and payload["history"][0]["resultReferenceId"] == "two"
    assert payload["lastResultImage"] == {"name": "上次结果", "visualContextOnly": True}
    assert len([item for item in content if item["type"] == "image_url"]) == 2
    assert all(item["image_url"]["detail"] == "low" for item in content if item["type"] == "image_url")
    assert '"finishReason":"stop"' in caplog.text and '"inputTokens":123' in caplog.text
    assert "夏日" not in caplog.text and "data:image" not in caplog.text and "fixture-key" not in caplog.text and "must not log" not in caplog.text


def test_absent_usage_stays_absent_not_zero_and_legacy_response_stays_r1():
    configure()
    response = post()
    assert response.json()["usage"].keys() == {"latencyMs"}
    configure({k: v for k, v in decision().items() if k not in ("imagePrompt", "options")})
    payload = body(schemaVersion=1)
    for key in ("history", "selectedReferenceIds"):
        payload.pop(key)
    payload["references"][0].pop("thumbnail")
    response = post(payload)
    assert response.status_code == 200 and response.json()["revision"] == "structured-conversation-intent-r1"
    assert "usage" not in response.json() and "imagePrompt" not in response.json()["decision"]


@pytest.mark.parametrize("change", [
    {"selectedReferenceIds": ["foreign"]}, {"selectedReferenceIds": ["two", "two"]},
    {"history": [{"role": "assistant", "text": "result", "resultReferenceId": "foreign"}]},
    {"lastResultImage": {"name": "result", "thumbnail": thumbnail(), "referenceId": "foreign"}},
    {"history": [{"role": "user", "text": "x" * 1001, "resultReferenceId": None}]},
    {"providerRetryPolicy": "auto"}, {"schemaVersion": True},
])
def test_invalid_context_is_rejected_without_a_provider_call(change):
    calls = configure()
    assert post(body(**change)).status_code == 422
    assert not calls


def test_last_result_counts_toward_four_image_budget():
    refs = [{"referenceId": str(i), "name": str(i), "editable": True, "thumbnail": thumbnail()} for i in range(4)]
    with pytest.raises(ValidationError):
        ConversationModelRequest.model_validate(body(references=refs, selectedReferenceIds=[], previousResultReferenceId=None,
            history=[], lastResultImage={"name": "last", "thumbnail": thumbnail()}))


@pytest.mark.parametrize("thumb", [
    {**thumbnail(), "width": 7}, {**thumbnail(), "width": 513},
    {**thumbnail(), "dataUrl": "https://untrusted.invalid/private.png"},
    {**thumbnail(), "dataUrl": "data:image/png;base64," + base64.b64encode(b"corrupt").decode()},
    {**thumbnail(), "dataUrl": thumbnail()["dataUrl"].replace("image/png", "image/jpeg")},
    {**thumbnail(), "dataUrl": "data:image/png;base64," + base64.b64encode(b"a" * (128 * 1024 + 1)).decode()},
])
def test_corrupt_or_unbounded_thumbnail_never_reaches_paid_post(thumb):
    calls = configure()
    payload = body()
    payload["references"][0]["thumbnail"] = thumb
    assert post(payload).status_code >= 400
    assert not calls


@pytest.mark.parametrize("result", [
    decision(targetReferenceId="foreign"), decision(targetReferenceId="one", referenceIds=[]),
    decision(referenceIds=["two"]), decision(referenceIds=["foreign"]), decision(imagePrompt=None),
    decision(action="clarify", targetReferenceId=None, clarification="选择用途", imagePrompt=None, options=[option()]),
    decision(action="clarify", targetReferenceId=None, clarification="选择用途", imagePrompt=None, options=[option(), option("new", targetReferenceId="foreign")]),
    decision(options=[option()]),
])
def test_untrusted_action_or_option_fails_after_exactly_one_call(result):
    calls = configure(result)
    assert post().status_code == 502 and len(calls) == 1


def test_pinned_target_may_clarify_only_among_edits_of_that_target():
    result = decision(action="clarify", targetReferenceId=None, clarification="选择修改方式", imagePrompt=None,
        options=[option("blue"), option("pale", label="浅蓝背景", imagePrompt="修改图片2为浅蓝背景，保留夏日文案。")])
    configure(result)
    assert post(body(quickEditTargetId="two")).status_code == 200
    result["options"][1] = option("new", action="generate", targetReferenceId=None)
    calls = configure(result)
    assert post(body(quickEditTargetId="two")).status_code == 502 and len(calls) == 1


@pytest.mark.parametrize("text", ['保留文案“夏日”', "保留文案‘夏日’", '保留文案「夏日」'])
def test_quoted_copy_is_not_changed_in_rewritten_prompt_or_options(text):
    calls = configure(decision(imagePrompt="修改图片2背景，文案 Summer"))
    assert post(body(text=text)).status_code == 502 and len(calls) == 1


@pytest.mark.parametrize("failure", ["length", "content_filter", "invalid_json", "status", "timeout"])
def test_unknown_or_failed_paid_call_is_not_replayed_and_logs_only_safe_summary(failure, caplog):
    calls = configure(status=503 if failure == "status" else 200,
        finish=failure if failure in ("length", "content_filter") else "stop",
        raw="not-json private response" if failure == "invalid_json" else None,
        usage={"prompt_tokens": 123, "completion_tokens": 2400, "total_tokens": 2523})
    if failure == "timeout":
        def handler(request):
            calls.append(1)
            raise httpx.ReadTimeout("private upstream URL", request=request)
        provider = HttpVLMProvider("https://fixture.invalid/v1", "fixture-key", transport=httpx.MockTransport(handler))
        app.dependency_overrides[resolve_vlm_provider] = lambda: provider
    with caplog.at_level(logging.INFO, logger="brandai.ai.intent"):
        response = post()
    assert response.status_code == 502 and len(calls) == 1
    assert '"status":"UNKNOWN"' in caplog.text
    assert "private" not in caplog.text and "fixture-key" not in caplog.text and "夏日" not in caplog.text
    if failure == "length":
        assert '"finishReason":"length"' in caplog.text and '"outputTokens":2400' in caplog.text


@pytest.mark.asyncio
async def test_timeout_boundary_stays_25_seconds_without_waiting_in_test(monkeypatch):
    calls = []
    class Provider:
        async def _chat_json(self, *args, **kwargs):
            calls.append(1)
            return decision()
    async def expires(awaitable, *, timeout):
        assert timeout == 25
        await awaitable
        raise TimeoutError("fixture deadline")
    monkeypatch.setattr("app.studio_conversation_model.asyncio.wait_for", expires)
    with pytest.raises(TimeoutError):
        await run_conversation_model(ConversationModelRequest.model_validate(body()), Provider())
    assert len(calls) == 1
