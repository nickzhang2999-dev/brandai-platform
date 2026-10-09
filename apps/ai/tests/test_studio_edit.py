"""Whole-image edit HTTP payloads and failure boundaries; no real upstream."""
import base64
import io
from email.parser import BytesParser
from email.policy import default

import httpx
import pytest
from PIL import Image
from pydantic import ValidationError
from tenacity import stop_after_attempt, wait_none

from app.main import app
from app.providers import resolve_image_provider
from app.providers.http_providers import HttpImageProvider
from app.providers.mock import MockImageProvider
from app.studio_edit_schemas import StudioEditRequest, STUDIO_EDIT_MAX_BYTES, studio_data_bytes


def data(color="red", size=(4, 3), fmt="PNG"):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    mime = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}[fmt]
    return f"data:image/{mime};base64," + base64.b64encode(buffer.getvalue()).decode()


def payload():
    return {"imageUrl": data(), "generation": {"sceneType": "SOCIAL_POSTER", "sellingPoint": "Change the background to a beach", "scene": "",
        "brandRules": [], "versionCount": 1, "providerRetryPolicy": "never", "textMode": "direct",
        "targets": [{"key": "wide", "label": "Wide", "width": 2560, "height": 1440, "resolutionTier": "2K"}],
        "aiConstraints": {"referenceImages": [], "negativePrompt": ["no forbidden red mark"], "promptAdditions": ["Keep logo safe margin"], "hardBlocks": []}}}


def multipart(request):
    message = BytesParser(policy=default).parsebytes(b"Content-Type: " + request.headers["content-type"].encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + request.content)
    parts = list(message.iter_parts())
    images = [part.get_payload(decode=True) for part in parts if part.get_param("name", header="content-disposition") == "image[]"]
    fields = {part.get_param("name", header="content-disposition"): part.get_payload(decode=True).decode() for part in parts if part.get_filename() is None}
    return fields, images


@pytest.fixture(autouse=True)
def cleanup_and_fast_retry(monkeypatch):
    for op in [HttpImageProvider.generate, HttpImageProvider.generate_with_references]:
        monkeypatch.setattr(op.retry, "stop", stop_after_attempt(3))
        monkeypatch.setattr(op.retry, "wait", wait_none())
    yield
    app.dependency_overrides.pop(resolve_image_provider, None)


async def post(body, provider, path="/v1/studio/edit"):
    app.dependency_overrides[resolve_image_provider] = lambda: provider
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as client:
        return await client.post(path, json=body)


