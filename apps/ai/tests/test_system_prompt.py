"""V0.0.13 — 管理员可配置的图像系统提示词（AppSetting.imageSystemPrompt →
worker → GenerateRequest.systemPrompt → prompt 首部）。

契约：
  1. systemPrompt 存在时置于 prompt 首部（文生图与图生图两条路径都生效）；
  2. 缺省时 prompt 逐字节不变（frozen-additive）。
"""

from app.main import app
from app.providers import resolve_image_provider


def _payload(**overrides):
    base = {
        "sceneType": "ECOM_MAIN",
        "sellingPoint": "低温慢萃",
        "scene": "门店",
        "brandRules": [],
        "versionCount": 1,
    }
    base.update(overrides)
    return base


class _Recorder:
    kind = "openai"
    model = "gpt-image-2"
    last_total_tokens = None

    def __init__(self):
        self.generate_calls = []
        self.ref_calls = []

    async def generate(self, prompt, *, width, height, n, negative=None, extra=None):
        self.generate_calls.append({"prompt": prompt})
        return ["data:image/png;base64,iVBORw0KGgo=" for _ in range(n)]

    async def generate_with_references(
        self, prompt, references, *, width, height, n, quality=None, model=None
    ):
        self.ref_calls.append({"prompt": prompt, "references": references})
        return ["data:image/png;base64,iVBORw0KGgo=" for _ in range(n)]

    async def edit(self, image_url, op, payload):
        return "data:image/png;base64,iVBORw0KGgo="


def _post_with(client, provider, payload):
    app.dependency_overrides[resolve_image_provider] = lambda: provider
    try:
        return client.post("/v1/generate", json=payload)
    finally:
        app.dependency_overrides.clear()


def test_system_prompt_prepended_to_generate_prompt(client):
    provider = _Recorder()
    r = _post_with(
        client,
        provider,
        _payload(systemPrompt="品牌基调：极简、克制、violet 主色。"),
    )
    assert r.status_code == 200
    prompt = provider.generate_calls[0]["prompt"]
    assert prompt.startswith("品牌基调：极简、克制、violet 主色。")
    # The scene brief still follows the system prompt.
    assert "低温慢萃" in prompt
    # Echoed for verifiability (A7 acceptance: params.prompt 可查证).
    assert (
        r.json()["versions"][0]["params"]["prompt"].startswith(
            "品牌基调：极简、克制、violet 主色。"
        )
    )


def test_system_prompt_applies_to_image_input_path(client):
    provider = _Recorder()
    r = _post_with(
        client,
        provider,
        _payload(
            systemPrompt="品牌基调：极简。",
            aiConstraints={
                "negativePrompt": [],
                "promptAdditions": [],
                "hardBlocks": [],
                "referenceImages": [
                    {
                        "url": "https://cdn/a.png",
                        "polarity": "positive",
                        "source": "version:v1",
                        "mode": "STRICT",
                        "note": "IMAGE_INPUT:1",
                    }
                ],
            },
        ),
    )
    assert r.status_code == 200
    assert "品牌基调：极简。" in provider.ref_calls[0]["prompt"]


def test_absent_system_prompt_keeps_prompt_unchanged(client):
    provider = _Recorder()
    r = _post_with(client, provider, _payload())
    assert r.status_code == 200
    prompt = provider.generate_calls[0]["prompt"]
    assert prompt.startswith("[ECOM_MAIN] 低温慢萃. Scene: 门店.")
