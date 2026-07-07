"""Provider adapter registry must degrade to mock with zero keys —
the P0 'runs with no API key' guarantee."""
import base64
import io
import json

import httpx
import pytest
from PIL import Image

from app.providers.http_providers import (
    HttpImageProvider,
    HttpVLMProvider,
    _build_inpaint_mask,
    _coerce_describe,
    _coerce_ingest,
    _coerce_recognize,
    _estimate_cost_usd,
    _extract_image_refs,
    _extract_site_style,
    _loads_json_lenient,
    _parse_html,
    _provider_kind,
)
from app.providers.mock import MockImageProvider, MockVLMProvider
from app.providers.registry import (
    get_image_provider,
    get_vlm_provider,
    resolve_image_provider,
    resolve_vlm_provider,
)


def test_registry_falls_back_to_mock_without_keys():
    get_image_provider.cache_clear()
    get_vlm_provider.cache_clear()
    assert isinstance(get_image_provider(), MockImageProvider)
    assert isinstance(get_vlm_provider(), MockVLMProvider)


def test_image_provider_named_but_keyless_still_mock(monkeypatch):
    from app import config

    monkeypatch.setattr(config.settings, "image_provider", "openai")
    monkeypatch.setattr(config.settings, "image_api_key", "")
    get_image_provider.cache_clear()
    assert isinstance(get_image_provider(), MockImageProvider)
    get_image_provider.cache_clear()


# --- M-C: HTTP image provider translation, response handling, cost log ---

OPENAI = "https://api.openai.com/v1"


def test_provider_kind_detection():
    assert _provider_kind(OPENAI) == "openai"
    assert _provider_kind("https://generativelanguage.googleapis.com/v1beta") == "gemini"
    assert _provider_kind("https://ark.cn-beijing.volces.com/api/v3") == "seeddream"
    assert _provider_kind("https://example.com/v1") == "generic"


def test_build_body_openai_translation():
    p = HttpImageProvider(OPENAI, "k")
    body = p._build_body(
        "a cup",
        1024,
        1024,
        2,
        ["red", "blur"],
        {"model": "gpt-image-1", "response_format": "url", "seed": 7, "cfg": 5},
    )
    assert body["size"] == "1024x1024"
    assert body["n"] == 2
    assert body["model"] == "gpt-image-1"
    assert body["response_format"] == "url"
    # OpenAI 的 gpt-image-* 严格校验,对未知字段 400。代码因此:把 negative 折进
    # prompt 的 "Avoid:" 子句、且不带 negative_prompt / seed / cfg / aspect_ratio
    # （与线上真实出图一致;这些仅对 SD 风格网关有意义）。
    assert "negative_prompt" not in body
    assert body["prompt"] == "a cup\n\nAvoid: red; blur"
    assert "seed" not in body and "cfg" not in body and "aspect_ratio" not in body


def test_extract_refs_url_and_b64():
    assert _extract_image_refs({"data": [{"url": "http://x/y.png"}]}) == ["http://x/y.png"]
    refs = _extract_image_refs({"data": [{"b64_json": "QUJD"}]})
    assert refs == ["data:image/png;base64,QUJD"]
    assert _extract_image_refs({"data": []}) == []


def test_estimate_cost():
    assert _estimate_cost_usd("openai", "1024x1024", "medium", 2) == pytest.approx(0.084)
    assert _estimate_cost_usd("openai", "1024x1024", "low", 1) == pytest.approx(0.011)
    assert _estimate_cost_usd("openai", "1536x1024", "high", 1) == pytest.approx(0.25)
    assert _estimate_cost_usd("openai", "999x999", "medium", 1) is None
    assert _estimate_cost_usd("generic", "1024x1024", "medium", 1) is None


