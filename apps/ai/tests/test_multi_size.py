"""P2.0 — verify /v1/generate honours the new `targets` payload.

When `targets` is present the AI service ignores versionCount and the
sceneType default size, emitting exactly one image per target at its own
W×H and stamping targetKey/targetLabel into each version's params. When
absent, the legacy versionCount path is unchanged (covered elsewhere).
"""


def _payload(**overrides):
    base = {
        "sceneType": "ECOM_MAIN",  # default 1024x1024
        "sellingPoint": "低温慢萃",
        "scene": "门店",
        "brandRules": [],
        "versionCount": 4,  # MUST be ignored when targets present
    }
    base.update(overrides)
    return base


def test_generate_targets_emits_one_image_per_size(client):
    r = client.post(
        "/v1/generate",
        json=_payload(
            targets=[
                {"key": "ecom_main", "label": "电商主图", "width": 1024, "height": 1024},
                {"key": "banner", "label": "Banner", "width": 1920, "height": 1080},
            ]
        ),
    )
    assert r.status_code == 200
    versions = r.json()["versions"]
    # versionCount=4 ignored — exactly one image per target.
    assert len(versions) == 2
    by_key = {v["params"]["targetKey"]: v for v in versions}
    assert by_key["ecom_main"]["width"] == 1024
    assert by_key["ecom_main"]["height"] == 1024
    assert by_key["banner"]["width"] == 1920
    assert by_key["banner"]["height"] == 1080
    assert by_key["banner"]["params"]["targetLabel"] == "Banner"
    # Each produced size differs from the sceneType default where applicable.
    assert by_key["banner"]["width"] != by_key["banner"]["height"]


# --- K5: record the ACTUAL decoded image size (OpenAI snaps to its set) ---


def _png_data_url(w: int, h: int) -> str:
    import base64
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), (124, 92, 255)).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def test_probe_image_size_decodes_data_url():
    import asyncio

    from app.main import _probe_image_size

    out = asyncio.get_event_loop().run_until_complete(
        _probe_image_size(_png_data_url(640, 480))
    )
    assert out == (640, 480)


def test_probe_image_size_returns_none_on_undecodable():
    import asyncio

    from app.main import _probe_image_size

    # The mock provider emits an SVG data URL, which PIL can't decode → None,
    # so the requested width/height stay the only recorded dimensions.
    loop = asyncio.get_event_loop()
    assert loop.run_until_complete(_probe_image_size("data:image/svg+xml;base64,Zm9v")) is None
    assert loop.run_until_complete(_probe_image_size("not-a-url")) is None


def test_generate_mock_svg_keeps_requested_size_no_actual(client):
    """Mock returns SVG (undecodable) → actualWidth/Height omitted, no nulls."""
    from .conftest import find_nulls

    r = client.post(
        "/v1/generate",
        json=_payload(versionCount=1, targets=None),
    )
    assert r.status_code == 200
    body = r.json()
    v = body["versions"][0]
    assert (v["width"], v["height"]) == (1024, 1024)
    # SVG can't be probed → the field is omitted, never null.
    assert "actualWidth" not in v
    assert find_nulls(body) == []


def test_generate_targets_three_distinct_sizes_carry_target_keys(client):
    targets = [
        {"key": "xhs_cover", "label": "小红书封面", "width": 1080, "height": 1440},
        {"key": "detail", "label": "详情页", "width": 750, "height": 1000},
        {"key": "moments", "label": "朋友圈", "width": 1080, "height": 1080},
    ]
    r = client.post("/v1/generate", json=_payload(targets=targets))
    assert r.status_code == 200
    versions = r.json()["versions"]
    assert len(versions) == 3
    dims = {(v["width"], v["height"]) for v in versions}
    assert dims == {(1080, 1440), (750, 1000), (1080, 1080)}
    for v in versions:
        assert "targetKey" in v["params"]
        assert "targetLabel" in v["params"]
