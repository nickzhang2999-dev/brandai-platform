"""V0.0.13 — 多图生图（对话面板图像输入）。

迁移自 prd_agent 视觉创作，但刻意**不搬运**其多图 bug：prd_agent 的多图走
chat/completions Vision 分支且响应解析只认 message.content 字符串（单图/多图
两套解析 → "Vision API 响应格式不支持"）。BrandAI 的单图与多图共用同一条
`generate_with_references` (/images/edits multipart) 路径与同一个解析器。

契约：
  1. 多张 STRICT 参考不再被 400 拒绝；全部（≤8、按序）到达 provider；
  2. 单张 STRICT 行为逐字节不变（回归护栏）；
  3. >16 张 → 400（8 个对话输入 + 8 个项目资源，直连调用也被守住）；
  4. note 以 "IMAGE_INPUT" 开头的引用使用「按指令合成/改绘」prompt 模板，
     遗留 STRICT（锁定素材）保留 "mandatory locked asset" 模板——两种语义
     不得互相污染。
"""

from app.main import app
from app.providers import resolve_image_provider


def _payload(**overrides):
    base = {
        "sceneType": "ECOM_MAIN",
        "sellingPoint": "把产品图与背景图合成一张海报",
        "scene": "工作台对话",
        "brandRules": [],
        "versionCount": 1,
    }
    base.update(overrides)
    return base


def _strict_ref(url, note=None, source="asset:x"):
    ref = {
        "url": url,
        "polarity": "positive",
        "source": source,
        "mode": "STRICT",
    }
    if note is not None:
        ref["note"] = note
    return ref


def _constraints(refs):
    return {
        "negativePrompt": [],
        "promptAdditions": [],
        "hardBlocks": [],
        "referenceImages": refs,
    }


class _RecordingOpenAIProvider:
    """kind == "openai" so /v1/generate takes the generate_with_references
    (img2img multipart) path — the same one the real HttpImageProvider uses."""

    kind = "openai"
    model = "gpt-image-2"
    last_total_tokens = None

    def __init__(self):
        self.ref_calls = []
        self.generate_calls = []
        self.edit_calls = []

    async def generate_with_references(
        self, prompt, references, *, width, height, n, quality=None, model=None
    ):
        self.ref_calls.append(
            {
                "prompt": prompt,
                "references": references,
                "width": width,
                "height": height,
                "n": n,
                "quality": quality,
                "model": model,
            }
        )
        return ["data:image/png;base64,iVBORw0KGgo=" for _ in range(n)]

    async def generate(self, prompt, *, width, height, n, negative=None, extra=None):
        self.generate_calls.append(
            {
                "prompt": prompt,
                "width": width,
                "height": height,
                "n": n,
                "extra": extra,
            }
        )
        return ["data:image/png;base64,iVBORw0KGgo=" for _ in range(n)]

    async def edit(self, image_url, op, payload):
        self.edit_calls.append({"image_url": image_url, "op": op, "payload": payload})
        return "data:image/png;base64,iVBORw0KGgo="


def _post_with(client, provider, payload):
    app.dependency_overrides[resolve_image_provider] = lambda: provider
    try:
        return client.post("/v1/generate", json=payload)
    finally:
        app.dependency_overrides.clear()


def test_multi_strict_refs_all_reach_provider_in_order(client):
    provider = _RecordingOpenAIProvider()
    refs = [
        _strict_ref("https://cdn/a.png", note="IMAGE_INPUT:1", source="version:v1"),
        _strict_ref("https://cdn/b.png", note="IMAGE_INPUT:2", source="version:v2"),
        _strict_ref("https://cdn/c.png", note="IMAGE_INPUT:3", source="asset:a3"),
    ]
    r = _post_with(client, provider, _payload(aiConstraints=_constraints(refs)))
    assert r.status_code == 200
    # One img2img call carrying ALL refs, order preserved — no per-ref fan-out,
    # no dropped references.
    assert len(provider.ref_calls) == 1
    call = provider.ref_calls[0]
    assert [ref["url"] for ref in call["references"]] == [
        "https://cdn/a.png",
        "https://cdn/b.png",
        "https://cdn/c.png",
    ]
    assert provider.generate_calls == []
    p = r.json()["versions"][0]["params"]
    assert p["generationPath"] == "strict_image_input"
    # All strict refs are echoed (plural key), first kept on the legacy
    # singular key for pre-V0.0.13 readers.
    assert [ref["url"] for ref in p["strictReferenceImages"]] == [
        "https://cdn/a.png",
        "https://cdn/b.png",
        "https://cdn/c.png",
    ]
    assert p["strictReferenceImage"]["url"] == "https://cdn/a.png"


