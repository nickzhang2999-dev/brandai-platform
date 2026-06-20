"""Provider selection by env. Defaults to mock so P0 runs with zero keys."""
from functools import lru_cache

from fastapi import Request

from ..config import settings
from .base import ImageProvider, VLMProvider
from .mock import MockImageProvider, MockVLMProvider

# HttpImageProvider / HttpVLMProvider 只会 OpenAI 形状的 /images/generations 与
# /chat/completions,所以这里的默认端点必须是 OpenAI 兼容网关地址。Gemini 走
# Google 文档化的 OpenAI 兼容层 (/v1beta/openai),而非原生 /v1beta(后者形状不匹配
# 会 404)。需要原生协议的厂商请在 *_BASE_URL 显式覆盖。
_IMAGE_ENDPOINTS = {
    "openai": "https://api.openai.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "seeddream": "https://ark.cn-beijing.volces.com/api/v3",
}


@lru_cache
def get_image_provider() -> ImageProvider:
    name = settings.image_provider.lower()
    if name == "mock" or not settings.image_api_key:
        return MockImageProvider()
    from .http_providers import HttpImageProvider

    base_url = settings.image_base_url or _IMAGE_ENDPOINTS.get(
        name, _IMAGE_ENDPOINTS["openai"]
    )
    return HttpImageProvider(
        base_url, settings.image_api_key, model=settings.image_model
    )


@lru_cache
def get_vlm_provider() -> VLMProvider:
    name = settings.vlm_provider.lower()
    if name == "mock" or not settings.vlm_api_key:
        return MockVLMProvider()
    from .http_providers import HttpVLMProvider

    base_url = settings.vlm_base_url or _IMAGE_ENDPOINTS.get(
        name, _IMAGE_ENDPOINTS["openai"]
    )
    return HttpVLMProvider(
        base_url, settings.vlm_api_key, model=settings.vlm_model
    )


def resolve_image_provider(request: Request) -> ImageProvider:
    """Per-request image provider from X-OV-Image-* headers; else env fallback."""
    h = request.headers
    provider = (h.get("X-OV-Image-Provider") or "").strip()
    key = (h.get("X-OV-Image-Key") or "").strip()
    if not key or not provider or provider.lower() == "mock":
        return get_image_provider()
    from .http_providers import HttpImageProvider

    base_url = (h.get("X-OV-Image-Base-Url") or "").strip() or _IMAGE_ENDPOINTS.get(
        provider.lower(), _IMAGE_ENDPOINTS["openai"]
    )
    return HttpImageProvider(base_url, key, model=h.get("X-OV-Image-Model") or "")


def resolve_vlm_provider(request: Request) -> VLMProvider:
    """Per-request VLM provider from X-OV-Vlm-* headers; else env fallback."""
    h = request.headers
    provider = (h.get("X-OV-Vlm-Provider") or "").strip()
    key = (h.get("X-OV-Vlm-Key") or "").strip()
    if not key or not provider or provider.lower() == "mock":
        return get_vlm_provider()
    from .http_providers import HttpVLMProvider

    base_url = (h.get("X-OV-Vlm-Base-Url") or "").strip() or _IMAGE_ENDPOINTS.get(
        provider.lower(), _IMAGE_ENDPOINTS["openai"]
    )
    return HttpVLMProvider(base_url, key, model=h.get("X-OV-Vlm-Model") or "")
