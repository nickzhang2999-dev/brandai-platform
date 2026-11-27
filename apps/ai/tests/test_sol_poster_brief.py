"""Exercise the complete text route without sending any material off the machine."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.providers import resolve_vlm_provider
from app.providers.http_providers import HttpVLMProvider


@pytest.mark.parametrize("fault", ["none", "wrong_product", "tool", "truncated", "extra_copy", "rate_limit"])
def test_selected_product_and_single_attempt(monkeypatch, fault):
    calls = []
    payload = {
        "product": "台灯.png", "brand": "本地灯具", "goal": "上新", "audience": "",
        "approvedCopy": "圆形底座", "visualRequirements": "保留深蓝色",
        "rules": ["使用白色标识"], "providerRetryPolicy": "never",
    }

    def upstream(request):
        wire = json.loads(request.content)
        calls.append(request.url.path)
        assert wire["max_tokens"] == 320
        assert "tools" not in wire
        parts = wire["messages"][1]["content"]
        assert len(parts) == 1 and parts[0]["type"] == "text"
        facts = json.loads(parts[0]["text"])
        ref = facts.pop("productRef")
        assert facts == {k: v for k, v in payload.items() if k != "providerRetryPolicy"}
        if fault == "rate_limit":
            return httpx.Response(429)
        reply = {"productRef": "another" if fault == "wrong_product" else ref,
                 "appearance": "轮廓留白", "scene": "陈列台", "detail": "局部放大"}
        if fault == "extra_copy":
            reply["copy"] = "未经确认的功能"
        msg = {"content": json.dumps(reply)}
        if fault == "tool":
            msg["tool_calls"] = [{"id": "irrelevant"}]
        return httpx.Response(200, json={
            "choices": [{"message": msg, "finish_reason": "length" if fault == "truncated" else "stop"}],
            "usage": {"total_tokens": 28},
        })

    provider = HttpVLMProvider("https://fixture.invalid/v1", "local-only", model="text-fixture",
                               transport=httpx.MockTransport(upstream))
    monkeypatch.setitem(app.dependency_overrides, resolve_vlm_provider, lambda: provider)
    response = TestClient(app).post("/v1/studio/sol-poster-brief", json=payload)
    assert calls == ["/v1/chat/completions"]
    if fault == "none":
        assert response.status_code == 200
        assert response.json() == {"choices": {"appearance": "轮廓留白", "scene": "陈列台", "detail": "局部放大"},
                                   "model": "text-fixture", "totalTokens": 28}
    else:
        assert response.status_code == 502
        assert "choices" not in response.json()
