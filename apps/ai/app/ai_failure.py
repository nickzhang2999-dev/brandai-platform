"""Safe internal failure contract mirrored by contracts/ai-failure.ts."""
import logging
import re
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger("brandai.ai.failure")


class AiFailureInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: Literal["SOURCE_UNAVAILABLE", "PROVIDER_RATE_LIMITED", "PROVIDER_AUTH",
                  "PROVIDER_REQUEST_REJECTED", "PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT",
                  "PROVIDER_NETWORK", "PROVIDER_INVALID_RESPONSE", "AI_REQUEST_FAILED"]
    stage: Literal["source", "provider", "response", "unknown"]
    upstreamStatus: int | None = Field(default=None, ge=400, le=599)


class AiFailureResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schemaVersion: Literal[1] = 1
    error: AiFailureInfo


class ImageResponseError(ValueError):
    """No usable image after a provider response; carries no provider text."""


def failure_response(exc: Exception, request_id: str | None) -> tuple[int, dict]:
    stage = getattr(exc, "_novart_failure_stage", "unknown")
    if stage not in ("source", "provider", "response"):
        stage = "unknown"
    response = getattr(exc, "response", None)
    status = response.status_code if isinstance(response, httpx.Response) else None
    if status is not None and not 400 <= status <= 599:
        status = None
    code = "AI_REQUEST_FAILED"
    if stage == "source":
        code = "SOURCE_UNAVAILABLE"
    elif isinstance(exc, ImageResponseError):
        stage, code = "response", "PROVIDER_INVALID_RESPONSE"
    elif stage == "provider":
        if status == 429:
            code = "PROVIDER_RATE_LIMITED"
        elif status in (401, 403):
            code = "PROVIDER_AUTH"
        elif status is not None and status < 500:
            code = "PROVIDER_REQUEST_REJECTED"
        elif status is not None:
            code = "PROVIDER_UNAVAILABLE"
        elif isinstance(exc, httpx.TimeoutException):
            code = "PROVIDER_TIMEOUT"
        else:
            code = "PROVIDER_NETWORK"
    info = AiFailureInfo(code=code, stage=stage, upstreamStatus=status)
    safe_id = request_id if request_id and re.fullmatch(r"sgr_[a-f0-9]{32}", request_id) else "unavailable"
    # Format these allowlisted values into the message: default log formatters
    # discard `extra`. Never log exception text/body/URL/key/prompt or traceback.
    logger.warning("ai.failure request=%s code=%s stage=%s upstream=%s", safe_id, info.code, info.stage, info.upstreamStatus)
    return (504 if isinstance(exc, httpx.TimeoutException) else 502), AiFailureResponse(error=info).model_dump()
