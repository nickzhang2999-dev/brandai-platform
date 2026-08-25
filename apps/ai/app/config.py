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
    # ("openai/gpt-image-2", "openai/gpt-4o"); OpenAI direct takes the bare id
    # ("gpt-image-2", "gpt-4o"). 铁律：图像模型固定 gpt-image-2（写死默认），
    # 仍可被 IMAGE_MODEL env / AppSetting 覆盖为兼容网关的命名空间 id；empty
    # vlm_model → "gpt-4o"。
    image_model: str = os.getenv("IMAGE_MODEL", "gpt-image-2")
    vlm_model: str = os.getenv("VLM_MODEL", "")
    # 图层分解上游。与 image/vlm 分开配置：fal 的 qwen-image-layered 是原生协议，
    # 和 OpenAI 的 /images/generations 形状毫无共同点，塞进同一组配置只会让
    # 每个调用方都得先判断"这半边适用吗"。未配密钥 → mock（零 key 可跑）。
    layer_provider: str = os.getenv("LAYER_PROVIDER", "mock")
    layer_api_key: str = os.getenv("LAYER_PROVIDER_API_KEY", "")
    layer_base_url: str = os.getenv("LAYER_PROVIDER_BASE_URL", "")
    layer_model: str = os.getenv("LAYER_MODEL", "")
    # Image models (gpt-image-1/2) take ~70-150s; measured gpt-image-2 ≈ 70s.
    # Floor the timeout at 180s so a low compose/env value (the contract pins 60)
    # can't cause spurious ReadTimeouts; a higher env value still wins.
    http_timeout: float = max(
        180.0, float(os.getenv("AI_HTTP_TIMEOUT_SECONDS", "180"))
    )
    max_retries: int = int(os.getenv("AI_MAX_RETRIES", "2"))


settings = Settings()
