"""Image tools use the existing single-attempt image-edit adapter.

The worker owns source authorization, quota, persistence and recovery. This
module never fetches a browser URL and never returns a fake transparent image.
"""
import base64
import io
import math
import hashlib
from fastapi import HTTPException
from PIL import Image
from .providers.http_providers import HttpImageProvider, _is_gpt_image_2_model, _resolve_openai_size
from .providers.retry_policy import call_with_retry_policy
from .schemas import GenerateResponse, GeneratedVersion
from .studio_edit_schemas import StudioEditRequest, studio_data_bytes, STUDIO_EDIT_MAX_BYTES
from .studio_image_tool_schemas import STUDIO_IMAGE_TOOL_MAX_PIXELS
from .ai_failure import ImageResponseError


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
    try:
        result = _image(studio_data_bytes(ref), png=True).convert("RGBA")
    except (HTTPException, ValueError) as error:
        raise ImageResponseError("Image tool returned invalid PNG bytes") from error
    provider_output = result.size
    # An edit may return the original frame or the requested aligned provider
    # frame. Use relative tolerance: an absolute one-pixel tolerance would
    # incorrectly admit e.g. a 2x2 square for a 96x64 source.
    def same_aspect(frame):
        w, h = frame
        left, right = result.width * h, result.height * w
        return abs(left - right) * 200 <= max(left, right)
    if not same_aspect(source.size) and not same_aspect(provider_size):
        raise ImageResponseError("Image tool returned a different aspect ratio")
    if result.width < min(source.width, provider_size[0]) or result.height < min(source.height, provider_size[1]):
        raise ImageResponseError("Image tool returned less than the accepted source or provider resolution")
    if tool == "remove-background":
        extrema = result.getchannel("A").getextrema()
        if extrema[0] != 0 or extrema[1] <= 0:
            raise ImageResponseError("Background-removal provider did not return a real foreground with transparent pixels")
    if result.size != source.size:
        result = result.resize(source.size, Image.Resampling.LANCZOS)
    if tool == "remove-background":
        # Resampling can erase a tiny/very faint foreground; validate the final
        # deliverable too, not only the provider's high-resolution response.
        low, high = result.getchannel("A").getextrema()
        if low != 0 or high <= 0:
            raise ImageResponseError("Background-removal output lost meaningful alpha after normalization")
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
    if mask is not None:
        histogram = mask.histogram()
        params.update({"sourcePixelProtection": "outside-mask", "protectedPixelCount": histogram[0],
                       "editedPixelCount": histogram[255], "independentQuality": "not-reviewed",
                       "maskSha256": hashlib.sha256(f"{source.width}x{source.height}:".encode() + mask.tobytes()).hexdigest()})
    return GenerateResponse(versions=[GeneratedVersion(imageUrl="data:image/png;base64," + base64.b64encode(body).decode(),
        width=source.width, height=source.height, params=params)])