@pytest.mark.asyncio
async def test_generate_returns_url(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/images/generations")
        return httpx.Response(200, json={"data": [{"url": "http://img/a.png"}]})

    p = HttpImageProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    out = await p.generate("x", width=1024, height=1024, n=1)
    assert out == ["http://img/a.png"]


@pytest.mark.asyncio
async def test_generate_b64_becomes_data_url():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    p = HttpImageProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    out = await p.generate("x", width=1024, height=1024, n=1)
    assert out == ["data:image/png;base64,QUJD"]


# --- 局部重画 (INPAINT) 蒙版归一 + multipart 透传到 /images/edits ---


def _png_data_uri(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def test_build_inpaint_mask_makes_painted_area_transparent():
    # 底图 8x4；前端黑白蒙版 4x2(故意不同尺寸)：左半白=重绘、右半黑=保留。
    base_uri = _png_data_uri(Image.new("RGB", (8, 4), (120, 120, 120)))
    base_bytes = base64.b64decode(base_uri.split(",", 1)[1])
    mask = Image.new("L", (4, 2), 0)
    for y in range(2):
        for x in range(2):  # 左半涂白
            mask.putpixel((x, y), 255)
    out = _build_inpaint_mask(base_bytes, _png_data_uri(mask))
    res = Image.open(io.BytesIO(out))
    assert res.mode == "RGBA"
    assert res.size == (8, 4)  # 缩放到底图真实像素尺寸
    # 左侧(重绘) → alpha 0(透明,被编辑)；右侧(保留) → alpha 255。
    assert res.getpixel((1, 1))[3] == 0
    assert res.getpixel((6, 1))[3] == 255


def test_build_inpaint_mask_accepts_bare_base64():
    base_uri = _png_data_uri(Image.new("RGB", (4, 4), (0, 0, 0)))
    base_bytes = base64.b64decode(base_uri.split(",", 1)[1])
    bare = _png_data_uri(Image.new("L", (4, 4), 255)).split(",", 1)[1]
    out = _build_inpaint_mask(base_bytes, bare)  # 裸 base64(无 data: 前缀)
    res = Image.open(io.BytesIO(out))
    assert res.getpixel((1, 1))[3] == 0  # 全白 → 全透明


@pytest.mark.asyncio
async def test_edit_sends_mask_part_when_present():
    seen: dict[str, bool] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/images/edits")
        body = request.content
        seen["mask"] = b'name="mask"' in body
        seen["image"] = b'name="image"' in body
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    base_uri = _png_data_uri(Image.new("RGB", (16, 16), (200, 180, 160)))
    mask_uri = _png_data_uri(Image.new("L", (16, 16), 255))
    p = HttpImageProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    out = await p.edit(base_uri, "INPAINT", {"prompt": "纯色米白", "mask": mask_uri})
    assert out == "data:image/png;base64,QUJD"
    assert seen == {"mask": True, "image": True}


@pytest.mark.asyncio
async def test_edit_without_mask_sends_no_mask_part():
    seen: dict[str, bool] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["mask"] = b'name="mask"' in request.content
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    base_uri = _png_data_uri(Image.new("RGB", (16, 16), (10, 10, 10)))
    p = HttpImageProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    await p.edit(base_uri, "REPLACE_BACKGROUND", {"prompt": "换背景"})
    assert seen == {"mask": False}


# --- STRICT 参考图 → 图生图：像素经 multipart 送进 /images/edits ---


@pytest.mark.asyncio
async def test_generate_with_references_posts_images_to_edits():
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/images/edits")
        body = request.content
        # Two STRICT refs → two repeated `image[]` multipart parts + the prompt.
        seen["image_parts"] = body.count(b'name="image[]"')
        seen["has_prompt"] = b'name="prompt"' in body
        seen["size"] = b"1536x1024" in body  # wide target snaps here
        return httpx.Response(200, json={"data": [{"url": "http://img/out.png"}]})

    ref_a = _png_data_uri(Image.new("RGB", (8, 8), (10, 20, 30)))
    ref_b = _png_data_uri(Image.new("RGB", (8, 8), (40, 50, 60)))
    p = HttpImageProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    out = await p.generate_with_references(
        "compose a poster around the locked logo",
        [{"url": ref_a}, {"url": ref_b}],
        width=1920,
        height=1080,
        n=1,
    )
    assert out == ["http://img/out.png"]
    assert seen == {"image_parts": 2, "has_prompt": True, "size": True}


@pytest.mark.asyncio
async def test_generate_with_references_honors_website_ssrf_policy(monkeypatch):
    """K7 — a WEBSITE-sourced STRICT ref is fetched with the strict initial-host
    check (allow_private_initial=False); UPLOAD keeps the trusting default. This
    guards the new img2img fetch against DNS-rebinding to private services."""
    calls: list[tuple[str, bool]] = []

    async def fake_load(self, url, *, allow_private_initial=True):
        calls.append((url, allow_private_initial))
        return b"\x89PNG-bytes"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"url": "http://img/out.png"}]})

    monkeypatch.setattr(HttpImageProvider, "_load_image_bytes", fake_load)
    p = HttpImageProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    await p.generate_with_references(
        "poster",
        [
            {"url": "https://cdn.example.com/logo.png", "sourceHint": "UPLOAD"},
            {"url": "https://evil.example.com/x.png", "sourceHint": "WEBSITE"},
        ],
        width=1024,
        height=1024,
        n=1,
    )
    assert ("https://cdn.example.com/logo.png", True) in calls
    assert ("https://evil.example.com/x.png", False) in calls


