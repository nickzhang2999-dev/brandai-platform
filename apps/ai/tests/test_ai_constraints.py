"""P1.2 — verify /v1/generate honours the new `aiConstraints` payload.

The web worker is the authority on hard-block enforcement; the AI service's
contract is narrower:
  1. accept the new optional field without breaking pre-P1.2 callers,
  2. echo `appliedNegativePrompt` / `appliedPromptAdditions` /
     `machineRulesApplied` into every version's `params` so L3 can prove the
     constraint actually rode through,
  3. translate `machineRules.aspect_ratio` into the version's width/height.
"""


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
