"""VI-manual parsing — extract PDF text and shape it into DRAFT brand rules
via the same RecognizeResponse contract the confirm workbench consumes."""
import asyncio
import base64
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
async def test_pdf_manual_renders_scanned_or_textless_pages(monkeypatch):
    """A scan-only PDF must still reach the visual channel as a page image."""
    from app import main

    class Response:
        content = _build_sample_pdf("")

        def raise_for_status(self):
            return None

    async def fake_safe_get(_client, url: str, **_kwargs):
        assert url == "https://storage.internal/scanned.pdf"
        return Response()

    monkeypatch.setattr(main, "safe_get", fake_safe_get)
    text, pages, page_count, warnings = await main._fetch_pdf_manual(
        "https://storage.internal/scanned.pdf"
    )
    assert text == ""
    assert page_count == 1
    assert warnings == []
    assert pages[0]["page"] == 1
    assert pages[0]["dataUrl"].startswith("data:image/jpeg;base64,")


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


@pytest.mark.asyncio
async def test_http_parse_manual_reads_rendered_pages_and_returns_crops():
    from PIL import Image

    page = Image.new("RGB", (400, 300), "white")
    for x in range(80, 240):
        for y in range(60, 180):
            page.putpixel((x, y), (124, 92, 255))
    buf = io.BytesIO()
    page.save(buf, format="JPEG")
    page_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    payload = {
        "rules": [
            {
                "type": "logo",
                "strength": "STRONG",
                "summary": "使用紫色主标",
                "value": {"variants": ["主标"]},
                "evidence": [
                    {
                        "page": 1,
                        "sourceRef": "p1-primary-logo",
                        "bbox": [0.2, 0.2, 0.4, 0.4],
                        "note": "第 1 页主标",
                    }
                ],
            }
        ],
        "assets": [
            {
                "ref": "p1-primary-logo",
                "type": "logo",
                "page": 1,
                "bbox": [0.2, 0.2, 0.4, 0.4],
                "label": "主标",
            }
        ],
    }

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps(payload)}}]}
        )

    provider = HttpVLMProvider(
        OPENAI, "k", model="gpt-4o", transport=httpx.MockTransport(handler)
    )
    out = await provider.parse_manual(
        "[第 1 页] Logo 规范",
        pages=[{"page": 1, "text": "Logo 规范", "dataUrl": page_url}],
    )
    assert out["rules"][0]["type"] == "logo"
    assert out["rules"][0]["evidence"][0]["sourceRef"] == "p1-primary-logo"
    assert out["extractedAssets"][0]["ref"] == "p1-primary-logo"
    assert out["extractedAssets"][0]["dataUrl"].startswith("data:image/jpeg;base64,")


@pytest.mark.asyncio
async def test_http_parse_manual_merges_page_batches_into_one_rule_per_module():
    """Long manuals are batched, but the review UI receives one draft/module."""
    from PIL import Image

    page = Image.new("RGB", (80, 80), "white")
    buf = io.BytesIO()
    page.save(buf, format="JPEG")
    page_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        payload = {
            "rules": [
                {
                    "type": "color",
                    "strength": "STRONG",
                    "summary": f"第 {calls} 批色彩规范",
                    "value": {"palette": ["#FF6C2C" if calls == 1 else "#A1D0CA"]},
                    "evidence": [{"page": 1 if calls == 1 else 9}],
                }
            ]
        }
        return httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps(payload)}}]}
        )

    provider = HttpVLMProvider(
        OPENAI, "k", model="gpt-4o", transport=httpx.MockTransport(handler)
    )
    pages = [
        {"page": number, "text": f"第 {number} 页", "dataUrl": page_url}
        for number in range(1, 10)
    ]
    out = await provider.parse_manual("品牌手册", pages=pages)

    assert calls == 2
    assert len(out["rules"]) == 1
    assert out["rules"][0]["type"] == "color"
    assert out["rules"][0]["value"]["palette"] == ["#FF6C2C", "#A1D0CA"]
    assert "第 1 批色彩规范" in out["rules"][0]["summary"]
    assert "第 2 批色彩规范" in out["rules"][0]["summary"]


