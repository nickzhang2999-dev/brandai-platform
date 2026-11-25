"""Exercise the real model-service routes across SIGKILL on one private Linux volume."""
import hashlib
import os
from pathlib import Path
import secrets
import select
import stat
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import httpx
import pytest

pytestmark = pytest.mark.skipif(sys.platform != "linux" or not os.getenv("DEEPFLARE_NATIVE_IMAGE_RECEIPTS"),
                                reason="requires the Linux native receipt library")
FIXTURE = Path(__file__).resolve().parents[2] / "web/tests/fixtures/studio-receipt-http.py"
BODY = dict(sceneType="ECOM_MAIN", sellingPoint="test", scene="test", brandRules=[], versionCount=1)
RECEIPT = "/v1/studio/image-receipt"


@contextmanager
def model_process(directory, hold_provider=False):
    env = dict(os.environ, DEEPFLARE_IMAGE_RECEIPT_DIR=str(directory), DF_FIXTURE_HOLD_PROVIDER=str(int(hold_provider)))
    with subprocess.Popen([sys.executable, str(FIXTURE)], stdout=subprocess.PIPE, env=env, text=True) as proc:
        try:
            assert select.select([proc.stdout], [], [], 25)[0], "model service startup timed out"
            port = int(proc.stdout.readline())
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False) as client:
                for _ in range(150):
                    if proc.poll() is not None:
                        pytest.fail("model process exited during startup")
                    try:
                        if client.get("/health", timeout=.5).is_success:
                            break
                    except httpx.TransportError:
                        pass
                    time.sleep(.05)
                else:
                    pytest.fail("model service did not become ready")
                yield client, proc.pid
        finally:
            proc.kill()
            proc.wait(timeout=10)


def test_ready_survives_kill_on_same_volume_and_never_redispatches(tmp_path):
    directory = tmp_path / "receipts"
    request_id = "sgr_" + secrets.token_hex(16)
    secret = secrets.token_hex(32)
    headers = {"X-Novart-Request-Id": request_id, "X-Novart-Recovery-Key": secret}
    with model_process(directory) as (first, first_pid):
        response = first.post("/v1/generate", headers=headers, json=BODY)
        assert response.status_code == 200
        assert response.json()["versions"][0]["imageUrl"].startswith("data:image/png;base64,")
        assert first.get("/fixture/stats").json()["count"] == 1
    key = hashlib.sha256(f"{request_id}:{secret}".encode()).hexdigest()
    assert stat.S_IMODE((directory / key).stat().st_mode) == 0o600
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    with model_process(directory) as (second, second_pid):
        assert first_pid != second_pid
        for _ in range(2):
            recovered = second.get(RECEIPT, headers=headers)
            assert recovered.status_code == 200 and recovered.content == response.content
            assert recovered.headers["cache-control"] == "no-store"
        assert second.get(RECEIPT, headers={**headers, "X-Novart-Recovery-Key": secrets.token_hex(32)}).status_code == 404
        assert second.get(RECEIPT, headers={**headers, "X-Novart-Request-Id": "sgr_" + secrets.token_hex(16)}).status_code == 404
        assert second.post("/v1/generate", headers=headers, json=BODY).status_code == 409
        assert second.get("/fixture/stats").json()["count"] == 0
    with model_process(tmp_path / "another-volume") as (third, _):
        assert third.get(RECEIPT, headers=headers).status_code == 404
        assert third.get("/fixture/stats").json()["count"] == 0

def test_inflight_kill_preserves_reservation_without_a_second_provider_call(tmp_path):
    directory = tmp_path / "receipts"
    headers = {"X-Novart-Request-Id": "sgr_" + secrets.token_hex(16),
               "X-Novart-Recovery-Key": secrets.token_hex(32)}
    with ThreadPoolExecutor(max_workers=1) as pool:
        with model_process(directory, hold_provider=True) as (first, _):
            active = pool.submit(httpx.post, first.base_url.join("/v1/generate"),
                                 headers=headers, json=BODY, timeout=20, trust_env=False)
            for _ in range(100):
                if first.get("/fixture/stats").json()["count"] == 1:
                    break
                time.sleep(.03)
            else:
                pytest.fail("provider did not start")
            assert first.get(RECEIPT, headers=headers).status_code == 202
        with pytest.raises(httpx.TransportError):
            active.result(timeout=5)
    with model_process(directory) as (next_process, _):
        assert next_process.get(RECEIPT, headers=headers).status_code == 202
        assert next_process.post("/v1/generate", headers=headers, json=BODY).status_code == 409
        assert next_process.get("/fixture/stats").json()["count"] == 0
