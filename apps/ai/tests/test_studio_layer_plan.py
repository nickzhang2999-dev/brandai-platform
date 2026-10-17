"""Semantic planner behavior with a transport fixture; no real provider calls."""
import base64
import io
import json

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.providers import resolve_vlm_provider
from app.providers.http_providers import HttpVLMProvider
from app.providers.mock import MockVLMProvider
from app.studio_layer_plan import LayerPlanRequest, LayerPlan
from app.studio_decomposition_schemas import StudioDecompositionInput
from app.studio_generation_schemas import StudioGenerationInput

def image_ref():
    body = io.BytesIO()
    Image.new("RGBA", (8, 8), (45, 30, 140, 120)).save(body, format="PNG")
    return "data:image/png;base64," + base64.b64encode(body.getvalue()).decode()

def plan(count=3):
    return {"layerCount": count, "summary": "图中主体与装饰可分别编辑。",
            "groups": [{"name": f"组{i+1}", "description": "实际可见内容"} for i in range(count)]}

@pytest.fixture(autouse=True)
def reset_overrides():
    old = app.dependency_overrides.copy()
    yield
    app.dependency_overrides.clear()
    app.dependency_overrides.update(old)

def configured(result=None, status=200, model="fixture-vision"):
    calls = []
    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        assert request.url.path == "/v1/chat/completions"
        if status != 200:
            return httpx.Response(status, json={"error": "fixture provider rejected"})
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(result if result is not None else plan())}}]})
    provider = HttpVLMProvider("https://fixture.invalid/v1", "fixture-not-a-real-key", model=model, transport=httpx.MockTransport(handler))
    app.dependency_overrides[resolve_vlm_provider] = lambda: provider
    return calls

def post(**extra):
    return TestClient(app).post("/v1/studio/layer-plan", json={"imageUrl": image_ref(), "maxLayers": 10, "providerRetryPolicy": "never", **extra})

def test_uses_actual_image_and_vision_selected_count_once_with_execution_evidence():
    calls = configured(plan(5))
    response = post(intent="人物保持完整")
    assert response.status_code == 200
    assert response.json()["plan"]["layerCount"] == 5
    assert response.json()["usage"]["provider"] == "HttpVLMProvider"
    assert response.json()["revision"] == "semantic-layer-plan-r1"
    assert len(calls) == 1
    content = calls[0]["messages"][1]["content"]
    assert content[1]["image_url"]["url"] == image_ref()
    assert "人物保持完整" in content[0]["text"]
    assert "not verified output-layer labels" in content[0]["text"]

def test_missing_real_vision_service_fails_without_fixed_count_fallback():
    app.dependency_overrides[resolve_vlm_provider] = lambda: MockVLMProvider()
    assert post().status_code == 503

def test_unsupported_image_groups_fail_before_any_decomposition_request():
    calls = configured({"unsupported": True})
    assert post().status_code == 422
    assert len(calls) == 1

@pytest.mark.parametrize("result", [plan(4), {**plan(3), "layerCount": 2}, {**plan(3), "layerCount": True}])
def test_invalid_or_over_budget_plans_are_never_repaired_to_a_habitual_default(result):
    calls = configured(result)
    assert post(maxLayers=3).status_code == 422
    assert len(calls) == 1

def test_duplicate_semantic_names_are_rejected():
    result = plan()
    result["groups"][1]["name"] = result["groups"][0]["name"]
    configured(result)
    assert post().status_code == 422

def test_vision_paid_post_is_not_retried_even_when_transport_returns_error():
    calls = configured(status=503)
    assert post().status_code == 502
    assert len(calls) == 1

@pytest.mark.parametrize("model", ["gpt-5.6-sol", "gpt-5", "gpt-5-mini", "o3", "o4-mini", "openai/gpt-5.6-sol", "OpenAI/O4-mini"])
def test_reasoning_vision_uses_supported_bounded_parameters_without_fallback(model):
    calls = configured(model=model)
    assert post().status_code == 200
    assert len(calls) == 1
    assert calls[0]["model"] == model
    assert calls[0]["max_completion_tokens"] == 2400
    assert calls[0]["reasoning_effort"] == "low"
    assert "max_tokens" not in calls[0] and "temperature" not in calls[0]

@pytest.mark.parametrize("model", ["custom-vision", "openai/gpt-4o", "vendor/gpt-50-vision"])
def test_existing_non_reasoning_provider_parameters_unchanged(model):
    calls = configured(model=model)
    assert post().status_code == 200
    assert calls[0]["max_tokens"] == 2400 and calls[0]["temperature"] == .2
    assert "max_completion_tokens" not in calls[0]

@pytest.mark.parametrize("status,code", [(400,"PROVIDER_REQUEST_REJECTED"),(401,"PROVIDER_AUTH"),(429,"PROVIDER_RATE_LIMITED"),(503,"PROVIDER_UNAVAILABLE")])
def test_planner_preserves_safe_provider_failure_category_without_second_paid_post(status, code):
    calls = configured(status=status, model="gpt-5.6-sol")
    response = post()
    assert response.status_code == 502
    assert response.json()["error"] == {"code":code,"stage":"provider","upstreamStatus":status}
    assert len(calls) == 1

def test_raw_remote_urls_or_corrupt_inlined_bytes_never_reach_the_paid_vision_post():
    calls = configured()
    assert post(imageUrl="https://untrusted.invalid/private.png").status_code == 422
    assert post(imageUrl="data:image/png;base64," + base64.b64encode(b"not image bytes").decode()).status_code == 422
    assert calls == []

def test_request_has_no_retry_downgrade_and_requires_a_budget():
    for patch in ({"providerRetryPolicy": "auto"}, {"maxLayers": 1}, {"maxLayers": 11}, {"maxLayers": True}):
        with pytest.raises(ValueError):
            LayerPlanRequest.model_validate({"imageUrl": image_ref(), "maxLayers": 10, "providerRetryPolicy": "never", **patch})

def test_input_mirrors_auto_selection_and_legacy_manual_scope():
    base = {"projectId": "p", "mutationId": "831a0280-2cf1-41ba-ac94-621053c4a4c6", "sourceShapeId": "shape:a", "assetId": "a", "assetSha256": "a" * 64, "documentRevision": 0}
    assert StudioDecompositionInput.model_validate({**base, "layerMode": "AUTO"}).layerCount is None
    assert StudioDecompositionInput.model_validate({**base, "layerCount": 4}).layerCount == 4
    for patch in ({"layerMode": "AUTO", "layerCount": 4}, {"layerMode": "MANUAL"}, {}):
        with pytest.raises(ValueError):
            StudioDecompositionInput.model_validate({**base, **patch})
    generation = {"projectId": "p", "mutationId": base["mutationId"], "prompt": "tree", "sizeSelection": {"ratioKey": "1:1", "resolutionTier": "1K"}, "workflowRevision": 0, "documentRevision": 0}
    assert StudioGenerationInput.model_validate({**generation, "psdLayerMode": "AUTO"}).psdLayerCount is None
    with pytest.raises(ValueError):
        StudioGenerationInput.model_validate({**generation, "psdLayerMode": "AUTO", "psdLayerCount": 4})
