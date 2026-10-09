"""Single-attempt product transport against HTTP adapters; no upstream network."""
import asyncio
import base64
import io

import httpx
import pytest
from PIL import Image
from pydantic import ValidationError
from tenacity import stop_after_attempt, wait_none

from app.main import app
from app.providers import resolve_image_provider, resolve_vlm_provider
from app.providers.http_providers import HttpImageProvider, HttpVLMProvider
from app.providers.retry_policy import call_with_retry_policy, should_retry_provider
from app.schemas import ComplianceCheckRequest, GenerateRequest


def image_data():
    output = io.BytesIO()
    Image.new("RGB", (2, 2), "red").save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def generation_payload(path="text", policy="never"):
    payload = {"sceneType": "ECOM_MAIN", "sellingPoint": "A product poster", "scene": "",
               "brandRules": [], "versionCount": 1}
    if policy is not None:
        payload["providerRetryPolicy"] = policy
    if path != "text":
        payload["aiConstraints"] = {"negativePrompt": [], "promptAdditions": [], "hardBlocks": [],
            "referenceImages": [{"url": image_data(), "source": "asset:fixture", "polarity": "positive",
                                  "mode": "STRICT", "note": "ASSET_USAGE:ADAPTIVE:1"}]}
    return payload


@pytest.fixture(autouse=True)
def fast_legacy_attempts(monkeypatch):
    # A fixed count and no sleep make the preservation of legacy retries exact.
    for operation in [HttpImageProvider.generate, HttpImageProvider.generate_with_references,
                      HttpImageProvider._load_image_bytes, HttpVLMProvider._chat_json]:
        monkeypatch.setattr(operation.retry, "stop", stop_after_attempt(3))
        monkeypatch.setattr(operation.retry, "wait", wait_none())


def fail_response(request, failure):
    if failure == "disconnect":
        raise httpx.ConnectError("fixture disconnect", request=request)
    if failure == "timeout":
        raise httpx.ReadTimeout("fixture timeout after POST", request=request)
    if failure == "invalid_json":
        return httpx.Response(200, content=b"not-json", headers={"content-type": "application/json"})
    return httpx.Response(200, json={"data": []})


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["text", "references", "edit_fallback"])
@pytest.mark.parametrize("failure", ["disconnect", "timeout", "invalid_json", "empty_images"])
@pytest.mark.parametrize("policy", ["never", None])
async def test_image_paid_post_count_and_no_after_failure_fallback(path, failure, policy):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "POST"
        assert b"providerRetryPolicy" not in request.content
        return fail_response(request, failure)

    provider = HttpImageProvider("https://api.openai.com/v1" if path != "edit_fallback" else "https://gateway.invalid/v1",
                                 "fixture-key", model="gpt-image-2" if path != "edit_fallback" else "fixture-generic",
                                 transport=httpx.MockTransport(handler))
    app.dependency_overrides[resolve_image_provider] = lambda: provider
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as client:
            response = await client.post("/v1/generate", json=generation_payload(path, policy))
        assert response.status_code >= 400
        # The old edit fallback already has no paid-POST retry. Both other
        # adapter methods retain three legacy attempts but only one in product.
        assert len(calls) == (1 if policy == "never" or path == "edit_fallback" else 3)
        assert {request.url.path for request in calls} == {"/v1/images/generations" if path == "text" else "/v1/images/edits"}
        assert should_retry_provider(ValueError("outside request")) is True
    finally:
        app.dependency_overrides.pop(resolve_image_provider, None)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["disconnect", "timeout", "invalid_json"])
@pytest.mark.parametrize("policy", ["never", None])
async def test_visual_paid_post_count_uses_same_policy(monkeypatch, failure, policy):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.path == "/v1/chat/completions"
        assert b"providerRetryPolicy" not in request.content
        return fail_response(request, failure)

    provider = HttpVLMProvider("https://vision.invalid/v1", "fixture-key", transport=httpx.MockTransport(handler))

    async def inline(url, **_kwargs):
        return url

    monkeypatch.setattr(provider, "_inline_image", inline)
    app.dependency_overrides[resolve_vlm_provider] = lambda: provider
    payload = {"imageUrl": image_data(), "brandRules": [], "termLib": []}
    if policy is not None:
        payload["providerRetryPolicy"] = policy
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as client:
            response = await client.post("/v1/compliance/check", json=payload)
        assert response.status_code >= 400
        assert len(calls) == (1 if policy == "never" else 3)
        assert should_retry_provider(ValueError("outside request")) is True
    finally:
        app.dependency_overrides.pop(resolve_vlm_provider, None)


