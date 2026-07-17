"""P1.2 — verify /v1/generate honours the new `aiConstraints` payload.

The web worker is the authority on hard-block enforcement; the AI service's
contract is narrower:
  1. accept the new optional field without breaking pre-P1.2 callers,
  2. echo `appliedNegativePrompt` / `appliedPromptAdditions` /
     `machineRulesApplied` into every version's `params` so L3 can prove the
     constraint actually rode through,
  3. translate `machineRules.aspect_ratio` into the version's width/height.
"""

from app.main import app
from app.providers import resolve_image_provider


def _payload(**overrides):
    base = {
        "sceneType": "ECOM_MAIN",
        "sellingPoint": "低温慢萃",
        "scene": "门店",
        "brandRules": [],
        "versionCount": 2,
    }
    base.update(overrides)
    return base


class _RecordingImageProvider:
    kind = "fake"
    model = "recorder"
    last_total_tokens = None

    def __init__(self):
        self.generate_calls = []
        self.edit_calls = []

    async def generate(self, prompt, *, width, height, n, negative=None, extra=None):
        self.generate_calls.append(
            {
                "prompt": prompt,
                "width": width,
                "height": height,
                "n": n,
                "negative": negative,
                "extra": extra,
            }
        )
        return ["data:image/png;base64,iVBORw0KGgo=" for _ in range(n)]

    async def edit(self, image_url, op, payload):
        self.edit_calls.append({"image_url": image_url, "op": op, "payload": payload})
        return "data:image/png;base64,iVBORw0KGgo="

    async def check(self):
        return type("ProviderCheck", (), {"ok": True, "detail": "fake"})()


def test_generate_echoes_negative_prompt(client):
    r = client.post(
        "/v1/generate",
        json=_payload(
            aiConstraints={
                "negativePrompt": ["no neon", "avoid red+white"],
                "promptAdditions": ["preferred tone: 克制"],
                "hardBlocks": [],
            }
        ),
    )
    assert r.status_code == 200
    d = r.json()
    p = d["versions"][0]["params"]
    assert p["appliedNegativePrompt"] == ["no neon", "avoid red+white"]
    assert "preferred tone: 克制" in p["appliedPromptAdditions"]
    # Legacy echo keys for raw inspection (no worker echo round-trip).
    assert p["negative_prompt"] == ["no neon", "avoid red+white"]


def test_generate_returns_usage(client):
    """T-conn-b — every generate carries a usage summary. On mock the cost is
    unpriced so costUsd is omitted (no-null), but provider/imageCount/latency are
    always present."""
    r = client.post("/v1/generate", json=_payload(versionCount=2))
    assert r.status_code == 200
    u = r.json()["usage"]
    assert u["provider"] == "mock"
    assert u["imageCount"] == 2
    assert "costUsd" not in u  # mock unpriced → omitted
    assert "model" not in u  # mock has no model → omitted
    assert isinstance(u["latencyMs"], int)


def test_generate_passthrough_unchanged_when_constraints_absent(client):
    """The pre-P1.2 wire shape must keep its semantics untouched."""
    r = client.post("/v1/generate", json=_payload())
    assert r.status_code == 200
    p = r.json()["versions"][0]["params"]
    # Without aiConstraints the echo keys MUST NOT appear (preserves the
    # "no null in payload" invariant when nothing was compiled).
    assert "appliedNegativePrompt" not in p
    assert "machine_rules" not in p


def test_generate_machine_rule_aspect_ratio_translates_size(client):
    r = client.post(
        "/v1/generate",
        json=_payload(
            sceneType="ECOM_MAIN",  # base 1024x1024
            aiConstraints={
                "machineRules": {"aspect_ratio": "16:9"},
                "negativePrompt": [],
                "promptAdditions": [],
                "hardBlocks": [],
            },
        ),
    )
    assert r.status_code == 200
    v = r.json()["versions"][0]
    # Base 1024 long-edge preserved, short edge scaled to 9/16.
    assert v["width"] == 1024
    assert v["height"] == 576
    assert v["params"]["machineRulesApplied"] == {"aspect_ratio": "16:9"}


