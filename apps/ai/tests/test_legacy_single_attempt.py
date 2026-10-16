"""ASGI endpoint tests with a retrying provider fixture; no model or network calls."""
import httpx
import pytest
from pydantic import ValidationError
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_none

import app.main as main
from app.providers import resolve_image_provider, resolve_vlm_provider
from app.providers.retry_policy import should_retry_provider
from app import schemas

CASES = [
    ("/v1/ingest/website", schemas.IngestWebsiteRequest, {"url": "https://example.invalid"}),
    ("/v1/recognize", schemas.RecognizeRequest, {"assets": [{"id": "asset-1", "url": "https://example.invalid/image.png"}]}),
    ("/v1/describe", schemas.DescribeRequest, {"url": "https://example.invalid/image.png"}),
    ("/v1/parse-manual", schemas.ParseManualRequest, {"url": "https://example.invalid/manual.pdf"}),
    ("/v1/summarize", schemas.SummarizeRequest, {"mode": "brief_decompose", "text": "poster"}),
    ("/v1/edit", schemas.EditRequest, {"imageUrl": "https://example.invalid/image.png", "op": "RESIZE", "payload": {}}),
]


@pytest.mark.parametrize("path,model,payload", CASES)
def test_retry_contract_matches_zod_optional_never(path, model, payload):
    assert model(**payload).providerRetryPolicy is None
    assert model(**payload, providerRetryPolicy="never").providerRetryPolicy == "never"
    for invalid in [None, "always", True]:
        with pytest.raises(ValidationError):
            model(**payload, providerRetryPolicy=invalid)


@pytest.mark.asyncio
@pytest.mark.parametrize("path,model,payload", CASES)
@pytest.mark.parametrize("policy,attempts", [("never", 1), (None, 3)])
async def test_legacy_routes_scope_retry_policy_without_leaking_it(path, model, payload, policy, attempts, monkeypatch):
    calls = []

    @retry(retry=retry_if_exception(should_retry_provider), stop=stop_after_attempt(3), wait=wait_none(), reraise=True)
    async def failing_provider(*args, **kwargs):
        calls.append((args, kwargs))
        assert "providerRetryPolicy" not in kwargs
        raise httpx.ReadTimeout("fixture paid request timed out")

    class Provider:
        scrape_website = staticmethod(failing_provider)
        analyze_assets = staticmethod(failing_provider)
        describe_asset = staticmethod(failing_provider)
        summarize = staticmethod(failing_provider)
        parse_manual = staticmethod(failing_provider)
        edit = staticmethod(failing_provider)

    async def fake_pdf(*args, **kwargs):
        return "fixture brand manual", [], 1, []

    monkeypatch.setattr(main, "_fetch_pdf_manual", fake_pdf)
    main.app.dependency_overrides[resolve_vlm_provider] = lambda: Provider()
    main.app.dependency_overrides[resolve_image_provider] = lambda: Provider()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False), base_url="http://test") as client:
            response = await client.post(path, json={**payload, **({"providerRetryPolicy": policy} if policy else {})})
        assert response.status_code >= 400
        assert len(calls) == attempts
        assert should_retry_provider(ValueError("outside request")) is True
    finally:
        main.app.dependency_overrides.pop(resolve_vlm_provider, None)
        main.app.dependency_overrides.pop(resolve_image_provider, None)