@pytest.mark.asyncio
async def test_success_never_echoes_internal_policy(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        assert b"providerRetryPolicy" not in request.content
        return httpx.Response(200, json={"data": [{"url": image_data()}]})

    provider = HttpImageProvider("https://api.openai.com/v1", "fixture-key", transport=httpx.MockTransport(handler))
    app.dependency_overrides[resolve_image_provider] = lambda: provider
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/v1/generate", json=generation_payload())
        assert response.status_code == 200
        assert len(calls) == 1
        assert "providerRetryPolicy" not in response.text
        assert should_retry_provider(ValueError("outside request")) is True
    finally:
        app.dependency_overrides.pop(resolve_image_provider, None)


@pytest.mark.asyncio
async def test_source_failure_never_falls_back_to_paid_text_generation(monkeypatch):
    posts, loads = [], []

    def post(request):
        posts.append(request)
        raise AssertionError("source failed before provider submission")

    async def source(*args, **kwargs):
        loads.append(1)
        raise httpx.ReadTimeout("fixture source unavailable")

    monkeypatch.setattr("app.providers.http_providers.safe_get", source)
    provider = HttpImageProvider("https://api.openai.com/v1", "fixture-key", transport=httpx.MockTransport(post))
    app.dependency_overrides[resolve_image_provider] = lambda: provider
    payload = generation_payload("references")
    payload["aiConstraints"]["referenceImages"][0]["url"] = "https://source.invalid/image.png"
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as client:
            response = await client.post("/v1/generate", json=payload)
        assert response.status_code >= 400
        assert len(loads) == 1
        assert posts == []
    finally:
        app.dependency_overrides.pop(resolve_image_provider, None)


@pytest.mark.asyncio
async def test_concurrent_legacy_and_product_scopes_are_isolated_and_reset():
    arrived = 0
    ready = asyncio.Event()

    async def inspect(expected):
        nonlocal arrived
        arrived += 1
        if arrived == 2:
            ready.set()
        await ready.wait()
        assert should_retry_provider(ValueError("inside")) is expected
        await asyncio.sleep(0)
        assert should_retry_provider(ValueError("after scheduling")) is expected

    await asyncio.gather(call_with_retry_policy("never", inspect, False), call_with_retry_policy(None, inspect, True))
    assert should_retry_provider(ValueError("outside")) is True


@pytest.mark.asyncio
async def test_exception_cancellation_and_nested_scope_restore():
    async def fail():
        assert should_retry_provider(ValueError("inside")) is False
        raise ValueError("fixture failure")

    with pytest.raises(ValueError, match="fixture failure"):
        await call_with_retry_policy("never", fail)
    assert should_retry_provider(ValueError("after failure")) is True

    async def cancel():
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await call_with_retry_policy("never", cancel)
    assert should_retry_provider(ValueError("after cancellation")) is True

    async def nested():
        async def inner():
            assert should_retry_provider(ValueError("nested")) is False
        await call_with_retry_policy(None, inner)
        assert should_retry_provider(ValueError("outer")) is False

    await call_with_retry_policy("never", nested)
    assert should_retry_provider(ValueError("after nesting")) is True
    assert should_retry_provider(asyncio.CancelledError()) is False


@pytest.mark.parametrize("value", [None, "", "always", "default", 1, True, {}])
def test_contract_rejects_null_and_unknown_retry_policy(value):
    with pytest.raises(ValidationError):
        GenerateRequest.model_validate({**generation_payload(), "providerRetryPolicy": value})
    with pytest.raises(ValidationError):
        ComplianceCheckRequest.model_validate({"providerRetryPolicy": value})


def test_contract_omission_preserves_legacy_and_health_advertises_policy(client):
    assert "providerRetryPolicy" not in GenerateRequest.model_validate(generation_payload(policy=None)).model_dump(exclude_none=True)
    assert "providerRetryPolicy" not in ComplianceCheckRequest().model_dump(exclude_none=True)
    assert GenerateRequest.model_validate(generation_payload()).providerRetryPolicy == "never"
    assert ComplianceCheckRequest(providerRetryPolicy="never").providerRetryPolicy == "never"
    assert client.get("/health").json()["providerRetryRevision"] == "single-provider-attempt-r1"
