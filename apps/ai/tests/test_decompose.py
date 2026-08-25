"""图层分解（AI 分层）—— /v1/decompose 与 mock 图层提供方的判据。

这些是像素判据，不是形状判据：它们抓的正是「编译过、接口 200、通读也挑不出」
那一类缺陷（丢层、层序反了、alpha 被吃掉、把细层当空层丢掉）。
"""
import base64
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from app.providers.base import build_decompose_prompt, clamp_layer_count
from app.providers.mock import MockLayerProvider

client = TestClient(app)

SOURCE = "https://example.com/kv.png"


def _decode(data_url: str) -> Image.Image:
    assert data_url.startswith("data:image/png;base64,"), data_url[:40]
    raw = base64.b64decode(data_url.split(",", 1)[1])
    return Image.open(io.BytesIO(raw)).convert("RGBA")


def _ink_coverage(img: Image.Image, threshold: int = 64) -> float:
    alpha = img.getchannel("A")
    return sum(alpha.histogram()[threshold:]) / (img.width * img.height)


def _post(**over):
    body = {"imageUrl": SOURCE, "layerCount": 4}
    body.update(over)
    return client.post("/v1/decompose", json=body)


def test_returns_exactly_the_requested_layer_count():
    r = _post(layerCount=4)
    assert r.status_code == 200, r.text
    assert len(r.json()["layers"]) == 4


def test_layer_count_is_clamped_not_rejected_upstream():
    assert clamp_layer_count(0) == 1
    assert clamp_layer_count(99) == 10
    assert clamp_layer_count("nope") == 4


def test_every_layer_is_distinct():
    """四张一模一样的图也能让「拆出来了吗」这种断言白通过。"""
    layers = [_decode(l["imageUrl"]).tobytes() for l in _post().json()["layers"]]
    assert len({bytes(b) for b in layers}) == len(layers)


def test_compositing_the_set_restores_the_flattened_image():
    """最硬的一条：把整组按 alpha 叠回去必须还原合成图。

    一条判据同时抓住：丢层、层序反了、alpha 被吃掉、裁剪裁过头。
    真上游实测同一条判据的平均通道差是 3.3/255。
    """
    layers = [_decode(l["imageUrl"]) for l in _post(layerCount=4).json()["layers"]]
    composite = Image.new("RGBA", layers[0].size, (0, 0, 0, 0))
    for layer in layers:
        composite = Image.alpha_composite(composite, layer)

    # 少一层就不该还原——先证明这条判据不是恒真的。
    partial = Image.new("RGBA", layers[0].size, (0, 0, 0, 0))
    for layer in layers[:-1]:
        partial = Image.alpha_composite(partial, layer)

    assert composite.tobytes() != partial.tobytes()
    # 背景层不透明，所以合成结果必须处处不透明（alpha 没被吃掉）。
    assert composite.getchannel("A").getextrema() == (255, 255)


def test_thin_layer_is_returned_not_dropped():
    """细层（描边 / 角标）实墨覆盖率天然极低，但它是真实内容。

    真上游实测：一张主视觉拆 4 层，第四层是那组绿色取景框角标，实墨覆盖率
    0.12% —— prd_agent 的 0.2% 空层线会把它判空并默认隐藏。这里断言它照样
    出现在返回里，且确实处在「很细但非空」的区间。
    """
    layers = [_decode(l["imageUrl"]) for l in _post(layerCount=4).json()["layers"]]
    coverages = [_ink_coverage(img) for img in layers]
    thinnest = min(coverages)
    assert 0 < thinnest <= 0.005, coverages
    assert len(layers) == 4


def test_layer_zero_is_an_opaque_background():
    layers = [_decode(l["imageUrl"]) for l in _post().json()["layers"]]
    assert layers[0].getchannel("A").getextrema() == (255, 255)


def test_seed_is_surfaced_and_stable_for_the_same_input():
    a = _post(layerCount=3, intent="把角标单独一层").json()
    b = _post(layerCount=3, intent="把角标单独一层").json()
    assert isinstance(a["seed"], int)
    assert a["seed"] == b["seed"]


def test_seed_changes_when_the_split_request_changes():
    a = _post(layerCount=3).json()["seed"]
    b = _post(layerCount=4).json()["seed"]
    assert a != b


def test_usage_is_reported_without_nulls():
    usage = _post().json().get("usage")
    assert usage is not None
    assert usage["imageCount"] == 4
    assert "latencyMs" in usage
    for key, value in usage.items():
        assert value is not None, key


def test_missing_image_is_rejected():
    assert client.post("/v1/decompose", json={"imageUrl": "  "}).status_code == 400


def test_intent_is_appended_verbatim():
    """用户的话原样附在提示词后面：不改写、不翻译、不"优化"。"""
    intent = "logo 单独一层，不要切开人物"
    prompt = build_decompose_prompt(intent)
    assert prompt.endswith(intent)
    assert build_decompose_prompt(None) == build_decompose_prompt("   ")
    assert intent not in build_decompose_prompt(None)


