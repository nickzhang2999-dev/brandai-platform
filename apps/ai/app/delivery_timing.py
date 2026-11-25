"""Correlate image HTTP calls without recording provider URLs, headers or content."""
import json
import os
import re
import time
from contextvars import ContextVar

import httpx

_request_id: ContextVar[str | None] = ContextVar("image_timing_request_id", default=None)


def _enabled():
    flag = os.getenv("DF_STUDIO_DELIVERY_TRACE")
    if flag is not None:
        return flag == "1"
    return os.getenv("VITE_GIT_BRANCH") == "review/p0-canvas-recovery" or os.getenv("BRANDAI_QUEUE_PREFIX") == "brandai-review-p0-canvas-recovery"


class ImageTimingScope:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (not _enabled() or scope["type"] != "http"
                or scope["path"] not in {"/v1/generate", "/v1/studio/edit"}):
            return await self.app(scope, receive, send)
        raw = dict(scope["headers"]).get(b"x-novart-request-id", b"")
        if not re.fullmatch(rb"sgr_[a-f0-9]{32}", raw):
            return await self.app(scope, receive, send)
        token = _request_id.set(raw.decode("ascii"))
        try:
            return await self.app(scope, receive, send)
        finally:
            _request_id.reset(token)


class _TimedImageClient(httpx.AsyncClient):
    async def send(self, request, **kwargs):
        ident = _request_id.get()
        if not ident or request.method != "POST":
            return await super().send(request, **kwargs)
        start = time.perf_counter()
        def emit(stage, **extra):
            try:
                print("[studio-delivery]", json.dumps(dict(stage=stage, at=time.time_ns() // 1000000,
                      requestId=ident, **extra)), flush=True)
            except OSError:
                pass  # Telemetry must never trigger another provider request.
        emit("provider_http_start")
        try:
            response = await super().send(request, **kwargs)
        except BaseException:
            emit("provider_http_interrupted", durationMs=round(1000 * (time.perf_counter() - start)))
            raise
        emit("provider_http_return", status=response.status_code, durationMs=round(1000 * (time.perf_counter() - start)))
        return response


def image_http_client(**options):
    return (_TimedImageClient if _request_id.get() else httpx.AsyncClient)(**options)
