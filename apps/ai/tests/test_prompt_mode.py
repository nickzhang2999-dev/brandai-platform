"""V0.0.13g — promptMode=direct：对话来源生成的极简 prompt（文不对题修复）。

取证背景：用户 11 字指令「让 [图1] 仿照 [图2] 的风格绘画」被拼进 ~3000 字
prompt（[SOCIAL_POSTER] 标签 + 自动 Scene + 整份品牌规则 + Additions），
模型服从品牌规范无视输入图。direct 模式下 prompt 只含用户 brief（+ 可选
systemPrompt 前缀）；branded 缺省行为逐字节不变。
"""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _base(**over):
    body = {
        "sceneType": "SOCIAL_POSTER",
        "sellingPoint": "让 [图1] 仿照 [图2] 的风格绘画",
        "scene": "突出魔兽世界法师的冒险主题",
        "brandRules": [
            {"id": "r1", "type": "color", "strength": "FORBIDDEN",
             "summary": "整份品牌规范长文……", "status": "CONFIRMED", "value": {}}
        ],
        "versionCount": 1,
    }
    body.update(over)
    return body


def test_direct_mode_prompt_is_user_brief_only():
    r = client.post("/v1/generate", json=_base(promptMode="direct", aiConstraints={
        "promptAdditions": ["双色印刷"],
        "negativePrompt": ["禁用旧logo"],
        "hardBlocks": [],
        "referenceImages": [],
    }))
    assert r.status_code == 200
    prompt = r.json()["versions"][0]["params"]["prompt"]
    assert prompt == "让 [图1] 仿照 [图2] 的风格绘画"
    assert "[SOCIAL_POSTER]" not in prompt
    assert "Scene:" not in prompt
    assert "Brand rules:" not in prompt
    assert "Additions:" not in prompt
    # 安全底线保留：negativePrompt 仍随请求生效（落 params）
    assert "禁用旧logo" in (r.json()["versions"][0]["params"].get("negative_prompt") or "")


def test_direct_mode_with_system_prompt_prefix():
    r = client.post("/v1/generate", json=_base(promptMode="direct", systemPrompt="品牌统一水印风格"))
    assert r.status_code == 200
    prompt = r.json()["versions"][0]["params"]["prompt"]
    assert prompt.startswith("品牌统一水印风格")
    assert prompt.endswith("让 [图1] 仿照 [图2] 的风格绘画")
    assert "Brand rules:" not in prompt


def test_branded_default_unchanged():
    r = client.post("/v1/generate", json=_base())
    assert r.status_code == 200
    prompt = r.json()["versions"][0]["params"]["prompt"]
    assert prompt.startswith("[SOCIAL_POSTER] 让 [图1] 仿照 [图2] 的风格绘画. Scene: 突出魔兽世界法师的冒险主题.")
    assert "Brand rules: 整份品牌规范长文……" in prompt


def test_branded_direct_puts_compact_brand_boundary_before_user_brief():
    r = client.post("/v1/generate", json=_base(
        promptMode="branded_direct",
        aiConstraints={
            "promptAdditions": ["品牌主色 #FF6C2C", "Logo 保持安全留白"],
            "negativePrompt": ["禁止替换品牌 Logo"],
            "hardBlocks": [],
            "referenceImages": [],
        },
    ))
    assert r.status_code == 200
    params = r.json()["versions"][0]["params"]
    prompt = params["prompt"]
    boundary = prompt.index("[MANDATORY BRAND BOUNDARY")
    compiled = prompt.index("[COMPILED BRAND CONSTRAINTS]")
    brief = prompt.index("[USER CREATIVE BRIEF]")
    assert boundary < compiled < brief
    assert "整份品牌规范长文……" in prompt
    assert "品牌主色 #FF6C2C" in prompt
    assert "让 [图1] 仿照 [图2] 的风格绘画" in prompt
    assert "Scene:" not in prompt
    assert params["appliedRules"] == ["r1"]


def test_studio_fidelity_instruction_reaches_actual_http_provider_payload():
    import json
    import httpx
    from app.providers import resolve_image_provider
    from app.providers.http_providers import HttpImageProvider
    captured = []
    def transport(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"data": [{"url": "https://image.invalid/result.png"}]})
    provider = HttpImageProvider("https://api.openai.com/v1", "synthetic-only", transport=httpx.MockTransport(transport))
    previous = dict(app.dependency_overrides)
    app.dependency_overrides[resolve_image_provider] = lambda: provider
    try:
        base = _base(promptMode="direct", brandRules=[], providerRetryPolicy="never", aiConstraints={
            "promptAdditions": ["主体保持绿色，背景允许品牌红"], "negativePrompt": [], "hardBlocks": [], "referenceImages": []})
        response = client.post("/v1/generate", json={**base, "visualFidelityRevision": "visual-fidelity-guard/1"})
        assert response.status_code == 200
        assert "主体保持绿色，背景允许品牌红" in captured[-1]["prompt"]
        response = client.post("/v1/generate", json=base)
        assert response.status_code == 200
        assert "主体保持绿色，背景允许品牌红" not in captured[-1]["prompt"]
        assert captured[-1]["prompt"] == base["sellingPoint"]
        assert len(captured) == 2
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
