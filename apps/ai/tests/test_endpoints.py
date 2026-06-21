"""Behavioural contract of the 5 AI endpoints under the mock provider."""


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_diag_mock_providers_ok(client):
    """Self-check returns ok for the mock providers (no key configured)."""
    r = client.post("/v1/diag")
    d = r.json()
    assert r.status_code == 200
    assert d["image"]["ok"] is True
    assert d["vlm"]["ok"] is True
    # Mock detail flags the placeholder mode so the operator knows no real
    # provider was reached.
    assert "mock" in d["image"]["detail"]
    assert "mock" in d["vlm"]["detail"]


def test_ingest_website_shape(client):
    r = client.post("/v1/ingest/website", json={"url": "https://example.com"})
    d = r.json()
    assert r.status_code == 200
    assert len(d["images"]) >= 1
    assert all({"sourceUrl", "previewUrl"} <= img.keys() for img in d["images"])
    assert d["sellingPoints"] and d["copies"]


def test_recognize_returns_rules_with_evidence_and_colorsystem(client):
    r = client.post(
        "/v1/recognize",
        json={"assets": [{"id": "a1", "url": "http://x/y.png"}]},
    )
    d = r.json()
    assert r.status_code == 200
    assert len(d["rules"]) >= 1
    for rule in d["rules"]:
        assert rule["type"] in {
            "color", "font", "layout", "imagery", "graphic", "copy", "logo"
        }
        assert rule["strength"] in {"STRONG", "WEAK", "FORBIDDEN"}
        assert rule["evidence"], "every rule must carry evidence"
        assert rule["evidence"][0]["assetId"] == "a1"
    cs = d["colorSystem"]
    assert cs["palette"] and 0 <= cs["consistencyScore"] <= 100


def test_generate_scene_sizes(client):
    r = client.post(
        "/v1/generate",
        json={
            "sceneType": "SOCIAL_POSTER",
            "sellingPoint": "低温慢萃",
            "scene": "门店",
            "brandRules": [],
            "versionCount": 4,
        },
    )
    d = r.json()
    assert r.status_code == 200
    assert len(d["versions"]) == 4
    # SOCIAL_POSTER must map to its channel size, not the 1024 default.
    assert (d["versions"][0]["width"], d["versions"][0]["height"]) == (1080, 1350)


def test_generate_direct_text_mode_is_default_and_unchanged(client):
    """Direct mode (the default) must NOT add the no-text steer or negatives."""
    r = client.post(
        "/v1/generate",
        json={
            "sceneType": "ECOM_MAIN",
            "sellingPoint": "72 小时长效保湿",
            "scene": "浴室台面",
            "brandRules": [],
            "versionCount": 1,
        },
    )
    d = r.json()
    assert r.status_code == 200
    p = d["versions"][0]["params"]
    # Default text mode is "direct".
    assert p["textMode"] == "direct"
    # The layered no-text instruction must be absent from the prompt.
    assert "do NOT render any text" not in p["prompt"]
    # No layered-negatives echo in direct mode (keeps params lean).
    assert "appliedTextModeNegatives" not in p


def test_generate_layered_text_mode_steers_prompt_and_negatives(client):
    r = client.post(
        "/v1/generate",
        json={
            "sceneType": "ECOM_MAIN",
            "sellingPoint": "72 小时长效保湿",
            "scene": "浴室台面",
            "brandRules": [],
            "versionCount": 1,
            "textMode": "layered",
        },
    )
    d = r.json()
    assert r.status_code == 200
    p = d["versions"][0]["params"]
    assert p["textMode"] == "layered"
    # Prompt gains the "leave negative space / render no text" instruction.
    assert "negative space" in p["prompt"]
    assert "do NOT render any text" in p["prompt"]
    # The no-text negative terms are applied (and echoed for traceability).
    negs = p["appliedTextModeNegatives"]
    for term in ("text", "letters", "words", "caption", "watermark", "typography"):
        assert term in negs