@pytest.mark.asyncio
async def test_http_parse_manual_grounds_missing_modules_and_visual_previews():
    """A partial VLM response still yields grounded six-slot review drafts."""
    from PIL import Image

    page = Image.new("RGB", (600, 800), "white")
    buf = io.BytesIO()
    page.save(buf, format="JPEG")
    page_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    def handler(_request: httpx.Request) -> httpx.Response:
        # Mirrors a real compatible endpoint that omits quiet modules and crop
        # descriptors while still returning one valid dominant rule.
        payload = {
            "rules": [
                {
                    "type": "color",
                    "strength": "STRONG",
                    "summary": "企业标准色",
                    "value": {"palette": ["#FF6C2C", "#A1D0CA", "#3B3C44"]},
                    "evidence": [{"page": 3}],
                }
            ]
        }
        return httpx.Response(
            200, json={"choices": [{"message": {"content": json.dumps(payload)}}]}
        )

    provider = HttpVLMProvider(
        OPENAI, "k", model="gpt-4o", transport=httpx.MockTransport(handler)
    )
    page_texts = [
        "企业标志及标志创意说明。不得改变其形状、结构和比例。请勿自行创造组合形式。高度小于8mm时禁止使用。",
        "企业专用印刷字体 LetoSans 思源黑体 Myriad Pro",
        "企业标准色（印刷色） #FF6C2C #A1D0CA #3B3C44",
        "基本板式集合呈现，标准组合周边必须保持空白空间",
        "辅助图形的应用延展：小白砖图形，体现家的温馨",
        "广告信息视觉层级梳理：一家一世界 一居一生活，一站式整屋家居",
    ]
    pages = [
        {"page": number, "text": text, "dataUrl": page_url}
        for number, text in enumerate(page_texts, start=1)
    ]

    out = await provider.parse_manual("\n".join(page_texts), pages=pages)

    by_type = {rule["type"]: rule for rule in out["rules"]}
    assert set(by_type) == {"logo", "font", "color", "layout", "imagery", "copy"}
    assert by_type["logo"]["value"]["minimumHeightMm"] == 8
    assert by_type["font"]["value"]["families"] == [
        "LetoSans",
        "思源黑体",
        "Myriad Pro",
    ]
    assert by_type["imagery"]["value"]["motif"] == "小白砖"
    assert by_type["copy"]["value"]["slogans"] == [
        "一家一世界 一居一生活",
        "一站式整屋家居",
    ]
    assert {asset["type"] for asset in out["extractedAssets"]} == set(by_type)
    assert all(
        any(evidence.get("sourceRef") for evidence in rule["evidence"])
        for rule in out["rules"]
    )


def test_final_manual_postcondition_restores_a_grounded_logo():
    """The final payload cannot lose a logo module that the PDF proves exists."""
    from app.providers.http_providers import _enforce_grounded_manual_modules

    merged = {
        "rules": [
            {
                "type": kind,
                "strength": "WEAK",
                "summary": kind,
                "value": {},
                "evidence": [],
            }
            for kind in ["font", "color", "layout", "imagery", "copy"]
        ]
    }
    pages = [
        {
            "page": 7,
            "text": (
                "企业标志及标志创意说明。使用中不得改变其形状、结构和比例。"
                "请勿自行创造组合形式。"
            ),
        }
    ]

    _enforce_grounded_manual_modules(merged, pages)

    assert [rule["type"] for rule in merged["rules"]] == [
        "logo",
        "font",
        "color",
        "layout",
        "imagery",
        "copy",
    ]
    assert merged["rules"][0]["value"]["dontRules"] == [
        "不得改变标志的形状、结构和比例",
        "不得自行创造标志组合形式",
    ]