@pytest.mark.asyncio
@pytest.mark.parametrize("prompt_mode", ["direct", "branded_direct", "branded"])
async def test_actual_edit_keeps_source_first_all_reference_roles_and_literal_size(prompt_mode):
    body = payload()
    body["generation"]["promptMode"] = prompt_mode
    body["generation"]["brandRules"] = [{"id": "brand", "type": "color", "strength": "STRONG", "status": "CONFIRMED", "summary": "Mandatory blue identity", "value": {}}]
    refs = [
        {"url": data("blue"), "source": "brand", "mode": "INSPIRATION", "polarity": "positive", "note": "style example"},
        {"url": data("green"), "source": "negative", "mode": "INSPIRATION", "polarity": "negative", "note": "avoid green texture"},
        {"url": data("yellow"), "source": "adaptive", "mode": "STRICT", "polarity": "positive", "note": "ASSET_USAGE:ADAPTIVE:1"},
        {"url": data("cyan"), "source": "reference", "mode": "STRICT", "polarity": "positive", "note": "ASSET_USAGE:REFERENCE:2"},
        {"url": data("white"), "source": "logo", "mode": "STRICT", "polarity": "positive", "note": "BRAND_LOGO_LOCKED: original"},
    ]
    body["generation"]["aiConstraints"]["referenceImages"] = refs
    calls = []
    result_image = data("purple", size=(6, 4))

    def upstream(request):
        calls.append(request)
        assert request.url.path == "/v1/images/edits"
        fields, images = multipart(request)
        assert images == [studio_data_bytes(body["imageUrl"]), *(studio_data_bytes(ref["url"]) for ref in refs)]
        assert fields["size"] == "2560x1440"
        assert fields["n"] == "1"
        assert fields["quality"] == "high"
        assert fields["model"] == "openai/gpt-image-2"
        prompt = fields["prompt"]
        for text in ["input image #1 is the source", "Mandatory blue identity", "Keep logo safe margin", "no forbidden red mark", "NEGATIVE example", "REFERENCE inspiration", "ADAPTIVE subject", "authoritative BRAND LOGO", "Change the background to a beach"]:
            assert text in prompt
        assert "providerRetryPolicy" not in fields
        assert "data:image" not in prompt
        return httpx.Response(200, json={"data": [{"url": result_image}]})

    provider = HttpImageProvider("https://gateway.invalid/v1", "fixture-key", model="openai/gpt-image-2", transport=httpx.MockTransport(upstream))
    response = await post(body, provider)
    assert response.status_code == 200, response.text
    assert len(calls) == 1
    version = response.json()["versions"][0]
    assert version["width"] == 2560 and version["height"] == 1440
    assert version["actualWidth"] == 6 and version["actualHeight"] == 4
    assert version["params"]["generationPath"] == "studio_whole_image_edit"
    assert "data:image" not in str(version["params"])
    assert "providerRetryPolicy" not in response.text


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["disconnect", "timeout", "invalid_json", "empty", "multiple"])
async def test_paid_failure_is_one_edit_post_without_retry_or_text_fallback(failure):
    calls = []

    def upstream(request):
        calls.append(request)
        assert request.url.path == "/v1/images/edits"
        if failure == "disconnect": raise httpx.ConnectError("fixture disconnect", request=request)
        if failure == "timeout": raise httpx.ReadTimeout("fixture timeout", request=request)
        if failure == "invalid_json": return httpx.Response(200, content=b"not-json")
        return httpx.Response(200, json={"data": [] if failure == "empty" else [{"url": data()}, {"url": data()}]})

    provider = HttpImageProvider("https://api.openai.com/v1", "fixture-key", model="gpt-image-2", transport=httpx.MockTransport(upstream))
    assert (await post(payload(), provider)).status_code >= 400
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("problem", ["mock", "old_model", "empty_model", "missing_key", "bad_size", "hard_block", "remote_source", "remote_ref", "bad_bytes", "mime_mismatch", "truncated", "too_many", "mask", "retry_null", "retry_missing", "two_targets"])
async def test_unsupported_inputs_fail_before_any_upstream_request(problem):
    calls = []
    provider = HttpImageProvider("https://api.openai.com/v1", "fixture-key", model="gpt-image-2", transport=httpx.MockTransport(lambda request: calls.append(request) or httpx.Response(500)))
    body = payload()
    if problem == "mock": provider = MockImageProvider()
    elif problem == "old_model": provider.model = "gpt-image-1"
    elif problem == "empty_model": provider.model = ""
    elif problem == "missing_key": provider.api_key = " "
    elif problem == "bad_size": body["generation"]["targets"][0]["height"] = 1441
    elif problem == "hard_block": body["generation"]["aiConstraints"]["hardBlocks"] = [{"reason": "Do not generate", "source": "rule:1"}]
    elif problem == "remote_source": body["imageUrl"] = "https://source.invalid/photo.png"
    elif problem == "remote_ref": body["generation"]["aiConstraints"]["referenceImages"] = [{"url": "https://source.invalid/ref.png", "source": "asset", "polarity": "positive"}]
    elif problem == "bad_bytes": body["imageUrl"] = "data:image/png;base64,YWJjZA=="
    elif problem == "mime_mismatch": body["imageUrl"] = data().replace("image/png", "image/jpeg")
    elif problem == "truncated": body["imageUrl"] = "data:image/png;base64," + base64.b64encode(studio_data_bytes(data())[:40]).decode()
    elif problem == "too_many": body["generation"]["aiConstraints"]["referenceImages"] = [{"url": data(), "source": str(n), "polarity": "positive"} for n in range(16)]
    elif problem == "mask": body["mask"] = data()
    elif problem == "retry_null": body["generation"]["providerRetryPolicy"] = None
    elif problem == "retry_missing": del body["generation"]["providerRetryPolicy"]
    elif problem == "two_targets": body["generation"]["targets"] *= 2
    response = await post(body, provider)
    assert response.status_code == 422, response.text
    assert calls == []


def test_aggregate_counts_actual_decoded_bytes(monkeypatch):
    import app.studio_edit_schemas as schemas
    assert STUDIO_EDIT_MAX_BYTES == 32 * 1024 * 1024
    body = payload()
    one = len(studio_data_bytes(body["imageUrl"]))
    body["generation"]["aiConstraints"]["referenceImages"] = [{"url": body["imageUrl"], "source": "fixture", "polarity": "positive"}]
    monkeypatch.setattr(schemas, "STUDIO_EDIT_MAX_BYTES", one * 2 - 1)
    with pytest.raises(ValidationError, match="Combined source"):
        StudioEditRequest.model_validate(body)
    monkeypatch.setattr(schemas, "STUDIO_EDIT_MAX_BYTES", one * 2)
    assert StudioEditRequest.model_validate(body).imageUrl == body["imageUrl"]


@pytest.mark.asyncio
async def test_legacy_generate_keeps_its_own_routing_and_prompt(client):
    body = payload()["generation"]
    del body["providerRetryPolicy"]
    body["promptMode"] = "direct"
    body["brandRules"] = [{"id": "r", "type": "color", "strength": "STRONG", "status": "CONFIRMED", "summary": "Ignored in legacy direct", "value": {}}]
    response = await post(body, MockImageProvider(), "/v1/generate")
    assert response.status_code == 200
    assert response.json()["versions"][0]["params"]["prompt"] == body["sellingPoint"]
    assert client.get("/health").json()["studioEditRevision"] == "studio-whole-image-edit-r1"
