"""Image tools use the existing single-attempt image-edit adapter.

The worker owns source authorization, quota, persistence and recovery. This
module never fetches a browser URL and never returns a fake transparent image.
"""
import base64
import io
import math
from fastapi import HTTPException
from PIL import Image
from .providers.http_providers import HttpImageProvider, _is_gpt_image_2_model, _resolve_openai_size
from .providers.retry_policy import call_with_retry_policy
from .schemas import GenerateResponse, GeneratedVersion
from .studio_edit_schemas import StudioEditRequest, studio_data_bytes, STUDIO_EDIT_MAX_BYTES
from .studio_image_tool_schemas import STUDIO_IMAGE_TOOL_MAX_PIXELS


def _image(body: bytes, *, png=False):
    try:
        image = Image.open(io.BytesIO(body))
        width, height = image.size
        if image.format not in (("PNG",) if png else ("PNG", "JPEG", "WEBP")) or getattr(image, "n_frames", 1) != 1 or width * height > STUDIO_IMAGE_TOOL_MAX_PIXELS or min(width, height) < 1 or max(width, height) > 8192:
            raise ValueError("Unsupported static image")
        image.load()
        return image
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
        raise HTTPException(422, "Image tool input is invalid or exceeds limits") from error


def image_tool_provider_size(width: int, height: int, model: str) -> tuple[int, int]:
    # The final file keeps the source pixels. Provider resolution is recorded
    # separately; unsupported source dimensions are fitted without silent claims.
    factor = max(1.0, math.sqrt(655_360 / (width * height)))
    factor = min(factor, math.sqrt(8_294_400 / (width * height)), 3840 / max(width, height))
    w, h = max(16, math.ceil(width * factor / 16) * 16), max(16, math.ceil(height * factor / 16) * 16)
    while w * h > 8_294_400 or max(w, h) > 3840:
        if w >= h: w -= 16
        else: h -= 16
    _resolve_openai_size(w, h, model)
    return w, h


def prepare_studio_image_tool(req: StudioEditRequest, provider):
    if not req.imageTool or not isinstance(provider, HttpImageProvider) or not provider.api_key.strip() or not _is_gpt_image_2_model(provider.model):
        raise HTTPException(422, "Real image tool provider unavailable; no fallback image is generated")
    constraints = req.generation.aiConstraints
    if constraints and constraints.hardBlocks:
        raise HTTPException(422, "Brand policy blocks this image tool")
    source = _image(studio_data_bytes(req.imageUrl))
    if source.size != (req.generation.targets[0].width, req.generation.targets[0].height):
        raise HTTPException(422, "Image tools require the frozen source's actual pixel dimensions")
    mask = None
    if req.imageTool.mask:
        mask = _image(base64.b64decode(req.imageTool.mask.split(",", 1)[1], validate=True), png=True)
        if mask.size != source.size or ("A" in mask.getbands() and mask.getchannel("A").getextrema() != (255, 255)):
            raise HTTPException(422, "Mask pixels and opaque coverage must match the source")
        gray = mask.convert("L")
        if gray.getextrema()[1] <= 128:
            raise HTTPException(422, "The mask contains no white edit region")
        mask = gray.point(lambda value: 255 if value > 128 else 0)
    provider_size = image_tool_provider_size(*source.size, provider.model)
    return source, mask, provider_size


async def run_studio_image_tool(req: StudioEditRequest, provider) -> GenerateResponse:
    source, mask, provider_size = prepare_studio_image_tool(req, provider)
    tool = req.imageTool.operation
    payload = {"prompt": req.generation.sellingPoint, "width": provider_size[0], "height": provider_size[1],
               "studioImageTool": tool, "output_format": "png"}
    if tool == "remove-background":
        payload["background"] = "transparent"
    else:
        payload["mask"] = req.imageTool.mask
    ref = await call_with_retry_policy("never", provider.edit, req.imageUrl,
                                      "REMOVE_BACKGROUND" if tool == "remove-background" else "INPAINT", payload)
    # Bounded data response only: no provider-returned URL may initiate SSRF.
    result = _image(studio_data_bytes(ref), png=True).convert("RGBA")
    provider_output = result.size
    if tool == "remove-background":
        extrema = result.getchannel("A").getextrema()
        if extrema[0] >= 255 or extrema[1] <= 0:
            raise HTTPException(422, "Background-removal provider did not return a real foreground with transparent pixels")
    if result.size != source.size:
        result = result.resize(source.size, Image.Resampling.LANCZOS)
    if mask is not None:
        # Server compositing preserves every unpainted decoded source pixel,
        # even if a provider edits outside its advertised mask.
        result = Image.composite(result, source.convert("RGBA"), mask)
    buffer = io.BytesIO(); result.save(buffer, format="PNG"); body = buffer.getvalue()
    if len(body) > STUDIO_EDIT_MAX_BYTES:
        raise HTTPException(422, "Image tool output exceeds the file budget")
    params = {"generationPath": "studio_image_tool", "imageTool": tool,
              "providerWidth": provider_output[0], "providerHeight": provider_output[1],
              "actualWidth": source.width, "actualHeight": source.height,
              "maskConvention": "white-edit-black-preserve" if mask is not None else None}
    return GenerateResponse(versions=[GeneratedVersion(imageUrl="data:image/png;base64," + base64.b64encode(body).decode(),
        width=source.width, height=source.height, params=params)])
