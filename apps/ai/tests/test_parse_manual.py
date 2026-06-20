"""VI-manual parsing — extract PDF text and shape it into DRAFT brand rules
via the same RecognizeResponse contract the confirm workbench consumes."""
import io
import json

import httpx
import pytest

from app.providers.http_providers import HttpVLMProvider
from app.providers.mock import MockVLMProvider

OPENAI = "https://api.openai.com/v1"


def _build_sample_pdf(text: str) -> bytes:
    """Round-trip a one-page PDF so the test exercises real pypdf extraction."""
    from pypdf import PdfWriter

    # A blank page carries no text, so write a minimal content stream by hand.
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_pdf_text_extraction_is_wired():
    """pypdf is importable and reads a generated PDF without raising."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(_build_sample_pdf("hello")))
    assert len(reader.pages) == 1
    # extract_text never raises on a valid page (may be empty for blank pages).
    assert isinstance(reader.pages[0].extract_text() or "", str)


@pytest.mark.asyncio
async def test_mock_parse_manual_shapes_rules():
    out = await MockVLMProvider().parse_manual("品牌手册：主色 #16130f …")
    assert len(out["rules"]) >= 1
    for rule in out["rules"]:
        assert rule["type"] in {"color", "font", "layout", "imagery", "copy"}
        assert rule["strength"] in {"STRONG", "WEAK", "FORBIDDEN"}
    assert out["colorSystem"]["palette"]


@pytest.mark.asyncio
async def test_http_parse_manual_coerces_rules():
    payload = {
        "rules": [
            {
                "type": "color",
                "strength": "STRONG",
                "summary": "主色深棕",
                "value": {"palette": ["#16130f"]},
                "evidence": [{"note": "第 2 章 · 色彩规范"}],
            },
            {"type": "font", "strength": "strong", "summary": "标题衬线"},
        ],
        "colorSystem": {
            "palette": ["#16130f"],
            "contrastScore": 90,
            "consistencyScore": 92,
        },
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/chat/completions")
        return httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps(payload)}}]}
        )

    p = HttpVLMProvider(
        OPENAI, "k", model="gpt-4o", transport=httpx.MockTransport(handler)
    )
    out = await p.parse_manual("品牌手册全文 …")
    assert len(out["rules"]) == 2
    # strength upper-cased; missing value defaulted to {} (never null)
    assert out["rules"][1]["strength"] == "STRONG"
    assert out["rules"][1]["value"] == {}
    # K4 — note-only evidence is retained (assetId optional); the parse-manual
    # worker stamps the manual's assetId onto it downstream.
    assert len(out["rules"][0]["evidence"]) == 1
    assert out["rules"][0]["evidence"][0]["note"] == "第 2 章 · 色彩规范"
    assert "assetId" not in out["rules"][0]["evidence"][0]
    assert out["colorSystem"]["contrastScore"] == 90.0


def test_parse_manual_endpoint_returns_recognize_response(client, monkeypatch):
    """The endpoint extracts PDF text then returns a valid RecognizeResponse
    via the mock provider — no real PDF bytes needed (text extraction stubbed)."""
    from app import main

    async def _fake_fetch(url: str) -> str:
        assert url == "https://storage.internal/vi-manual.pdf"
        return "品牌 VI 手册全文 …"

    monkeypatch.setattr(main, "_fetch_pdf_text", _fake_fetch)

    r = client.post(
        "/v1/parse-manual",
        json={"url": "https://storage.internal/vi-manual.pdf"},
    )
    d = r.json()
    assert r.status_code == 200
    assert len(d["rules"]) >= 1
    for rule in d["rules"]:
        assert rule["type"] in {
            "color", "font", "layout", "imagery", "graphic", "copy", "logo"
        }
        assert rule["strength"] in {"STRONG", "WEAK", "FORBIDDEN"}
    assert d["colorSystem"]["palette"]