# --- env-default model injection (gateways like OpenRouter require a model) ---


def test_image_model_from_config_injected():
    p = HttpImageProvider(OPENAI, "k", model="gpt-image-1")
    body = p._build_body("a cup", 1024, 1024, 1, None, None)
    assert body["model"] == "gpt-image-1"


def test_image_per_request_model_overrides_config():
    p = HttpImageProvider(OPENAI, "k", model="gpt-image-1")
    body = p._build_body("a cup", 1024, 1024, 1, None, {"model": "dall-e-3"})
    assert body["model"] == "dall-e-3"


def test_image_no_model_when_unset():
    p = HttpImageProvider(OPENAI, "k")
    body = p._build_body("a cup", 1024, 1024, 1, None, None)
    assert "model" not in body


# --- lenient JSON parsing of model output ---


def test_loads_json_lenient_handles_fences_and_prose():
    assert _loads_json_lenient('{"a":1}') == {"a": 1}
    assert _loads_json_lenient('```json\n{"a":1}\n```') == {"a": 1}
    assert _loads_json_lenient('sure!\n{"a":1}\nhope that helps') == {"a": 1}
    assert _loads_json_lenient("not json at all") == {}
    assert _loads_json_lenient("") == {}


# --- coercion guarantees the contract shape regardless of model sloppiness ---


def test_coerce_recognize_no_evidence_stays_empty():
    # Never fabricate/backfill an assetId — no evidence means evidence == [].
    out = _coerce_recognize(
        {"rules": [{"type": "color", "strength": "strong", "summary": "s"}]},
        ["asset-1"],
    )
    rule = out["rules"][0]
    assert rule["strength"] == "STRONG"  # upper-cased
    assert rule["value"] == {}  # missing → empty dict, never null
    assert rule["evidence"] == []  # no backfill, contract default
    assert "colorSystem" not in out  # omitted when no palette → no null leak


def test_coerce_recognize_keeps_note_only_evidence():
    # A VLM observation with no assetId is retained as note-only, not dropped.
    out = _coerce_recognize(
        {
            "rules": [
                {
                    "type": "imagery",
                    "summary": "s",
                    "evidence": [{"note": "global observation"}],
                }
            ]
        },
        ["asset-1"],
    )
    assert out["rules"][0]["evidence"] == [{"note": "global observation"}]


def test_coerce_recognize_strips_foreign_asset_id():
    # A hallucinated/foreign assetId is dropped (degraded to note-only); a valid
    # requested id is kept; an empty item (no id/note/bbox) is dropped.
    out = _coerce_recognize(
        {
            "rules": [
                {
                    "type": "logo",
                    "summary": "s",
                    "evidence": [
                        {"assetId": "ghost-99", "note": "made up"},
                        {"assetId": "asset-1", "note": "real"},
                        {"assetId": "ghost-2"},  # no note → dropped entirely
                    ],
                }
            ]
        },
        ["asset-1"],
    )
    assert out["rules"][0]["evidence"] == [
        {"note": "made up"},  # foreign id stripped, note kept
        {"assetId": "asset-1", "note": "real"},
    ]