def test_single_strict_ref_regression_unchanged(client):
    provider = _RecordingOpenAIProvider()
    refs = [_strict_ref("https://cdn/logo.png", note="STRICT_USE: preserve the logo")]
    r = _post_with(client, provider, _payload(aiConstraints=_constraints(refs)))
    assert r.status_code == 200
    assert len(provider.ref_calls) == 1
    assert [ref["url"] for ref in provider.ref_calls[0]["references"]] == [
        "https://cdn/logo.png"
    ]
    p = r.json()["versions"][0]["params"]
    assert p["generationPath"] == "strict_image_input"
    assert p["strictReferenceImage"]["url"] == "https://cdn/logo.png"


def test_resolution_tier_maps_quality_for_text_generation(client):
    provider = _RecordingOpenAIProvider()
    r = _post_with(
        client,
        provider,
        _payload(
            targets=[
                {
                    "key": "chat-1k-1x1",
                    "label": "1K · 1:1",
                    "width": 1024,
                    "height": 1024,
                    "ratioKey": "1:1",
                    "resolutionTier": "1K",
                    "requestedRatio": "1:1",
                },
                {
                    "key": "chat-2k-1x1",
                    "label": "2K · 1:1",
                    "width": 2048,
                    "height": 2048,
                    "ratioKey": "1:1",
                    "resolutionTier": "2K",
                    "requestedRatio": "1:1",
                },
            ]
        ),
    )
    assert r.status_code == 200
    assert [call["extra"]["quality"] for call in provider.generate_calls] == [
        "medium",
        "high",
    ]
    versions = r.json()["versions"]
    assert [v["params"]["quality"] for v in versions] == ["medium", "high"]
    assert versions[1]["params"]["resolutionTier"] == "2K"
    assert versions[1]["params"]["requestedWidth"] == 2048


def test_resolution_tier_maps_high_quality_for_brand_kit_edit_path(client):
    provider = _RecordingOpenAIProvider()
    refs = [
        _strict_ref(
            "https://cdn/brand-logo.png",
            note="BRAND_LOGO_LOCKED: authoritative project Brand Kit logo",
        )
    ]
    r = _post_with(
        client,
        provider,
        _payload(
            aiConstraints=_constraints(refs),
            targets=[
                {
                    "key": "chat-2k-4x5",
                    "label": "2K · 4:5",
                    "width": 2048,
                    "height": 2560,
                    "ratioKey": "4:5",
                    "resolutionTier": "2K",
                }
            ],
        ),
    )
    assert r.status_code == 200
    assert provider.ref_calls[0]["quality"] == "high"
    assert provider.ref_calls[0]["width"] == 2048
    assert provider.ref_calls[0]["height"] == 2560
    assert r.json()["versions"][0]["params"]["quality"] == "high"


def test_gpt_image_2_gateway_uses_same_brand_kit_multipart_path(client):
    provider = _RecordingOpenAIProvider()
    provider.kind = "generic"
    refs = [
        _strict_ref(
            "https://cdn/brand-logo.png",
            note="BRAND_LOGO_LOCKED: authoritative project Brand Kit logo",
        )
    ]
    r = _post_with(
        client,
        provider,
        _payload(
            aiConstraints=_constraints(refs),
            targets=[
                {
                    "key": "chat-1k-1x1",
                    "label": "1K · 1:1",
                    "width": 1024,
                    "height": 1024,
                    "ratioKey": "1:1",
                    "resolutionTier": "1K",
                }
            ],
        ),
    )
    assert r.status_code == 200
    assert len(provider.ref_calls) == 1
    assert provider.ref_calls[0]["quality"] == "medium"
    assert provider.edit_calls == []


def test_more_than_sixteen_model_inputs_rejected(client):
    refs = [
        _strict_ref(f"https://cdn/{i}.png", note=f"IMAGE_INPUT:{i}")
        for i in range(17)
    ]
    r = client.post(
        "/v1/generate", json=_payload(aiConstraints=_constraints(refs))
    )
    assert r.status_code == 400
    assert "16" in r.json()["detail"]


