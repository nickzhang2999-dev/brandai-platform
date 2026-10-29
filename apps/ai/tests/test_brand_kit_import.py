"""Explicit Brand Kit intent is optional and never changes legacy callers."""
import asyncio
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from app.brand_kit_import_schemas import BrandKitRecognizeInput, BrandKitParseManualInput
from app.schemas import RecognizeRequest, ParseManualRequest
from app.providers.http_providers import HttpVLMProvider
from app import main


@pytest.mark.parametrize("schema,body", [
    (BrandKitRecognizeInput, {"assetIds": ["a"]}),
    (BrandKitParseManualInput, {"assetId": "a"}),
    (RecognizeRequest, {"assets": [{"id": "a", "url": "https://synthetic.invalid/a"}]}),
    (ParseManualRequest, {"url": "https://synthetic.invalid/a"}),
])
def test_optional_target_mirrors_zod(schema, body):
    assert "targetType" not in schema(**body).model_dump(exclude_none=True)
    assert schema(**body, targetType="logo").targetType == "logo"
    for bad in (None, "LOGO", "admin", "", 1):
        with pytest.raises(ValidationError):
            schema(**body, targetType=bad)


def test_recognize_endpoint_only_threads_explicit_intent(client):
    provider = type("Synthetic", (), {"analyze_assets": AsyncMock(return_value={"rules": []})})()
    main.app.dependency_overrides[main.resolve_vlm_provider] = lambda: provider
    try:
        for extra in ({}, {"targetType": "logo"}):
            response = client.post("/v1/recognize", json={"assets": [{"id": "a", "url": "https://synthetic.invalid/a"}], **extra})
            assert response.status_code == 200
        assert provider.analyze_assets.call_args_list[0].kwargs == {}
        assert provider.analyze_assets.call_args_list[1].kwargs == {"target_type": "logo"}
        assert client.post("/v1/recognize", json={"assets": [], "targetType": "bad"}).status_code == 422
        assert provider.analyze_assets.call_count == 2
    finally:
        main.app.dependency_overrides.pop(main.resolve_vlm_provider, None)


def test_http_provider_focus_only_when_requested_and_preserves_legacy_prompt():
    async def run():
        provider = HttpVLMProvider("https://never-called.invalid/v1", "synthetic-only")
        provider._inline_image = AsyncMock(return_value="data:image/png;base64,YQ==")
        provider._chat_json = AsyncMock(return_value={"rules": []})
        await provider.analyze_assets([{"id": "a", "url": "https://never-called.invalid/a"}])
        await provider.analyze_assets([{"id": "a", "url": "https://never-called.invalid/a"}], target_type="logo")
        first = provider._chat_json.call_args_list[0].args[0][0]["text"]
        second = provider._chat_json.call_args_list[1].args[0][0]["text"]
        assert "用户明确选择" not in first
        assert second.startswith(first)
        assert "用户明确选择 logo" in second
        await provider.parse_manual("synthetic text", target_type="layout")
        assert "用户明确选择 layout" in provider._chat_json.call_args.args[0][0]["text"]
        assert provider._chat_json.call_count == 3
    asyncio.run(run())


def test_intake_limits_and_uuid_reject_invalid_explicit_values():
    for body in ({"assetIds": []}, {"assetIds": [""]}, {"assetIds": ["a"] * 51}, {"assetIds": ["a"], "mutationId": "bad"}, {"assetIds": ["a"], "mutationId": None}):
        with pytest.raises(ValidationError):
            BrandKitRecognizeInput(**body)
