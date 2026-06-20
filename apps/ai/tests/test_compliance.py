"""Ad-compliance lexicon + brand term library behaviour (M5 backbone)."""


def test_absolute_and_exaggeration_terms_flagged(client):
    r = client.post(
        "/v1/compliance/check",
        json={"text": "全网第一，100%有效", "brandRules": [], "termLib": []},
    )
    d = r.json()
    spans = {x["span"] for x in d["results"]}
    assert "第一" in spans and "100%" in spans
    assert d["report"]["overall"] in {"RISK", "FORBIDDEN"}


def test_brand_termlib_forbidden_outranks_lexicon(client):
    r = client.post(
        "/v1/compliance/check",
        json={
            "text": "我们的产品顶级",
            "brandRules": [],
            "termLib": [{
                "type": "FORBIDDEN", "term": "顶级",
                "reason": "品牌禁用", "replacement": "优选",
            }],
        },
    )
    d = r.json()
    hit = next(x for x in d["results"] if x["span"] == "顶级")
    assert hit["level"] == "FORBIDDEN"
    assert hit["replacement"] == "优选"
    assert d["report"]["overall"] == "FORBIDDEN"


def test_clean_text_passes(client):
    r = client.post(
        "/v1/compliance/check",
        json={"text": "一杯慢煮的咖啡", "brandRules": [], "termLib": []},
    )
    assert r.json()["report"]["overall"] == "PASS"


def test_compliance_accepts_reference_images(client):
    """D5 — the visual check accepts positive/negative example references
    without breaking the response shape (the mock VLM ignores them)."""
    r = client.post(
        "/v1/compliance/check",
        json={
            "imageUrl": "http://x/a.png",
            "brandRules": [],
            "termLib": [],
            "referenceImages": [
                {
                    "url": "http://x/bad.png",
                    "polarity": "negative",
                    "source": "prohibition:p1",
                    "note": "禁止低对比",
                }
            ],
        },
    )
    assert r.status_code == 200
    assert r.json()["report"]["overall"] in {"PASS", "RISK", "FORBIDDEN"}


def test_compliance_reference_images_reach_vlm(client):
    """D5 — compiled references are forwarded to the VLM's
    check_visual_compliance via the additive `references` kwarg."""
    from app.main import app
    from app.providers import resolve_vlm_provider

    seen: dict[str, object] = {}

    class _FakeVLM:
        async def check_visual_compliance(
            self, image_url, brand_rules, references=None
        ):
            seen["references"] = references
            return {"results": [], "score": 90}

    app.dependency_overrides[resolve_vlm_provider] = lambda: _FakeVLM()
    try:
        refs = [
            {
                "url": "http://x/bad.png",
                "polarity": "negative",
                "source": "prohibition:p1",
            }
        ]
        r = client.post(
            "/v1/compliance/check",
            json={
                "imageUrl": "http://x/a.png",
                "brandRules": [],
                "termLib": [],
                "referenceImages": refs,
            },
        )
        assert r.status_code == 200
        assert seen["references"] == refs
    finally:
        app.dependency_overrides.clear()


def test_visual_score_fallback_when_vlm_omits_score(client):
    """A scored image must always get a brand score: when the VLM omits the
    numeric score, main.py derives it from the visual verdict (100 − penalties)."""
    from app.main import app
    from app.providers import resolve_vlm_provider

    class _FakeVLM:
        async def check_visual_compliance(self, image_url, brand_rules):
            return {
                "results": [
                    {"level": "RISK", "reason": "主色偏离", "category": "BRAND_VISUAL"}
                ],
                "score": None,
            }

    app.dependency_overrides[resolve_vlm_provider] = lambda: _FakeVLM()
    try:
        r = client.post(
            "/v1/compliance/check",
            json={"imageUrl": "http://x/a.png", "brandRules": [], "termLib": []},
        )
        assert r.status_code == 200
        assert r.json()["report"]["score"] == 85  # 100 − 15 (one RISK)
    finally:
        app.dependency_overrides.clear()