def test_automatic_brand_logo_does_not_consume_eight_user_input_slots(client):
    provider = _RecordingOpenAIProvider()
    refs = [
        _strict_ref(
            "https://cdn/brand-logo.png",
            note="BRAND_LOGO_LOCKED: authoritative project Brand Kit logo",
        ),
        *[
            _strict_ref(f"https://cdn/{i}.png", note=f"IMAGE_INPUT:{i}")
            for i in range(8)
        ],
    ]
    r = _post_with(client, provider, _payload(aiConstraints=_constraints(refs)))
    assert r.status_code == 200
    assert len(provider.ref_calls[0]["references"]) == 9


def test_image_input_refs_use_compose_prompt_template(client):
    """IMAGE_INPUT refs (对话面板图生图) must NOT get the locked-asset wording —
    the user's brief drives a free transform/compose, not asset preservation."""
    provider = _RecordingOpenAIProvider()
    refs = [
        _strict_ref("https://cdn/a.png", note="IMAGE_INPUT:1"),
        _strict_ref("https://cdn/b.png", note="IMAGE_INPUT:2"),
    ]
    r = _post_with(client, provider, _payload(aiConstraints=_constraints(refs)))
    assert r.status_code == 200
    prompt = provider.ref_calls[0]["prompt"]
    assert "mandatory locked asset" not in prompt
    assert "input image" in prompt
    # The generation brief (user instruction) must ride through.
    assert "把产品图与背景图合成一张海报" in prompt


def test_legacy_strict_refs_keep_locked_asset_template(client):
    provider = _RecordingOpenAIProvider()
    refs = [
        _strict_ref("https://cdn/logo.png", note="STRICT_USE: logo"),
        _strict_ref("https://cdn/seal.png"),
    ]
    r = _post_with(client, provider, _payload(aiConstraints=_constraints(refs)))
    assert r.status_code == 200
    prompt = provider.ref_calls[0]["prompt"]
    assert "mandatory locked asset" in prompt


def test_project_asset_usage_modes_get_distinct_real_input_instructions(client):
    provider = _RecordingOpenAIProvider()
    refs = [
        _strict_ref(
            "https://cdn/chicken-leg.png",
            note="ASSET_USAGE:ADAPTIVE:1",
        ),
        _strict_ref(
            "https://cdn/style-board.png",
            note="ASSET_USAGE:REFERENCE:2",
        ),
    ]
    r = _post_with(client, provider, _payload(aiConstraints=_constraints(refs)))
    assert r.status_code == 200
    assert len(provider.ref_calls) == 1
    assert [ref["url"] for ref in provider.ref_calls[0]["references"]] == [
        "https://cdn/chicken-leg.png",
        "https://cdn/style-board.png",
    ]
    prompt = provider.ref_calls[0]["prompt"]
    assert "ADAPTIVE assets" in prompt
    assert "Never replace them with a different product, species" in prompt
    assert "REFERENCE-only" in prompt
    assert "subjects do not need to appear" in prompt


def test_brand_logo_ref_reserves_safe_area_and_forbids_invented_logo(client):
    provider = _RecordingOpenAIProvider()
    refs = [
        _strict_ref(
            "https://cdn/brand-logo.png",
            note="BRAND_LOGO_LOCKED: authoritative project Brand Kit logo",
        )
    ]
    r = _post_with(client, provider, _payload(aiConstraints=_constraints(refs)))
    assert r.status_code == 200
    prompt = provider.ref_calls[0]["prompt"]
    assert "upper-left" in prompt
    assert "Do not draw" in prompt
    assert "invent" in prompt
    assert "composited" in prompt


def test_multi_strict_refs_fallback_edit_path_keeps_all_urls(client):
    """Non-openai providers (mock included) fall back to provider.edit with the
    first ref as the image input; the remaining refs must still be forwarded in
    the payload instead of being silently dropped."""
    r = client.post(
        "/v1/generate",
        json=_payload(
            aiConstraints=_constraints(
                [
                    _strict_ref("https://cdn/a.png", note="IMAGE_INPUT:1"),
                    _strict_ref("https://cdn/b.png", note="IMAGE_INPUT:2"),
                ]
            )
        ),
    )
    assert r.status_code == 200
    p = r.json()["versions"][0]["params"]
    assert [ref["url"] for ref in p["strictReferenceImages"]] == [
        "https://cdn/a.png",
        "https://cdn/b.png",
    ]