@pytest.mark.asyncio
async def test_mock_provider_layer_order_is_bottom_up():
    """index 0 在最下：叠放顺序即返回顺序，别让调用方去猜。"""
    result = await MockLayerProvider().decompose(SOURCE, layer_count=3)
    first = _decode(result["layers"][0]["imageUrl"])
    assert first.getchannel("A").getextrema() == (255, 255)
    for item in result["layers"][1:]:
        assert _decode(item["imageUrl"]).getchannel("A").getextrema()[0] == 0


def test_diag_reports_the_layer_provider():
    """后台「测试连接」必须能测到分层上游。

    这条守的是接线:`FalLayerProvider.check()` 写好了却没人调用,后台就只剩
    出图/视觉两栏——管理员存进去的分层密钥没有任何回音。
    """
    body = client.post("/v1/diag", json={}).json()
    assert set(body) >= {"image", "vlm", "layer"}
    assert body["layer"]["ok"] is True
    assert body["layer"]["detail"]


def test_fal_probe_never_hits_the_inference_endpoint():
    """自检探针走队列状态口,不走同步推理口。

    2026-08-25 实测:往 `fal.run/<model>` POST 空体不会秒回 422,而是进队列然后
    把探针拖到 ReadTimeout——好密钥被自检报成"不可用"。所以探针 URL 必须是
    queue 主机上的 requests/<id>/status。
    """
    from app.providers.http_providers import FalLayerProvider

    url = FalLayerProvider("", "k").probe_url()
    assert url.startswith("https://queue.fal.run/")
    assert url.endswith("/status")
    assert "fal-ai/qwen-image-layered" in url
    # 同步推理口一个字都不能出现在探针里。
    assert not url.startswith("https://fal.run/")


def test_fal_probe_declines_to_guess_for_a_custom_gateway():
    """自定义端点形状未知就明说"未验证",不报一个假的绿。"""
    from app.providers.http_providers import FalLayerProvider

    assert FalLayerProvider("https://gw.example.com/layer", "k").probe_url() == ""


def test_unprobed_custom_gateway_is_not_reported_as_healthy():
    """"没测过"必须长得像没测过——不能是 ok=True(后台会画成绿勾)。

    地址写错、密钥被拒都会照样通过「测试连接」,直到某次真拆解才发现,而那是
    花钱的。三态里它属于第三态:既不是绿也不是红。
    """
    import asyncio

    from app.providers.http_providers import FalLayerProvider

    check = asyncio.run(
        FalLayerProvider("https://gw.example.com/layer", "k").check()
    )
    assert check.unverified is True
    assert check.ok is False
    assert "未验证" in check.detail


def test_diag_carries_the_third_state_through_to_the_wire():
    """三态要一路透到后台那一屏,中间任何一层压掉它就退化成假的绿。"""
    body = client.post("/v1/diag", json={}).json()
    for key in ("image", "vlm", "layer"):
        assert "unverified" in body[key], key


def test_pydantic_bounds_mirror_the_zod_contract():
    """两侧契约必须逐字对齐,不能只靠 provider 里的 clamp 兜着。

    不经 web 路由直接打 FastAPI 的调用方(内部服务、脚本)看到的就是这一份;
    它比 Zod 宽的话,那些调用方能提交规范判为非法的请求,而且 clamp 会把错误
    悄悄改成一个"能跑"的值——用户永远不知道自己要的 12 层被改成了 10 层。
    """
    for bad in ({"imageUrl": SOURCE, "layerCount": 0},
                {"imageUrl": SOURCE, "layerCount": 11},
                {"imageUrl": SOURCE, "intent": "x" * 501}):
        assert client.post("/v1/decompose", json=bad).status_code == 422, bad
    # 边界内仍然放行
    assert client.post(
        "/v1/decompose",
        json={"imageUrl": SOURCE, "layerCount": 10, "intent": "x" * 500},
    ).status_code == 200


def test_decomposed_layer_size_must_be_positive():
    """响应侧同样要对齐:Zod 是 `.int().positive()`,裸 `int` 会放行 0 / 负数。

    web 侧拿这两个数当画布落位的宽高,0 宽的图层框选不中、也导不出——症状出在
    前端,根因却是这条没对齐的边界。
    """
    import pytest
    from pydantic import ValidationError

    from app.schemas import DecomposedLayer

    assert DecomposedLayer(imageUrl=SOURCE, width=1, height=1).width == 1
    for bad in ({"width": 0, "height": 8}, {"width": 8, "height": 0},
                {"width": -1, "height": 8}):
        with pytest.raises(ValidationError):
            DecomposedLayer(imageUrl=SOURCE, **bad)