def test_coerce_recognize_keeps_color_system():
    out = _coerce_recognize(
        {
            "rules": [],
            "colorSystem": {
                "palette": ["#000"],
                "contrastScore": 90,
                "consistencyScore": 88,
            },
        },
        [],
    )
    assert out["colorSystem"]["palette"] == ["#000"]
    assert out["colorSystem"]["contrastScore"] == 90.0
    assert out["colorSystem"]["pairing"] == []  # defaulted, not null


def test_coerce_ingest_falls_back_to_scraped_images():
    out = _coerce_ingest({}, ["http://x/a.png", "http://x/b.png"])
    assert out["images"][0] == {
        "sourceUrl": "http://x/a.png",
        "previewUrl": "http://x/a.png",
    }
    assert out["copies"] == [] and out["sellingPoints"] == []


def test_parse_html_extracts_absolute_images_and_text():
    html = (
        '<html><body><h1>Hello</h1><img src="/logo.png">'
        '<img data-src="https://cdn/x.jpg">'
        '<script>var a=1</script><p>buy now</p></body></html>'
    )
    images, text = _parse_html("https://shop.example.com/p", html)
    assert "https://shop.example.com/logo.png" in images
    assert "https://cdn/x.jpg" in images
    assert "Hello" in text and "buy now" in text
    assert "var a=1" not in text  # script stripped


def test_parse_html_discovers_srcset_og_and_background_images():
    html = (
        '<html><head>'
        '<meta property="og:image" content="https://cdn/og.jpg">'
        '</head><body>'
        '<img srcset="https://cdn/small.jpg 480w, https://cdn/big.jpg 1200w">'
        '<picture><source srcset="https://cdn/hero.webp"></picture>'
        '<div style="background-image:url(\'/bg/banner.jpg\')"></div>'
        '<style>.h{background-image:url(https://cdn/css-hero.png)}</style>'
        '</body></html>'
    )
    images, _ = _parse_html("https://shop.example.com/p", html)
    for expected in (
        "https://cdn/og.jpg",
        "https://cdn/small.jpg",
        "https://cdn/big.jpg",
        "https://cdn/hero.webp",
        "https://shop.example.com/bg/banner.jpg",
        "https://cdn/css-hero.png",
    ):
        assert expected in images, expected


def test_extract_site_style_reads_palette_fonts_logo_name():
    html = (
        '<html><head>'
        '<title>Acme Coffee</title>'
        '<meta property="og:site_name" content="Acme">'
        '<meta name="theme-color" content="#16130f">'
        '<link rel="apple-touch-icon" href="/icon.png">'
        '<link rel="stylesheet" '
        'href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Inter">'
        '<style>'
        ':root{--brand:#b9986a}'
        'h1{color:#16130f;font-family:"Playfair Display",serif}'
        'body{font-family:Inter, sans-serif;background:#ffffff}'
        '.cta{background:rgb(185,152,106)}'
        '</style>'
        '</head><body><h1>Acme</h1></body></html>'
    )
    style = _extract_site_style("https://acme.example.com", html)
    # brand colors kept; pure white dropped as noise
    assert "#16130f" in style["palette"]
    assert "#b9986a" in style["palette"]
    assert "#ffffff" not in style["palette"]
    # real typefaces kept; generic families dropped
    assert "Playfair Display" in style["fonts"]
    assert "Inter" in style["fonts"]
    assert "serif" not in [f.lower() for f in style["fonts"]]
    assert style["themeColor"] == "#16130f"
    assert style["logoUrl"] == "https://acme.example.com/icon.png"
    assert style["siteName"] == "Acme"