def test_generate_echoes_reference_images(client):
    """D5 — positive/negative example assets ride through into params and the
    negative example's note is folded into the negative prompt."""
    r = client.post(
        "/v1/generate",
        json=_payload(
            aiConstraints={
                "negativePrompt": [],
                "promptAdditions": [],
                "hardBlocks": [],
                "referenceImages": [
                    {
                        "url": "https://cdn/good.png",
                        "polarity": "positive",
                        "source": "prohibition:p1",
                        "note": "良好示例",
                    },
                    {
                        "url": "https://cdn/bad.png",
                        "polarity": "negative",
                        "source": "prohibition:p1",
                        "note": "禁止低对比",
                    },
                ],
            }
        ),
    )
    assert r.status_code == 200
    p = r.json()["versions"][0]["params"]
    assert p["appliedReferenceImages"] == [
        {
            "url": "https://cdn/good.png",
            "polarity": "positive",
            "source": "prohibition:p1",
            "note": "良好示例",
        },
        {
            "url": "https://cdn/bad.png",
            "polarity": "negative",
            "source": "prohibition:p1",
            "note": "禁止低对比",
        },
    ]
    # The negative example's note is folded into the negative prompt so even
    # image-blind providers receive the avoidance signal.
    assert "禁止低对比" in p["appliedNegativePrompt"]


def test_generate_strict_reference_uses_image_input_edit_path(client):
    provider = _RecordingImageProvider()
    app.dependency_overrides[resolve_image_provider] = lambda: provider
    try:
        r = client.post(
            "/v1/generate",
            json=_payload(
                versionCount=2,
                aiConstraints={
                    "negativePrompt": [],
                    "promptAdditions": [],
                    "hardBlocks": [],
                    "referenceImages": [
                        {
                            "url": "https://cdn/logo.png",
                            "polarity": "positive",
                            "source": "asset:a1",
                            "mode": "STRICT",
                            "note": "STRICT_USE: preserve the logo",
                        }
                    ],
                },
            ),
        )
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200
    assert provider.generate_calls == []
    assert len(provider.edit_calls) == 2
    assert provider.edit_calls[0]["image_url"] == "https://cdn/logo.png"
    assert provider.edit_calls[0]["op"] == "STRICT_REFERENCE_GENERATE"
    assert "mandatory locked asset" in provider.edit_calls[0]["payload"]["prompt"]
    p = r.json()["versions"][0]["params"]
    assert p["generationPath"] == "strict_image_input"
    assert p["strictReferencePolicy"] == "provider.edit image input; no text-only fallback"
    assert p["strictReferenceImage"]["mode"] == "STRICT"


def test_generate_accepts_multiple_strict_references(client):
    """V0.0.13 — 多图生图: multiple STRICT refs are accepted (the V0.0.8
    single-STRICT 400 is lifted) and ALL of them are echoed back so the caller
    can prove none was dropped. Full multi-image behavior is covered in
    test_multi_image_input.py."""
    r = client.post(
        "/v1/generate",
        json=_payload(
            aiConstraints={
                "negativePrompt": [],
                "promptAdditions": [],
                "hardBlocks": [],
                "referenceImages": [
                    {
                        "url": "https://cdn/a.png",
                        "polarity": "positive",
                        "source": "asset:a",
                        "mode": "STRICT",
                    },
                    {
                        "url": "https://cdn/b.png",
                        "polarity": "positive",
                        "source": "asset:b",
                        "mode": "STRICT",
                    },
                ],
            },
        ),
    )
    assert r.status_code == 200
    p = r.json()["versions"][0]["params"]
    assert [ref["url"] for ref in p["strictReferenceImages"]] == [
        "https://cdn/a.png",
        "https://cdn/b.png",
    ]


def test_generate_passes_hardblocks_through_without_aborting(client):
    """The web worker enforces hardBlocks — the AI service simply echoes
    constraints. We assert it does NOT 422 when blocks are present in the
    body (because by then the worker has already decided to call us)."""
    r = client.post(
        "/v1/generate",
        json=_payload(
            aiConstraints={
                "negativePrompt": ["x"],
                "promptAdditions": [],
                "hardBlocks": [{"reason": "neon banned", "source": "prohibition:1"}],
            }
        ),
    )
    assert r.status_code == 200
    p = r.json()["versions"][0]["params"]
    assert p["appliedNegativePrompt"] == ["x"]
