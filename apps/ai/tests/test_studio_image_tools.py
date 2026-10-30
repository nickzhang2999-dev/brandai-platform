"""Actual PNG/mask decoding and adapter requests with isolated HTTP fixtures.
These tests make zero real provider calls and do not establish image quality.
"""
import base64
import io
from email.parser import BytesParser
from email.policy import default
import httpx
import pytest
from PIL import Image
from pydantic import ValidationError
from fastapi import HTTPException
from app.providers.http_providers import HttpImageProvider
from app.providers.mock import MockImageProvider
from app.studio_edit_schemas import StudioEditRequest
from app.studio_image_tool_schemas import StudioImageToolSpec
from app.studio_image_tools import run_studio_image_tool, prepare_studio_image_tool, image_tool_provider_size
from app.ai_failure import ImageResponseError

def data(image):
    output = io.BytesIO(); image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()

def request(operation="remove-background", mask=None):
    source = Image.new("RGBA", (96, 64), (18, 31, 64, 255))
    body = {"imageUrl": data(source), "imageTool": {"operation": operation}, "generation": {
        "sceneType": "SOCIAL_POSTER", "sellingPoint": "preserve subject", "scene": "", "brandRules": [],
        "versionCount": 1, "providerRetryPolicy": "never", "targets": [{"key": "source", "label": "Source", "width": 96, "height": 64}],
        "aiConstraints": {"referenceImages": [], "hardBlocks": []}}}
    if mask is not None: body["imageTool"]["mask"] = mask
    return StudioEditRequest.model_validate(body)

def parts(request):
    message = BytesParser(policy=default).parsebytes(b"Content-Type: " + request.headers["content-type"].encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + request.content)
    return {part.get_param("name", header="content-disposition"): part.get_payload(decode=True) for part in message.iter_parts()}

def provider(image=None, failure=None, calls=None):
    calls = calls if calls is not None else []
    def upstream(req):
        calls.append(req)
        if failure: return httpx.Response(failure, json={"error": "isolated upstream failure"})
        return httpx.Response(200, json={"data": [{"b64_json": data(image).split(",")[1]}]})
    return HttpImageProvider("https://unit-gateway.invalid/v1", "synthetic-fixture-key", "gpt-image-2", transport=httpx.MockTransport(upstream))

@pytest.mark.asyncio
async def test_transparent_png_uses_existing_single_edit_adapter_and_preserves_file_size():
    output = Image.new("RGBA", (96, 64), (0, 0, 0, 0)); output.paste((22, 88, 155, 255), (20, 10, 70, 55))
    calls = []; response = await run_studio_image_tool(request(), provider(output, calls=calls))
    assert len(calls) == 1
    form = parts(calls[0]); assert form["background"] == b"transparent" and form["output_format"] == b"png" and form["n"] == b"1"
    assert form["image"] == base64.b64decode(request().imageUrl.split(",")[1])
    assert response.versions[0].width == 96 and response.versions[0].height == 64
    decoded = Image.open(io.BytesIO(base64.b64decode(response.versions[0].imageUrl.split(",")[1])))
    assert decoded.mode == "RGBA" and decoded.getchannel("A").getextrema() == (0, 255)

@pytest.mark.asyncio
@pytest.mark.parametrize("rgba", [(255,255,255,255), (0,0,0,0), (20,40,60,128)])
async def test_opaque_white_and_lost_foreground_are_rejected(rgba):
    calls = []
    with pytest.raises(ImageResponseError):
        await run_studio_image_tool(request(), provider(Image.new("RGBA", (96,64), rgba), calls=calls))
    assert len(calls) == 1

@pytest.mark.asyncio
async def test_inpaint_white_area_changes_black_area_keeps_every_source_pixel():
    mask = Image.new("RGB", (96,64), "black"); mask.paste("white", (20,10,40,30)); calls = []
    response = await run_studio_image_tool(request("inpaint", data(mask)), provider(Image.new("RGBA", (96,64), (200,0,100,255)), calls=calls))
    out = Image.open(io.BytesIO(base64.b64decode(response.versions[0].imageUrl.split(",")[1]))).convert("RGBA")
    for y in range(64):
        for x in range(96):
            assert out.getpixel((x,y)) == ((200,0,100,255) if 20<=x<40 and 10<=y<30 else (18,31,64,255))
    assert response.versions[0].params["protectedPixelCount"] == 96 * 64 - 400
    assert response.versions[0].params["editedPixelCount"] == 400
    assert response.versions[0].params["independentQuality"] == "not-reviewed"
    assert len(response.versions[0].params["maskSha256"]) == 64
    form = parts(calls[0]); converted = Image.open(io.BytesIO(form["mask"])); assert converted.size == (96,64)
    assert converted.getpixel((25,15))[3] == 0 and converted.getpixel((0,0))[3] == 255

@pytest.mark.parametrize("mask", [Image.new("RGB", (95,64), "white"), Image.new("RGB", (96,64), "black"), Image.new("RGBA", (96,64), (255,255,255,0))])
def test_invalid_mask_dimensions_empty_region_or_alpha_fail_before_upstream(mask):
    calls = []
    with pytest.raises(HTTPException): prepare_studio_image_tool(request("inpaint", data(mask)), provider(calls=calls))
    assert calls == []

