"""Real FastAPI server with a deterministic, counted in-process image provider."""
import asyncio
import base64
import hashlib
import io
import os
import socket
import sys
from pathlib import Path

import threading

import uvicorn
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "ai"))
from app.main import app, resolve_image_provider, resolve_vlm_provider
from app.providers.mock import MockVLMProvider
from app.providers.http_providers import HttpImageProvider
from app.studio_image_receipts import _library

if not os.environ.get("DEEPFLARE_NATIVE_IMAGE_RECEIPTS") or _library() is None:
    raise RuntimeError("Build and specify the native image receipt library first")


class FixtureImageProvider(HttpImageProvider):
    count = 0
    digest = None

    def __init__(self):
        super().__init__("http://127.0.0.1:1", "local-fixture", "gpt-image-2")
        self.kind = "openai"

    async def generate_with_references(self, prompt, references, *, width, height, n, **kwargs):
        assert len(references) == 1 and references[0]["url"].startswith("data:image/png;base64,")
        return await self.generate(prompt, width=width, height=height, n=n)

    async def generate(self, prompt, *, width, height, n, **kwargs):
        assert n == 1
        self.count += 1
        if os.environ.get("DF_FIXTURE_HOLD_PROVIDER") == "1":
            await asyncio.Event().wait()
        out = io.BytesIO()
        Image.new("RGB", (width, height), (17, 33, 209)).save(out, format="PNG")
        data = out.getvalue()
        self.digest = hashlib.sha256(data).hexdigest()
        return ["data:image/png;base64," + base64.b64encode(data).decode("ascii")]


provider = FixtureImageProvider()
app.dependency_overrides[resolve_image_provider] = lambda: provider
app.dependency_overrides[resolve_vlm_provider] = lambda: MockVLMProvider()


@app.get("/fixture/stats")
def stats():
    return {"count": provider.count, "sha256": provider.digest}


if "--crash-pipe" in sys.argv:
    def crash_on_command():
        if sys.stdin.buffer.readline().strip() == b"stop":
            os._exit(86)
    threading.Thread(target=crash_on_command, daemon=True).start()

with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    print(listener.getsockname()[1], flush=True)
    uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False)).run(sockets=[listener])
