"""Private Studio recovery with optional persistent Linux storage. A lookup never invokes a provider."""
import ctypes
import hashlib
import os
import re
from functools import lru_cache

from fastapi import HTTPException, Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import Response

NO_STORE = {"Cache-Control": "no-store"}


@lru_cache(maxsize=1)
def _library():
    path = os.environ.get("DEEPFLARE_NATIVE_IMAGE_RECEIPTS")
    if not path:
        return None
    native = ctypes.CDLL(path)
    native.receipt_reserve.argtypes = [ctypes.c_char_p]
    native.receipt_finish.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t]
    native.receipt_forget.argtypes = [ctypes.c_char_p]
    native.receipt_forget.restype = None
    native.receipt_read.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t]
    native.receipt_read.restype = ctypes.c_ssize_t
    return native


def _key(request: Request):
    request_id = request.headers.get("X-Novart-Request-Id", "")
    secret = request.headers.get("X-Novart-Recovery-Key", "")
    if re.fullmatch(r"sgr_[0-9a-f]{32}", request_id) and re.fullmatch(r"[0-9a-f]{64}", secret):
        return hashlib.sha256(f"{request_id}:{secret}".encode("ascii")).digest()
    return None


def initialize_receipts():
    if os.environ.get("DEEPFLARE_IMAGE_RECEIPT_DIR"):
        native = _library()
        if not native or not native.receipt_volume_ready():
            raise RuntimeError("Studio image receipt volume is unavailable or lacks owner-only permissions")


def receipt_revision():
    try:
        return "studio-private-image-receipt-r1" if _library() else None
    except (OSError, AttributeError):
        return None


async def run_with_receipt(request: Request, operation):
    key = _key(request) if request is not None else None
    native = _library() if key else None
    if not native:
        return await operation()
    reserved = await run_in_threadpool(native.receipt_reserve, key)
    if reserved != 1:
        raise HTTPException(status_code=409 if reserved == 0 else 503,
                            detail="Image request already reserved or receipt capacity unavailable")
    try:
        result = await operation()
        # The two routes return a validated GenerateResponse. The same bytes go
        # to both transports, including image-tool metadata and the usage receipt.
        payload = result.model_dump_json(exclude_none=True).encode("utf-8")
        if not await run_in_threadpool(native.receipt_finish, key, payload, len(payload)):
            await run_in_threadpool(native.receipt_forget, key)
        return Response(content=payload, media_type="application/json", headers=NO_STORE)
    except BaseException:
        await run_in_threadpool(native.receipt_forget, key)
        raise


def read_receipt(request: Request):
    key = _key(request)
    native = _library() if key else None
    size = native.receipt_read(key, None, 0) if native else -1
    if size == -2:
        return Response(status_code=202, headers=NO_STORE)
    if size > 0:
        buf = ctypes.create_string_buffer(size)
        if native.receipt_read(key, buf, size) == size:
            return Response(content=buf.raw, media_type="application/json", headers=NO_STORE)
    return Response(status_code=404, headers=NO_STORE)