def test_mock_provider_fails_before_any_fallback():
    with pytest.raises(HTTPException): prepare_studio_image_tool(request(), MockImageProvider())

@pytest.mark.parametrize("value", [{"operation":"inpaint"}, {"operation":"remove-background","mask":"data:image/png;base64,AAAA"}, {"operation":"remove-background","mask":None}, {"operation":"inpaint","mask":"https://unit.invalid/a.png"}])
def test_mirror_rejects_missing_extra_null_and_remote_masks(value):
    with pytest.raises(ValidationError): StudioImageToolSpec.model_validate(value)

@pytest.mark.asyncio
async def test_failed_provider_request_is_not_retried():
    calls=[]
    with pytest.raises(httpx.HTTPStatusError): await run_studio_image_tool(request(), provider(failure=503,calls=calls))
    assert len(calls)==1

@pytest.mark.parametrize("size", [(96,64),(4096,4096),(32,96),(1080,1920)])
def test_provider_size_is_valid_and_distinct_from_final_source_size(size):
    w,h=image_tool_provider_size(*size,"gpt-image-2")
    assert w%16==h%16==0 and 655360<=w*h<=8294400 and max(w,h)<=3840 and max(w,h)/min(w,h)<=3

@pytest.mark.asyncio
@pytest.mark.parametrize("dimensions", [(96,96), (2,2)])
async def test_wrong_aspect_is_rejected_instead_of_stretching_mask_content(dimensions):
    calls = []
    mask = Image.new("L", (96, 64), 255)
    with pytest.raises(ImageResponseError, match="aspect ratio"):
        await run_studio_image_tool(request("inpaint", data(mask)), provider(Image.new("RGBA", dimensions, "green"), calls=calls))
    assert len(calls) == 1

@pytest.mark.asyncio
async def test_matching_ratio_thumbnail_cannot_be_upscaled_into_an_accepted_edit():
    calls = []
    with pytest.raises(ImageResponseError, match="resolution"):
        await run_studio_image_tool(request("inpaint", data(Image.new("L", (96,64), 255))),
                                    provider(Image.new("RGBA", (3,2), "green"), calls=calls))
    assert len(calls) == 1

@pytest.mark.asyncio
@pytest.mark.parametrize("dimensions", [(192,128), image_tool_provider_size(96,64,"gpt-image-2")])
async def test_source_ratio_or_requested_aligned_frame_can_be_normalized(dimensions):
    mask = Image.new("L", (96, 64), 0); mask.paste(255, (20,10,40,30))
    result = await run_studio_image_tool(request("inpaint", data(mask)), provider(Image.new("RGBA", dimensions, (200,0,100,255))))
    out = Image.open(io.BytesIO(base64.b64decode(result.versions[0].imageUrl.split(",")[1])))
    assert out.size == (96,64) and out.getpixel((0,0)) == (18,31,64,255)

@pytest.mark.asyncio
async def test_resampling_cannot_turn_a_tiny_alpha_layer_into_a_successful_empty_cutout():
    out = Image.new("RGBA", (1536,1024), (0,0,0,0)); out.putpixel((700,600),(255,0,0,1))
    with pytest.raises(ImageResponseError, match="after normalization"):
        await run_studio_image_tool(request(), provider(out))

@pytest.mark.parametrize("status,code", [(400,"PROVIDER_REQUEST_REJECTED"),(401,"PROVIDER_AUTH"),(403,"PROVIDER_AUTH"),(429,"PROVIDER_RATE_LIMITED"),(503,"PROVIDER_UNAVAILABLE")])
def test_real_edit_route_preserves_safe_provider_stage_without_retries(status,code,caplog):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.providers import resolve_image_provider
    calls=[]; old=app.dependency_overrides.copy()
    app.dependency_overrides[resolve_image_provider] = lambda: provider(failure=status,calls=calls)
    try:
        response = TestClient(app).post("/v1/studio/edit",json=request().model_dump(exclude_none=True))
        assert response.status_code == 502
        assert response.json()["error"] == {"code":code,"stage":"provider","upstreamStatus":status}
        assert len(calls) == 1
        assert "synthetic-fixture-key" not in response.text + caplog.text
        assert "isolated upstream failure" not in response.text + caplog.text
    finally:
        app.dependency_overrides.clear(); app.dependency_overrides.update(old)

def test_invalid_cutout_bytes_are_an_output_failure_not_invalid_user_input():
    from fastapi.testclient import TestClient
    from app.main import app
    from app.providers import resolve_image_provider
    old=app.dependency_overrides.copy()
    # An opaque provider response is not a true cutout.
    app.dependency_overrides[resolve_image_provider] = lambda: provider(Image.new("RGBA", (96,64), "white"))
    try:
        response=TestClient(app).post("/v1/studio/edit",json=request().model_dump(exclude_none=True))
        assert response.status_code == 502
        assert response.json()["error"]["code"] == "PROVIDER_INVALID_RESPONSE"
    finally:
        app.dependency_overrides.clear(); app.dependency_overrides.update(old)