def test_generate_layered_merges_with_existing_negatives(client):
    """Layered no-text negatives merge with constraint negatives, no dupes."""
    r = client.post(
        "/v1/generate",
        json={
            "sceneType": "ECOM_MAIN",
            "sellingPoint": "低温慢萃",
            "scene": "门店",
            "brandRules": [],
            "versionCount": 1,
            "textMode": "layered",
            "aiConstraints": {
                "negativePrompt": ["no neon", "text"],
                "promptAdditions": [],
                "hardBlocks": [],
            },
        },
    )
    d = r.json()
    assert r.status_code == 200
    p = d["versions"][0]["params"]
    negs = p["appliedNegativePrompt"]
    # Pre-existing "no neon" preserved, pre-existing "text" not duplicated.
    assert "no neon" in negs
    assert negs.count("text") == 1
    # The remaining no-text terms were appended.
    assert "typography" in negs


def test_describe_returns_tags_and_description(client):
    """E9/E10 — /v1/describe returns concise tags + a description (mock)."""
    r = client.post(
        "/v1/describe",
        json={"url": "http://x/y.png", "category": "PRODUCT"},
    )
    d = r.json()
    assert r.status_code == 200
    assert isinstance(d["aiTags"], list) and len(d["aiTags"]) >= 1
    # category hint leads the mock tag list → wiring is observable end-to-end.
    assert d["aiTags"][0] == "PRODUCT"
    assert isinstance(d["aiDescription"], str) and d["aiDescription"]


def test_describe_no_null_fields(client):
    """aiDescription is a required str; nothing serializes as null."""
    from .conftest import find_nulls

    r = client.post("/v1/describe", json={"url": "http://x/y.png"})
    assert r.status_code == 200
    assert find_nulls(r.json()) == []


def test_summarize_brief_decompose(client):
    """B2 — brief_decompose returns creation seeds; sceneType is a valid enum."""
    r = client.post(
        "/v1/summarize",
        json={
            "mode": "brief_decompose",
            "text": "为夏季新品做一组小红书种草主视觉，清透水光风格",
        },
    )
    d = r.json()
    assert r.status_code == 200, r.text
    # mock leads sellingPoint with the brief's first line → wiring observable.
    assert d["sellingPoint"]
    assert d["sceneType"] in {
        "ECOM_MAIN", "SCENE", "SOCIAL_POSTER", "CAMPAIGN_KV", "SELLING_POINT"
    }
    assert isinstance(d["styleKeywords"], list) and d["styleKeywords"]
    assert d["summary"]


def test_summarize_campaign_summary(client):
    """C8 — campaign_summary returns a summary + highlights from the context."""
    r = client.post(
        "/v1/summarize",
        json={
            "mode": "campaign_summary",
            "text": "夏季新品上市 Campaign，已完成 KV 主视觉初稿",
            "context": {
                "campaignName": "夏季新品",
                "ruleSummaries": ["主色 #7C5CFF", "标题衬线"],
            },
        },
    )
    d = r.json()
    assert r.status_code == 200, r.text
    assert isinstance(d["summary"], str) and d["summary"]
    assert isinstance(d["highlights"], list) and d["highlights"]


def test_summarize_no_null_fields(client):
    """No response field serializes as null (the .optional() contract boundary)."""
    from .conftest import find_nulls

    r = client.post(
        "/v1/summarize", json={"mode": "brief_decompose", "text": "x"}
    )
    assert r.status_code == 200
    assert find_nulls(r.json()) == []


def test_edit_creates_image(client):
    r = client.post(
        "/v1/edit",
        json={"imageUrl": "http://x/y.png", "op": "INPAINT",
              "payload": {"mask": [0.1, 0.1, 0.3, 0.3]}},
    )
    d = r.json()
    # Image ref is either a hosted URL (real provider) or a self-contained
    # data: image (mock returns an inline SVG placeholder so it renders anywhere).
    assert r.status_code == 200
    assert d["imageUrl"].startswith("http") or d["imageUrl"].startswith("data:image")
    assert d["params"]["op"] == "INPAINT"
