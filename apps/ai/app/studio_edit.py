"""Preflight and prompt additions for product edit; no alternate provider path."""
import io
from typing import Any

from fastapi import HTTPException
from PIL import Image

from .providers.http_providers import HttpImageProvider, _is_gpt_image_2_model, _resolve_openai_size
from .studio_edit_schemas import StudioEditRequest, studio_data_bytes


def prepare_studio_edit(req: StudioEditRequest, provider: Any) -> None:
    constraints = req.generation.aiConstraints
    if constraints and constraints.hardBlocks:
        raise HTTPException(422, "Brand policy blocks this edit; no image service was called")
    model = (constraints.machineRules or {}).get("model") if constraints else None
    model = model or getattr(provider, "model", "")
    if not isinstance(provider, HttpImageProvider) or not provider.api_key.strip() or not isinstance(model, str) or not _is_gpt_image_2_model(model):
        raise HTTPException(422, "Whole-image edits require a real gpt-image-2 image-edit provider; no text-only fallback is supported")
    target = req.generation.targets[0]
    try:
        # Validate before reading inputs or starting an upstream POST. The same
        # adapter uses this literal size for multipart /images/edits.
        _resolve_openai_size(target.width, target.height, model)
        images = [req.imageUrl, *(ref.url for ref in constraints.referenceImages)] if constraints else [req.imageUrl]
        pixels = 0
        for source in images:
            body = studio_data_bytes(source)
            with Image.open(io.BytesIO(body)) as image:
                mime = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}.get(image.format)
                if not mime or not source.startswith(f"data:image/{mime};base64,") or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Only genuine static PNG/JPEG/WebP images are supported")
                width, height = image.size
                pixels += width * height
                if min(width, height) < 1 or max(width, height) > 16384 or pixels > 40_000_000:
                    raise ValueError("Combined input image pixels exceed the processing limit")
                image.verify()
            with Image.open(io.BytesIO(body)) as image:
                image.load()  # Reject truncated data that passes header checks.
    except (ValueError, OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise HTTPException(422, "Edit size or image inputs are invalid or exceed supported limits; no image service was called") from error


def studio_edit_instructions(references: list[dict[str, Any]]) -> list[str]:
    parts = [
        "WHOLE-IMAGE EDIT: input image #1 is the source image to modify. Apply the user's requested changes to that image; keep unrelated content and layout recognizable. Do not invent a replacement scene from scratch.",
        "All other inputs are references with the roles below, not extra edit targets. Follow brand constraints and negative examples before creative choices.",
    ]
    for index, ref in enumerate(references, 2):
        note = str(ref.get("note") or "")
        if ref.get("polarity") == "negative":
            role = "NEGATIVE example: do NOT copy or resemble its prohibited treatment"
        elif note.startswith("BRAND_LOGO_LOCKED:"):
            role = "authoritative BRAND LOGO: use identity/palette context, reserve upper-left logo space; do not redraw a mark because server composition adds the original logo"
        elif note.startswith("ASSET_USAGE:ADAPTIVE:"):
            role = "ADAPTIVE subject: preserve recognizable identity while harmonizing its treatment"
        elif note.startswith("ASSET_USAGE:REFERENCE:") or ref.get("mode") != "STRICT":
            role = "REFERENCE inspiration: borrow style, palette or composition; do not copy its subject as mandatory content"
        else:
            role = "explicit image reference: honor the supplied instruction while preserving its recognizable subject"
        parts.append(f"Input image #{index}: {role}." + (f" Reference instruction: {note}" if note else ""))
    return parts


def studio_edit_params(extra: dict[str, Any] | None) -> dict[str, Any]:
    # Web owns the durable audit. Returning raw reference data twice can exceed
    # the bounded response and must never disclose private source bytes in echo.
    allowed = {"quality", "targetKey", "targetLabel", "requestedWidth", "requestedHeight", "ratioKey", "resolutionTier", "requestedRatio", "actualWidth", "actualHeight"}
    return {"generationPath": "studio_whole_image_edit", **{key: value for key, value in (extra or {}).items() if key in allowed}}
