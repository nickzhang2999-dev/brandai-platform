import asyncio
import json

import httpx
import pytest
from app.delivery_timing import ImageTimingScope, image_http_client


@pytest.mark.asyncio
async def test_trace_is_scoped_and_does_not_log_content(monkeypatch, capsys):
    monkeypatch.setenv("DF_STUDIO_DELIVERY_TRACE", "1")
    ids = ["sgr_" + c * 32 for c in "ab"]
    calls = []

    async def endpoint(scope, receive, send):
        async def remote(req):
            calls.append(1)
            await asyncio.sleep(0)
            return httpx.Response(429)
        async with image_http_client(transport=httpx.MockTransport(remote)) as client:
            await client.post("https://unused.invalid/private-path", json={"prompt": "private"})
    middleware = ImageTimingScope(endpoint)
    async def run(ident):
        await middleware({"type": "http", "path": "/v1/generate", "headers": [
            (b"x-novart-request-id", ident.encode())]}, None, None)
    await asyncio.gather(*(run(i) for i in [*ids, "ignored"]))
    lines = capsys.readouterr().out.splitlines()
    rows = [json.loads(line.split("] ", 1)[1]) for line in lines]
    assert len(calls) == 3 and len(rows) == 4
    for ident in ids:
        pair = [r for r in rows if r["requestId"] == ident]
        assert [r["stage"] for r in pair] == ["provider_http_start", "provider_http_return"]
        assert pair[-1]["status"] == 429 and pair[-1]["durationMs"] >= 0
    assert "private" not in "".join(lines)