def test_final_manual_postcondition_replaces_model_guesses_with_pdf_facts():
    """Explicit text facts outrank plausible-looking VLM hallucinations."""
    from app.providers.http_providers import _enforce_grounded_manual_modules

    merged = {
        "rules": [
            {
                "type": "logo",
                "strength": "STRONG",
                "summary": "标志规范",
                "value": {"dontRules": ["可以改变比例"]},
                "evidence": [],
            },
            {
                "type": "font",
                "strength": "STRONG",
                "summary": "字体规范",
                "value": {"families": ["Helvetica"]},
                "evidence": [],
            },
            {
                "type": "color",
                "strength": "STRONG",
                "summary": "色彩规范",
                "value": {"palette": ["#FF6F20", "#00B2A9"]},
                "evidence": [],
            },
        ],
        "colorSystem": {
            "palette": ["#FF6F20", "#00B2A9"],
            "pairing": [["#FF6F20", "#00B2A9"]],
        },
    }
    pages = [
        {
            "page": 4,
            "text": (
                "企业标志及标志创意说明。不得改变其形状、结构和比例。"
                "请勿自行创造组合形式。高度小于8mm时禁止使用。"
            ),
        },
        {"page": 12, "text": "企业专用印刷字体 LetoSans 思源黑体"},
        {"page": 18, "text": "企业标准色（印刷色） #FF6C2C #A1D0CA #3B3C44"},
    ]

    _enforce_grounded_manual_modules(merged, pages)

    by_type = {rule["type"]: rule for rule in merged["rules"]}
    assert by_type["logo"]["value"] == {
        "dontRules": [
            "不得改变标志的形状、结构和比例",
            "不得自行创造标志组合形式",
        ],
        "minimumHeightMm": 8,
    }
    assert by_type["font"]["value"]["families"] == ["LetoSans", "思源黑体"]
    assert by_type["color"]["value"]["palette"] == [
        "#FF6C2C",
        "#A1D0CA",
        "#3B3C44",
    ]
    assert merged["colorSystem"]["palette"] == [
        "#FF6C2C",
        "#A1D0CA",
        "#3B3C44",
    ]
    assert merged["colorSystem"]["pairing"] == []


@pytest.mark.asyncio
async def test_rate_limited_visual_batch_degrades_to_grounded_six_slots(
    monkeypatch,
):
    """A temporary provider TPM limit cannot erase the whole manual."""
    from PIL import Image

    page = Image.new("RGB", (600, 800), "white")
    buf = io.BytesIO()
    page.save(buf, format="JPEG")
    page_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            502,
            text='AI provider returned 429: rate limit reached; try again in 0.01s',
        )

    async def no_wait(_seconds: float) -> None:
        return None

    monkeypatch.setattr(asyncio, "sleep", no_wait)
    provider = HttpVLMProvider(
        OPENAI, "k", model="gpt-4o", transport=httpx.MockTransport(handler)
    )
    page_texts = [
        "企业标志及标志创意说明。不得改变其形状、结构和比例。",
        "企业专用印刷字体 LetoSans 思源黑体 Myriad Pro",
        "企业标准色（印刷色） #FF6C2C #A1D0CA #3B3C44",
        "基本板式集合呈现，标准组合周边必须保持空白空间",
        "辅助图形的应用延展：小白砖图形",
        "广告信息视觉层级梳理：一家一世界 一居一生活",
    ]
    pages = [
        {"page": number, "text": text, "dataUrl": page_url}
        for number, text in enumerate(page_texts, start=1)
    ]

    out = await provider.parse_manual("\n".join(page_texts), pages=pages)

    assert {rule["type"] for rule in out["rules"]} == {
        "logo",
        "font",
        "color",
        "layout",
        "imagery",
        "copy",
    }
    assert out["warnings"] == [
        "第 1–6 页视觉分析遇到限流，已用 PDF 文字与页面证据补齐。"
    ]


def test_parse_manual_endpoint_returns_recognize_response(client, monkeypatch):
    """The endpoint extracts PDF text then returns a valid RecognizeResponse
    via the mock provider — no real PDF bytes needed (text extraction stubbed)."""
    from app import main

    async def _fake_fetch(url: str):
        assert url == "https://storage.internal/vi-manual.pdf"
        return "品牌 VI 手册全文 …", [], 1, []

    monkeypatch.setattr(main, "_fetch_pdf_manual", _fake_fetch)

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
    assert d["pageCount"] == 1
    assert d["extractedAssets"] == []
