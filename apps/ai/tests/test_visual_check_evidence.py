"""Product completion evidence; isolated fixtures, no real provider requests."""
from unittest.mock import AsyncMock

import pytest

from app.main import app
from app.providers import resolve_vlm_provider
from app.providers.http_providers import HttpVLMProvider
from app.providers.mock import MockVLMProvider


def provider(monkeypatch, payload):
    instance = HttpVLMProvider("https://provider.invalid/v1", "test-only-key")
    inline = AsyncMock(return_value="data:image/png;base64,aW1hZ2U=")
    chat = AsyncMock(return_value=payload)
    monkeypatch.setattr(instance, "_inline_image", inline)
    monkeypatch.setattr(instance, "_chat_json", chat)
    return instance, inline, chat


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {"results": [{"level": "RISK", "reason": "Logo differs"}]},
    {"results": [{"level": "pass", "reason": "Brand checked"}], "score": 98},
    {"results": [], "score": 100},
])
async def test_evidence_requires_actual_model_judgement(monkeypatch, payload):
    instance, _, chat = provider(monkeypatch, payload)
    result = await instance.check_visual_compliance("http://private/main", [])
    assert result["visualCheckPerformed"] is True
    chat.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {}, {"results": []}, {"score": 100}, {"results": [], "score": 101},
    {"results": [], "score": True}, {"results": [], "score": "100"},
    {"results": [{"reason": "Missing explicit level"}]},
    {"results": [{"level": "PASS", "reason": " "}]},
    {"results": [{"level": "UNKNOWN", "reason": "Unrecognized judgement"}]},
])
async def test_malformed_or_synthetic_fallback_is_not_execution_evidence(monkeypatch, payload):
    instance, _, chat = provider(monkeypatch, payload)
    result = await instance.check_visual_compliance("http://private/main", [])
    assert result["visualCheckPerformed"] is False
    chat.assert_awaited_once()


@pytest.mark.asyncio
async def test_blocked_main_image_keeps_legacy_risk_without_claiming_a_check(monkeypatch):
    instance, inline, chat = provider(monkeypatch, {"results": [], "score": 100})
    inline.return_value = None
    result = await instance.check_visual_compliance("http://blocked/main", [])
    assert result["results"][0]["level"] == "RISK"
    assert result["visualCheckPerformed"] is False
    chat.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_reference_prevents_complete_check_evidence(monkeypatch):
    instance, inline, _ = provider(monkeypatch, {"results": [], "score": 100})
    inline.side_effect = ["data:image/png;base64,aW1hZ2U=", None]
    result = await instance.check_visual_compliance("http://private/main", [], references=[{"url": "http://blocked/ref"}])
    assert result["visualCheckPerformed"] is False


@pytest.mark.asyncio
async def test_truncated_references_prevent_complete_check_evidence(monkeypatch):
    instance, _, _ = provider(monkeypatch, {"results": [], "score": 100})
    result = await instance.check_visual_compliance("http://private/main", [], references=[{"url": f"http://private/{n}"} for n in range(9)])
    assert result["visualCheckPerformed"] is False


@pytest.mark.asyncio
async def test_mock_has_no_real_execution_evidence():
    result = await MockVLMProvider().check_visual_compliance("http://fixture/image", [])
    assert result.get("visualCheckPerformed") is not True


@pytest.mark.parametrize("marker", [None, False, True])
def test_endpoint_propagates_explicit_evidence_without_changing_legacy_report(client, marker):
    class FakeVlm:
        async def check_visual_compliance(self, image_url, brand_rules):
            result = {"results": [], "score": 100}
            if marker is not None:
                result["visualCheckPerformed"] = marker
            return result

    app.dependency_overrides[resolve_vlm_provider] = lambda: FakeVlm()
    try:
        response = client.post("/v1/compliance/check", json={"imageUrl": "http://fixture/image", "brandRules": [], "termLib": []})
        assert response.status_code == 200
        assert response.json()["visualCheckPerformed"] is (marker is True)
        assert response.json()["report"]["overall"] == "PASS"
        assert response.json()["report"]["score"] == 100
    finally:
        app.dependency_overrides.clear()


def test_text_only_endpoint_never_claims_a_visual_check(client):
    response = client.post("/v1/compliance/check", json={"text": "Plain copy", "brandRules": [], "termLib": []})
    assert response.status_code == 200
    assert response.json()["visualCheckPerformed"] is False
