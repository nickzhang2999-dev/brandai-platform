import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    image_provider: str = os.getenv("IMAGE_PROVIDER", "mock")
    vlm_provider: str = os.getenv("VLM_PROVIDER", "mock")
    image_api_key: str = os.getenv("IMAGE_PROVIDER_API_KEY", "")
    vlm_api_key: str = os.getenv("VLM_PROVIDER_API_KEY", "")
    # Optional explicit endpoints for OpenAI-compatible gateways (OpenRouter,
    # one-api relays, self-hosted vLLM). Empty → fall back to the built-in
    # endpoint table keyed by provider name (registry._IMAGE_ENDPOINTS).
    image_base_url: str = os.getenv("IMAGE_PROVIDER_BASE_URL", "")
    vlm_base_url: str = os.getenv("VLM_PROVIDER_BASE_URL", "")
    # Model ids. Gateways like OpenRouter require a namespaced id
    # ("openai/gpt-image-1", "openai/gpt-4o"); OpenAI direct takes the bare id
    # ("gpt-image-1", "gpt-4o"). Empty image_model → upstream default; empty
    # vlm_model → "gpt-4o".
    image_model: str = os.getenv("IMAGE_MODEL", "")
    vlm_model: str = os.getenv("VLM_MODEL", "")
    # Image models (gpt-image-1/2) take ~70-150s; measured gpt-image-2 ≈ 70s.
    # Floor the timeout at 180s so a low compose/env value (the contract pins 60)
    # can't cause spurious ReadTimeouts; a higher env value still wins.
    http_timeout: float = max(
        180.0, float(os.getenv("AI_HTTP_TIMEOUT_SECONDS", "180"))
    )
    max_retries: int = int(os.getenv("AI_MAX_RETRIES", "2"))


settings = Settings()