@pytest.mark.asyncio
async def test_scrape_website_attaches_site_style():
    page = (
        '<html><head><title>Brand</title>'
        '<meta name="theme-color" content="#0a7d55">'
        '<style>h1{color:#0a7d55;font-family:"Lora",serif}</style>'
        '</head><body><img src="https://cdn/p.jpg"></body></html>'
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            body = json.dumps({"images": [], "copies": [], "sellingPoints": []})
            return httpx.Response(200, json={"choices": [{"message": {"content": body}}]})
        return httpx.Response(200, text=page, headers={"content-type": "text/html"})

    p = HttpVLMProvider(OPENAI, "k", model="gpt-4o", transport=httpx.MockTransport(handler))
    out = await p.scrape_website("https://brand.example.com")
    assert out["siteStyle"]["themeColor"] == "#0a7d55"
    assert "Lora" in out["siteStyle"]["fonts"]
    # model returned no images → falls back to the scraped <img>
    assert any(i["sourceUrl"] == "https://cdn/p.jpg" for i in out["images"])


# --- VLM provider end-to-end over a mocked OpenAI-compatible chat API ---


def _vlm_handler(chat_payload: dict):
    """MockTransport handler: image GETs return bytes, chat POSTs return JSON."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            content = json.dumps(chat_payload)
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": content}}]},
            )
        # an image fetch for inlining
        return httpx.Response(
            200, content=b"\x89PNG", headers={"content-type": "image/png"}
        )

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_vlm_analyze_assets_shapes_rules():
    payload = {
        "rules": [
            {
                "type": "color",
                "strength": "STRONG",
                "summary": "主色深棕",
                "value": {"palette": ["#16130f"]},
                "evidence": [{"assetId": "a1", "note": "logo"}],
            },
            {"type": "font", "strength": "weak", "summary": "衬线标题"},
        ],
        "colorSystem": {
            "palette": ["#16130f"],
            "contrastScore": 92,
            "consistencyScore": 90,
        },
    }
    p = HttpVLMProvider(OPENAI, "k", model="gpt-4o", transport=_vlm_handler(payload))
    out = await p.analyze_assets([{"id": "a1", "url": "http://s/a1.png"}])
    assert len(out["rules"]) == 2
    # K4 — model-supplied evidence is preserved; the requested asset id is kept.
    assert out["rules"][0]["evidence"][0]["assetId"] == "a1"
    # No fabricated backfill: the font rule had no evidence → stays empty.
    assert out["rules"][1]["evidence"] == []
    assert out["rules"][1]["strength"] == "WEAK"
    assert out["colorSystem"]["contrastScore"] == 92.0


@pytest.mark.asyncio
async def test_vlm_compliance_returns_results_list():
    payload = {
        "results": [
            {"level": "pass", "reason": "Logo 清晰", "category": "BRAND_VISUAL"},
            {"level": "RISK", "reason": "主色偏离"},
        ],
        "score": 73,
    }
    p = HttpVLMProvider(OPENAI, "k", transport=_vlm_handler(payload))
    out = await p.check_visual_compliance("http://s/img.png", [{"summary": "深棕主色"}])
    assert [r["level"] for r in out["results"]] == ["PASS", "RISK"]
    assert out["results"][1]["category"] == "BRAND_VISUAL"  # defaulted
    assert out["score"] == 73


@pytest.mark.asyncio
async def test_vlm_compliance_score_clamps_and_defaults_none():
    # out-of-range floats clamp into 0–100 and round to int
    p = HttpVLMProvider(OPENAI, "k", transport=_vlm_handler({"score": 150.7}))
    out = await p.check_visual_compliance("http://s/img.png", [])
    assert out["score"] == 100
    # absent score => None (preserves the no-null contract)
    p2 = HttpVLMProvider(OPENAI, "k", transport=_vlm_handler({"results": []}))
    out2 = await p2.check_visual_compliance("http://s/img.png", [])
    assert out2["score"] is None


@pytest.mark.asyncio
async def test_vlm_scrape_website_structures_output():
    html = '<html><body><img src="https://cdn/hero.jpg"><p>慢萃</p></body></html>'

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            payload = {
                "images": [
                    {"sourceUrl": "https://cdn/hero.jpg", "guessedCategory": "KV"}
                ],
                "copies": ["每一杯都值得慢下来"],
                "sellingPoints": ["低温慢萃"],
            }
            return httpx.Response(
                200, json={"choices": [{"message": {"content": json.dumps(payload)}}]}
            )
        return httpx.Response(200, text=html)

    p = HttpVLMProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    out = await p.scrape_website("https://shop.example.com")
    assert out["images"][0]["guessedCategory"] == "KV"
    assert out["images"][0]["previewUrl"] == "https://cdn/hero.jpg"  # defaulted
    assert out["copies"] == ["每一杯都值得慢下来"]
    assert out["sellingPoints"] == ["低温慢萃"]


def test_registry_vlm_uses_base_url_override(monkeypatch):
    from app import config

    monkeypatch.setattr(config.settings, "vlm_provider", "openrouter")
    monkeypatch.setattr(config.settings, "vlm_api_key", "sk-x")
    monkeypatch.setattr(config.settings, "vlm_base_url", "https://openrouter.ai/api/v1")
    monkeypatch.setattr(config.settings, "vlm_model", "openai/gpt-4o")
    get_vlm_provider.cache_clear()
    prov = get_vlm_provider()
    assert isinstance(prov, HttpVLMProvider)
    assert prov.base_url == "https://openrouter.ai/api/v1"
    assert prov.model == "openai/gpt-4o"
    get_vlm_provider.cache_clear()


# --- per-request header resolution (web sends provider config as headers) ---


class _Req:
    """Minimal stand-in exposing case-insensitive .headers like Starlette."""

    def __init__(self, headers: dict):
        self.headers = httpx.Headers(headers)


def test_resolve_image_provider_with_base_url_override():
    req = _Req(
        {
            "x-ov-image-provider": "openai",
            "x-ov-image-key": "sk-img",
            "x-ov-image-base-url": "https://gateway.example/v1",
            "x-ov-image-model": "gpt-image-1",
        }
    )
    prov = resolve_image_provider(req)
    assert isinstance(prov, HttpImageProvider)
    assert prov.base_url == "https://gateway.example/v1"
    assert prov.api_key == "sk-img"
    assert prov.model == "gpt-image-1"


def test_resolve_image_provider_uses_endpoint_table_when_no_base_url():
    # Header names are case-insensitive — send mixed/canonical case here.
    req = _Req({"X-OV-Image-Provider": "seeddream", "X-OV-Image-Key": "sk-img"})
    prov = resolve_image_provider(req)
    assert isinstance(prov, HttpImageProvider)
    assert prov.base_url == "https://ark.cn-beijing.volces.com/api/v3"
    assert prov.model == ""


def test_resolve_image_provider_falls_back_to_mock_without_headers():
    get_image_provider.cache_clear()
    assert isinstance(resolve_image_provider(_Req({})), MockImageProvider)
    get_image_provider.cache_clear()


def test_resolve_image_provider_mock_provider_header_falls_back():
    get_image_provider.cache_clear()
    req = _Req({"X-OV-Image-Provider": "mock", "X-OV-Image-Key": "sk-img"})
    assert isinstance(resolve_image_provider(req), MockImageProvider)
    get_image_provider.cache_clear()


def test_resolve_image_provider_empty_key_falls_back():
    get_image_provider.cache_clear()
    req = _Req(
        {"X-OV-Image-Provider": "openai", "X-OV-Image-Key": "",
         "X-OV-Image-Base-Url": "https://gateway.example/v1"}
    )
    assert isinstance(resolve_image_provider(req), MockImageProvider)
    get_image_provider.cache_clear()


# --- provider self-check (.check()) over a mocked /models endpoint ---


@pytest.mark.asyncio
async def test_check_ok_on_2xx():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/models")
        assert request.headers["authorization"] == "Bearer k"
        return httpx.Response(200, json={"data": []})

    p = HttpImageProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    res = await p.check()
    assert res.ok is True
    assert "OK" in res.detail


@pytest.mark.asyncio
async def test_check_reports_status_and_body_on_non_2xx():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"})

    p = HttpVLMProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    res = await p.check()
    assert res.ok is False
    assert res.detail.startswith("401:")


@pytest.mark.asyncio
async def test_check_captures_connection_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("name resolution failed")

    p = HttpImageProvider(OPENAI, "k", transport=httpx.MockTransport(handler))
    res = await p.check()
    assert res.ok is False
    assert "ConnectError" in res.detail


# --- T-conn-a: model-name validation in .check() ---


def _models_handler(ids):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/models")
        return httpx.Response(200, json={"data": [{"id": i} for i in ids]})

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_check_flags_unknown_model():
    p = HttpImageProvider(
        OPENAI, "k", model="gpt-image-9",
        transport=_models_handler(["gpt-image-1", "gpt-4o"]),
    )
    res = await p.check()
    assert res.ok is False
    assert "不存在" in res.detail and "gpt-image-1" in res.detail


@pytest.mark.asyncio
async def test_check_ok_when_model_present():
    p = HttpVLMProvider(
        OPENAI, "k", model="gpt-4o",
        transport=_models_handler(["gpt-image-1", "gpt-4o"]),
    )
    res = await p.check()
    assert res.ok is True and "model=gpt-4o" in res.detail


@pytest.mark.asyncio
async def test_check_model_match_is_lenient_about_namespacing():
    # A bare configured id matches a namespaced gateway id (no false negative).
    p = HttpImageProvider(
        OPENAI, "k", model="gpt-image-1",
        transport=_models_handler(["openai/gpt-image-1"]),
    )
    res = await p.check()
    assert res.ok is True


@pytest.mark.asyncio
async def test_check_skips_model_validation_when_list_unreadable():
    # A gateway whose /models isn't OpenAI-shaped → auth-only check, no false fail.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": ["x"]})

    p = HttpImageProvider(
        OPENAI, "k", model="whatever", transport=httpx.MockTransport(handler)
    )
    res = await p.check()
    assert res.ok is True


@pytest.mark.asyncio
async def test_mock_check_is_ok_with_placeholder_detail():
    img = await MockImageProvider().check()
    vlm = await MockVLMProvider().check()
    assert img.ok is True and "mock" in img.detail
    assert vlm.ok is True and "mock" in vlm.detail


def test_resolve_vlm_provider_with_base_url_override():
    req = _Req(
        {
            "X-OV-Vlm-Provider": "openrouter",
            "X-OV-Vlm-Key": "sk-vlm",
            "X-OV-Vlm-Base-Url": "https://openrouter.ai/api/v1",
            "X-OV-Vlm-Model": "openai/gpt-4o",
        }
    )
    prov = resolve_vlm_provider(req)
    assert isinstance(prov, HttpVLMProvider)
    assert prov.base_url == "https://openrouter.ai/api/v1"
    assert prov.api_key == "sk-vlm"
    assert prov.model == "openai/gpt-4o"


def test_resolve_vlm_provider_uses_endpoint_table_when_no_base_url():
    req = _Req({"X-OV-Vlm-Provider": "gemini", "X-OV-Vlm-Key": "sk-vlm"})
    prov = resolve_vlm_provider(req)
    assert isinstance(prov, HttpVLMProvider)
    # gemini 默认走 Google 文档化的 OpenAI 兼容层(OpenAI 形状客户端可用)。
    assert prov.base_url == "https://generativelanguage.googleapis.com/v1beta/openai"


def test_resolve_vlm_provider_falls_back_to_mock_without_headers():
    get_vlm_provider.cache_clear()
    assert isinstance(resolve_vlm_provider(_Req({})), MockVLMProvider)
    get_vlm_provider.cache_clear()


def test_resolve_vlm_provider_mock_or_empty_key_falls_back():
    get_vlm_provider.cache_clear()
    assert isinstance(
        resolve_vlm_provider(_Req({"X-OV-Vlm-Provider": "mock", "X-OV-Vlm-Key": "k"})),
        MockVLMProvider,
    )
    assert isinstance(
        resolve_vlm_provider(_Req({"X-OV-Vlm-Provider": "openai", "X-OV-Vlm-Key": ""})),
        MockVLMProvider,
    )
    get_vlm_provider.cache_clear()


# --- E9/E10 describe coercion + provider ---


def test_coerce_describe_dedupes_and_coerces():
    out = _coerce_describe(
        {"aiTags": ["产品图", "产品图", " 暖色 ", ""], "aiDescription": " 一段描述 "}
    )
    assert out["aiTags"] == ["产品图", "暖色"]  # de-duped + trimmed, empties dropped
    assert out["aiDescription"] == "一段描述"


def test_coerce_describe_missing_description_is_empty_string():
    # aiDescription is a REQUIRED str on the contract → never null.
    out = _coerce_describe({"aiTags": ["x"]})
    assert out["aiDescription"] == ""


@pytest.mark.asyncio
async def test_vlm_describe_asset_shapes_output():
    payload = {"aiTags": ["瓶身", "暖色调", "瓶身"], "aiDescription": "暖光产品图"}
    p = HttpVLMProvider(OPENAI, "k", model="gpt-4o", transport=_vlm_handler(payload))
    out = await p.describe_asset("http://s/a.png", category="PRODUCT")
    assert out["aiDescription"] == "暖光产品图"
    assert out["aiTags"] == ["瓶身", "暖色调"]  # de-duped


# --- K7: WEBSITE-sourced assets re-validate the INITIAL host (DNS rebinding) ---


@pytest.mark.asyncio
async def test_inline_image_website_source_validates_initial_host(monkeypatch):
    """A WEBSITE-sourced URL must call safe_get with allow_private_initial=False;
    an UPLOAD/None source keeps the trusting allow_private_initial=True."""
    import app.providers.http_providers as hp

    seen: list[bool] = []

    async def fake_safe_get(client, url, *, allow_private_initial=False, **kw):
        seen.append(allow_private_initial)
        return httpx.Response(
            200, content=b"\x89PNG", headers={"content-type": "image/png"}
        )

    monkeypatch.setattr(hp, "safe_get", fake_safe_get)
    p = HttpVLMProvider(OPENAI, "k", model="gpt-4o")

    await p._inline_image("http://evil/x.png", source="WEBSITE")
    await p._inline_image("http://storage/x.png", source="UPLOAD")
    await p._inline_image("http://storage/x.png")  # default → trusting
    assert seen == [False, True, True]


@pytest.mark.asyncio
async def test_inline_image_website_blocked_initial_returns_none(monkeypatch):
    """When the initial host is private for a WEBSITE asset, safe_get raises
    SSRFError → _inline_image returns None (drop, never forward the raw URL)."""
    import app.providers.http_providers as hp
    from app.ssrf import SSRFError

    async def fake_safe_get(client, url, *, allow_private_initial=False, **kw):
        if not allow_private_initial:
            raise SSRFError("blocked private host")
        return httpx.Response(200, content=b"\x89PNG")

    monkeypatch.setattr(hp, "safe_get", fake_safe_get)
    p = HttpVLMProvider(OPENAI, "k", model="gpt-4o")
    assert await p._inline_image("http://internal/x.png", source="WEBSITE") is None
    # UPLOAD source is allowed to hit the private host (our own storage).
    assert (
        await p._inline_image("http://internal/x.png", source="UPLOAD")
    ) is not None


def test_host_is_private():
    from app.ssrf import host_is_private

    # 私网 / 回环 / 链路本地(含云元数据)/ localhost / 空 → 视为内网
    assert host_is_private("127.0.0.1")
    assert host_is_private("10.0.0.5")
    assert host_is_private("192.168.1.1")
    assert host_is_private("172.16.0.1")
    assert host_is_private("169.254.169.254")
    assert host_is_private("::1")
    assert host_is_private("localhost")
    assert host_is_private("")
    assert host_is_private(None)
    # 公网字面 IP → 放行(用字面 IP 避免测试触发 DNS)
    assert not host_is_private("93.184.216.34")
    assert not host_is_private("8.8.8.8")
